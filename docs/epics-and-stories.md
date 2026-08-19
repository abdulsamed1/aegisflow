# Epics & User Stories Specification — BMEIA Appointment Automation (opran-booking)

> **Status:** FINAL  
> **Traceability:** Direct mapping to Product Brief (`docs/product-breif.ar.md`) and PRD (`docs/prd.md`).  

---

## Epic 1: Foundation & Data Infrastructure

### Story 1.1: Database Schema & PII Encryption
- **As an** Engineer,  
- **I want to** initialize the Cloudflare D1 database schema and Web Crypto AES-256-GCM encryption module,  
- **So that** all candidate client PII is securely encrypted at rest before hitting the database.

#### Acceptance Criteria:
1. D1 migration script creates `clients`, `jobs`, `audit_logs`, and `daily_metrics` tables with indexes.
2. `encryptPII(text, key)` and `decryptPII(ciphertext, key)` helpers use Web Crypto API `AES-GCM` with random 12-byte IVs.
3. Unencrypted passport numbers or contact details never land in D1 storage or log output.

---

### Story 1.2: Client Candidate & Job CRUD API
- **As an** Operator,  
- **I want to** create, update, list, and delete client candidate profiles and booking jobs via HTTP endpoints,  
- **So that** candidate data is managed accurately.

#### Acceptance Criteria:
1. REST endpoints: `GET /api/clients`, `POST /api/clients`, `PUT /api/clients/:id`, `DELETE /api/clients/:id`.
2. Job lifecycle endpoints: `POST /api/jobs/:id/activate`, `POST /api/jobs/:id/pause`, `POST /api/jobs/:id/cancel`.
3. System rejects requests attempting to create more than 10 active jobs.

---

### Story 1.3: Structural Validation Engine
- **As a** System,  
- **I want to** validate candidate PII and date ranges before allowing job activation,  
- **So that** malformed or expired candidate data does not waste availability scans.

#### Acceptance Criteria:
1. Passport expiry rule applied per operator configuration. `[ASSUMPTION: the 6-month rule must be confirmed against the official requirements list before it becomes a hard gate]`
2. Target appointment date range must be chronological (`start_date <= end_date`).
3. Invalid data transitions record to `VALIDATION_ERROR` with human-readable error messages.

---

## Epic 2: Single-POST Availability Scanner & Fair Scheduler

### Story 2.1: Fast Single-POST Scanner
- **As a** Scanner Engine,  
- **I want to** query `POST /HomeWeb/Scheduler` directly with form parameters,  
- **So that** availability is scanned in under 300ms without loading heavy UI pages.

#### Acceptance Criteria:
1. POST request sent with verified params (`Office=KAIRO`, `CalendarId`, `Monday`, `Command=Next`) and warmed session cookies (`AspxAutoDetectCookieSupport=1` + `ASP.NET_SessionId` persisted in KV).
2. HTML response parser implements the 3-state G0 contract: `message-error` → NO_SLOTS; scheduler page with non-empty week grid → SLOTS; anything else → UNKNOWN (never a slot).
3. Total scan latency averages < 500ms per request (measured baseline ~270ms).

---

### Story 2.2: 24/7 Fair Queue Scheduler (D5)
- **As a** Scheduler,  
- **I want to** run every minute around the clock and pick up to 3 active jobs by oldest `last_check` timestamp, scanning each job's accepted week range,  
- **So that** any slot appearing at any time is captured and checks are distributed fairly.

#### Acceptance Criteria:
1. Cron Trigger executes 24/7 (no time-window gate; Cairo time used for display only).
2. Scheduler queries D1 for enabled `ACTIVE` jobs ordered strictly by `last_check ASC`, processing up to 3 per tick.
3. Each job's scan covers every Monday within its `start_date`–`end_date` window.
4. Candidates with older checks are processed first, preventing backlog starvation.

---

### Story 2.3: Exponential Backoff & Circuit Breaker
- **As a** System,  
- **I want to** apply backoff on transient errors and monitor daily browser time,  
- **So that** portal rate-limits or system errors do not drain resources.

#### Acceptance Criteria:
1. Failures (`TEMPORARY_ERROR` / `BOOKING_FAILED`) set `backoff_until` timestamp using exponential backoff (2, 4, 8, 16, 32, max 60 mins).
2. Cumulative browser seconds are tracked in `daily_metrics`.
3. System trips safety circuit breaker at 540 seconds (90% of 600s daily budget) and alerts operator.

---

## Epic 3: Durable Locking & Playwright Booking Engine

### Story 3.1: Durable Object Atomic Job Lock
- **As a** Booking Engine,  
- **I want to** acquire a lock from a dedicated Durable Object actor before attempting any booking,  
- **So that** duplicate booking execution is physically impossible.

#### Acceptance Criteria:
1. `JobLockDO` instance created per client job.
2. `acquireLock(job_id)` returns true only for the first caller; subsequent concurrent calls are rejected immediately.
3. `BOOKED` state permanently locks the DO actor against future acquisitions.

---

### Story 3.2: Playwright Integration & Dry-Run Safety
- **As an** Operator,  
- **I want** Playwright to fill forms in Dry-Run mode and stop before final submission,  
- **So that** booking logic can be verified safely without submitting live requests.

#### Acceptance Criteria:
1. `@cloudflare/playwright` launches browser, navigates to BMEIA form, and populates candidate data.
2. When `DRY_RUN=true` (default), browser takes a screenshot of the pre-submit review page and halts cleanly without clicking `Submit`.
---

### Story 3.3: First-Slot Capture Spike — Document the Real Booking Path (G0)
- **As a** Booking Engine,  
- **I want to** capture and document the portal's actual booking flow at the first appearing slot,  
- **So that** the booking engine is built on evidence, not invented endpoints.

#### Acceptance Criteria:
1. On first `APPOINTMENT_FOUND`, capture raw DOM + screenshot and trace the click path (per `portal-automation-spec.md` section 8), halting before any final submission.
2. Record the real slot markup, form field names/types/validation, CAPTCHA location, and confirmation format into the spec.
3. Booking engine remains fail-closed (`Booking path UNVERIFIED`) until this spike closes — no live submission, no fabricated reference.
4. The dual-engine question (direct HTTP vs Playwright) is decided from the spike evidence and recorded in the spec.

---

## Epic 4: Admin Dashboard & Notifications

### Story 4.1: Single Operator SPA Admin Panel
- **As an** Operator,  
- **I want a** dark glassmorphism dashboard displaying active jobs, status badges, metrics, and modal forms,  
- **So that** I can monitor and control all automation jobs effortlessly.

#### Acceptance Criteria:
1. Top bar displays Cairo Time clock, Dry-Run status banner, and resource budget gauge.
2. Client table lists all candidates with status pills and action toggles (Activate/Pause/Edit).
3. Responsive SPA loads in under 1 second from Cloudflare Workers Static Assets.

---

### Story 4.2: Telegram Notification Service
- **As an** Operator,  
- **I want to** receive instant Telegram notifications for successful bookings and critical errors,  
- **So that** I am alerted immediately when an appointment is secured.

#### Acceptance Criteria:
1. Telegram Bot API sends rich formatted markdown message on `BOOKED` status with candidate name, date, time, reference ID, and screenshot link.
2. Alert sent on critical budget warnings (≥90% browser budget used).
