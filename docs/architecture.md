# Technical Architecture Specification — BMEIA Appointment Automation (opran-booking)

> **Status:** FINAL  
> **Target Environment:** Cloudflare Workers Platform (Free Tier Compatible)  
> **Core Framework:** TypeScript, `@cloudflare/playwright`, Cloudflare D1, Cloudflare Durable Objects  

---

## 1. System Topology Architecture

```mermaid
flowchart TD
    subgraph Client Layer
        AdminUI[Admin Dashboard SPA / Static Assets]
        TGClient[Telegram Bot Client]
    end

    subgraph Cloudflare Edge Infrastructure
        Worker[Main Worker: HTTP API + Cron Trigger]
        DO[Durable Object: Job Lock & State Actor]
        D1[(Cloudflare D1: SQLite DB)]
        KV[(Cloudflare KV: Session Storage)]
        BrowserRun[Cloudflare Browser Run: Playwright]
    end

    subgraph External Systems
        BMEIA[BMEIA Portal: appointment.bmeia.gv.at]
        TelegramAPI[Telegram Bot API]
    end

    AdminUI -->|REST / JSON| Worker
    Worker -->|Read/Write PII & Logs| D1
    Worker -->|Acquire Lock & Check State| DO
    Worker -->|Store / Restore Cookies| KV
    Worker -->|POST Scanner ~270ms avg| BMEIA
    Worker -->|Launch Playwright Engine| BrowserRun
    BrowserRun -->|Automated Form Fill & Dry-Run| BMEIA
    Worker -->|Send Alert| TelegramAPI
```

---

## 2. Architectural Invariants (AD-1 to AD-11)

| ID | Title | Rule & Binding | Prevents |
|---|---|---|---|
| **AD-1** | Storage Tier Classification | D1 = Relational source of truth & audit logs.<br>Durable Objects = Atomic job locks & state mutation.<br>KV = Temporary session cookies (`storageState`). | Data corruption & split-brain locks |
| **AD-2** | Consolidated Worker Topology | Single Cloudflare Worker combining HTTP handlers, Cron triggers, and Browser bindings. Service bindings deferred until needed. | Premature microservice abstraction bloat |
| **AD-3** | Application-Level PII Encryption | All PII fields (`passport_number`, `phone`, `email`, `first_name`, `last_name`) encrypted using AES-256-GCM before writing to D1. Key in Worker Secret `PII_ENCRYPTION_KEY`. | Unencrypted PII leaks in database backups |
| **AD-4** | Single-POST Availability Scanner | Availability checks bypass UI steps, executing `POST /HomeWeb/Scheduler` directly with form params. | Excessive browser time budget consumption |
| **AD-5** | Atomic Job Lock Actor | Every client job binds to a dedicated Durable Object (`JobLockDO`). Booking attempts require DO lock acquisition before browser launch. | Double-booking race conditions |
| **AD-6** | Mandatory Dry-Run Safety | `DRY_RUN=true` environment flag stops Playwright execution prior to final form `Submit`. Requires operator verification to lift. | Accidental live bookings during testing |
| **AD-7** | Outstanding Workload Scheduler | Queue prioritization orders active jobs strictly by `last_check ASC` (oldest outstanding check first). | Unfair starvation of older client jobs |
| **AD-8** | Edge Origin Proximity Placement | Worker `placement = { mode = "smart" }` configured in `wrangler.toml` to colocate execution near BMEIA origin (Vienna/Frankfurt). `[verify: smart placement availability on Workers Free plan before deploy]` | High cross-continental network latency RTT |
| **AD-9** | Pre-Serialized Payloads — DEFERRED | Payload pre-serialization applies only to the verified discovery contract today. Any booking-payload optimization is deferred until the booking path is verified (G0 section 6). | Runtime string building & allocation latency |
| **AD-10** | Concurrent Multi-Candidate Parallel Fan-Out — DEFERRED | Sequential oldest-first fairness (AD-7) is the live design; parallel fan-out is deferred until booking path verification and conflicts with the fair queue as designed. | Sequential candidate submission delays |
| **AD-11** | Global Cairo Operating Window & Rolling Horizon | All ACTIVE jobs scan only inside **07:00–18:00 Cairo time, every day (Friday included)** — the tick exits immediately outside the window. Each scan covers the **current week + 7 forward weeks** (8-week horizon, global constant in `src/scheduler.ts`). No per-client schedule fields exist; `jobs.start_date/end_date/allowed_days/preferred_time_*` are legacy columns the scheduler never reads. | Out-of-window portal load; unbounded scan fan-out; per-client rule drift |

---

## 3. Database Schema (Cloudflare D1)

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
```

> **2026-08-20 (client deletion):** `audit_logs.client_id`/`job_id` have no `ON DELETE` action, and D1 enforces FKs — scheduler scan rows referencing a client would block `DELETE /api/clients/:id`. The DELETE route therefore nulls both columns for the client first (`UPDATE audit_logs SET client_id = NULL, job_id = NULL WHERE client_id = ?`), then writes `CLIENT_DELETED`, then deletes. The optional `ON DELETE SET NULL` migration is recorded in `docs/implementation-artifacts/deferred-work.md`.

---

## 4. Execution Sequence Diagrams

### 4.1 Scheduled Availability Check (Scanner Flow)

```mermaid
sequenceDiagram
    autonumber
    participant Cron as Worker Cron (1 min)
    participant Sched as Scheduler Engine
    participant D1 as D1 Database
    participant BMEIA as BMEIA Portal API

    Cron->>Sched: Execute Scheduled Check (07:00-18:00 Cairo, daily)
    Sched->>Sched: Scan jobs by oldest last_check (up to 3/tick)
    Sched->>D1: Fetch next job (enabled=1, status='ACTIVE', last_check ASC)
    D1-->>Sched: Job Record (CalendarId; horizon weeks computed globally)
    Sched->>BMEIA: POST /HomeWeb/Scheduler (verified form params, per week)
    BMEIA-->>Sched: HTML Response (measured ~120-770ms)
    alt Response contains 'message-error'
        Sched->>D1: Update job (last_check = NOW(), check_count++)
        Sched->>D1: Insert audit log (NO_APPOINTMENT)
    else Grid content found
        Sched->>D1: Insert audit log (APPOINTMENT_FOUND)
        Sched->>Sched: Transition Job to 'BOOKING' & Trigger Booking Flow
    else Unexpected structure
        Sched->>D1: Insert audit log (UNKNOWN_RESPONSE) — never treated as slot
    end
```

### 4.2 Booking Flow (PROPOSED — UNVERIFIED until first slot capture, G0 section 8)

```mermaid
sequenceDiagram
    autonumber
    participant Sched as Scheduler Engine
    participant DO as JobLockDO (Durable Object)
    participant BMEIA as BMEIA Portal

    Sched->>DO: AcquireLock(job_id)
    alt Lock Denied / Already Booked
        DO-->>Sched: Lock Rejected
    else Lock Acquired
        DO-->>Sched: Lock Granted
        Note over Sched,BMEIA: Booking path UNVERIFIED — engine fails closed.<br/>No live submission until G0 first-slot capture + operator legal decision.
        Sched->>DO: ReleaseLock(job_id)
    end
```

> The dual-engine decision (direct HTTP POST vs Playwright) will be made from first-slot capture evidence and recorded in `portal-automation-spec.md` section 6. Until then the implementation returns `Booking path UNVERIFIED` and performs no network submission.

---

## 5. Security Architecture & Encryption Details

### AES-256-GCM Encryption Helper Specification
- **Algorithm**: `AES-GCM` with 256-bit key length.
- **Initialization Vector (IV)**: 12-byte cryptographically secure random IV generated per encryption operation.
- **Storage Format**: Ciphertext formatted as `base64(IV + Ciphertext + Tag)`.
- **Key Source**: Loaded from `env.PII_ENCRYPTION_KEY` at runtime using Web Crypto API (`crypto.subtle`).

---

## 6. Error & Failure Modes Matrix

| Failure Mode | Detection Indicator | System Reaction | Recovery Action |
|---|---|---|---|
| Portal Down / 5xx | HTTP 500 / 503 or Connection Timeout | Transition to `TEMPORARY_ERROR` | Exponential Backoff (2, 4, 8... mins) |
| Layout Shift / Unexpected DOM | Missing expected HTML elements | Transition to `PORTAL_ERROR` | Log DOM snippet + Alert Operator |
| Slot Disappeared Mid-Booking | "Slot no longer available" text | Transition to `BOOKING_FAILED` | Re-queue job to `ACTIVE` |
| Daily Browser Budget Reached (90%) | Cumulative browser time ≥ 540s | Trip safety circuit breaker | Halt new browser launches + Telegram Alert |
| Concurrent Worker Execution | DO Lock collision | First wins, second aborts immediately | Silent abort, zero duplicate submission |
