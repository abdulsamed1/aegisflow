# 3. Database Schema (Cloudflare D1)

```sql
-- Client Candidate Table
-- NOTE: no status column here — job status lives only in jobs (PRD section 4: dual status flags prohibited).
CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    first_name_enc TEXT NOT NULL,
    last_name_enc TEXT NOT NULL,
    gender TEXT CHECK (gender IN ('Male', 'Female')),
    dob TEXT NOT NULL,
    nationality TEXT NOT NULL,
    passport_number_enc TEXT NOT NULL,
    passport_expiry TEXT NOT NULL,
    email_enc TEXT NOT NULL,
    phone_enc TEXT NOT NULL,
    category TEXT CHECK (category IN ('Bachelor', 'Master_PhD')) NOT NULL,
    calendar_id INTEGER NOT NULL,
    place_of_birth TEXT,
    country_of_birth TEXT,
    nationality_at_birth TEXT,
    family_name_at_birth_enc TEXT,
    address_street_enc TEXT,
    address_postal_code_enc TEXT,
    address_city_enc TEXT,
    passport_issue_date TEXT,
    passport_issuing_country TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Client Job Lifecycle Table
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    enabled INTEGER DEFAULT 0, -- 0 = Paused, 1 = Enabled
    status TEXT CHECK (status IN (
        'DRAFT', 'VALIDATION_ERROR', 'READY', 'ACTIVE', 
        'SEARCHING', 'BOOKING', 'BOOKED', 'BOOKING_FAILED', 
        'TEMPORARY_ERROR', 'PORTAL_ERROR', 'CANCELLED', 'EXPIRED' -- EXPIRED: legacy since D8 (2026-08-20); no code path sets it, retained for table compatibility
    )) DEFAULT 'DRAFT',
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    allowed_days TEXT NOT NULL, -- JSON Array, all 7 days (legacy — written once, never read)
    preferred_time_start TEXT DEFAULT '07:00',
    preferred_time_end TEXT DEFAULT '18:00',
    -- NOTE (2026-08-20, D5/D8 + AD-11): the five columns above are LEGACY per-client
    -- rule columns. The scheduler never reads them; they are written once at job
    -- creation with global constants (window 07:00–18:00, all days, 8-week horizon)
    -- purely to satisfy the NOT NULL constraints of the deployed table.
    check_count INTEGER DEFAULT 0,
    last_check TIMESTAMP,
    last_error_code TEXT,
    backoff_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT REFERENCES jobs(id),
    client_id TEXT REFERENCES clients(id),
    event_type TEXT NOT NULL,
    duration_ms INTEGER,
    error_code TEXT,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Daily Execution Metrics Table
CREATE TABLE IF NOT EXISTS daily_metrics (
    date TEXT PRIMARY KEY, -- YYYY-MM-DD
    total_checks INTEGER DEFAULT 0,
    total_browser_seconds REAL DEFAULT 0.0,
    slots_found INTEGER DEFAULT 0,
    bookings_completed INTEGER DEFAULT 0,
    budget_alert_sent INTEGER DEFAULT 0
);

-- Indexes for Scheduler Performance
CREATE INDEX IF NOT EXISTS idx_jobs_scheduler ON jobs(enabled, status, backoff_until, last_check);
CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_logs(job_id, created_at);
-- 2026-09-11 quota incident: the dashboard polls /api/logs?limit=200 + /api/status every 10s,
-- both ORDER BY created_at DESC LIMIT. Without time-ordered indexes each tick full-scanned
-- audit_logs (measured 51,640 + 25,826 rows read over ~25,820 rows ≈670M rows/day per tab
-- vs the 5M free quota). Do not drop these without replacing the polling pattern.
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_type_created ON audit_logs(event_type, created_at DESC);
```

> **2026-08-20 (client deletion):** `audit_logs.client_id`/`job_id` have no `ON DELETE` action, and D1 enforces FKs — scheduler scan rows referencing a client would block `DELETE /api/clients/:id`. The DELETE route therefore nulls both columns for the client first (`UPDATE audit_logs SET client_id = NULL, job_id = NULL WHERE client_id = ?`), then writes `CLIENT_DELETED`, then deletes. The optional `ON DELETE SET NULL` migration is recorded in `Todo.md` (deferred-work list).

---
