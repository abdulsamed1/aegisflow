-- aegisflow D1 schema (single source: docs/architecture.md section 3)
-- Note: clients table intentionally has NO status column; job status lives only in jobs
-- (PRD section 4: dual status flags are prohibited).

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
    family_name_at_birth_enc TEXT NOT NULL,
    place_of_birth TEXT NOT NULL,
    country_of_birth TEXT NOT NULL,
    nationality_at_birth TEXT NOT NULL,
    address_street_enc TEXT NOT NULL,
    address_postal_code_enc TEXT NOT NULL,
    address_city_enc TEXT NOT NULL,
    passport_issue_date TEXT NOT NULL,
    passport_issuing_country TEXT NOT NULL,
    category TEXT CHECK (category IN ('Bachelor', 'Master_PhD')) NOT NULL,
    calendar_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    enabled INTEGER DEFAULT 0, -- 0 = Paused, 1 = Enabled
    status TEXT CHECK (status IN (
        'DRAFT', 'VALIDATION_ERROR', 'READY', 'ACTIVE',
        'SEARCHING', 'BOOKING', 'BOOKED', 'BOOKING_FAILED',
        'TEMPORARY_ERROR', 'PORTAL_ERROR', 'CANCELLED', 'EXPIRED'
    )) DEFAULT 'DRAFT',
    start_date TEXT NOT NULL, -- legacy: written once with global constants, never read (D8/AD-11)
    end_date TEXT NOT NULL, -- legacy: written once with global constants, never read (D8/AD-11)
    allowed_days TEXT NOT NULL, -- legacy: JSON Array, all 7 days, never read (D8/AD-11)
    preferred_time_start TEXT DEFAULT '07:00', -- legacy: global window constant
    preferred_time_end TEXT DEFAULT '18:00', -- legacy: global window constant
    check_count INTEGER DEFAULT 0,
    last_check TIMESTAMP,
    last_error_code TEXT,
    backoff_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS daily_metrics (
    date TEXT PRIMARY KEY, -- YYYY-MM-DD
    total_checks INTEGER DEFAULT 0,
    total_browser_seconds REAL DEFAULT 0.0,
    slots_found INTEGER DEFAULT 0,
    bookings_completed INTEGER DEFAULT 0,
    budget_alert_sent INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_scheduler ON jobs(enabled, status, backoff_until, last_check);
CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_logs(job_id, created_at);
-- 2026-09-11 quota incident: dashboard polls /api/logs?limit=200 + /api/status
-- every 10s; without these, both ORDER BY created_at DESC LIMIT queries
-- full-scan audit_logs (measured 51,640 + 25,826 rows read per 10s tick
-- against 25,820 rows ≈670M rows/day per tab vs 5M free quota).
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_type_created ON audit_logs(event_type, created_at DESC);
