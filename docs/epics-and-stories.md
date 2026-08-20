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
3. Client creation accepts the complete BMEIA identity profile (birth, address, passport-issue fields — D8/FR-1 amendment 2026-08-20), encrypted per the field-class convention.
4. System rejects requests attempting to create more than 10 active jobs.

---

### Story 1.3: Structural Validation Engine
- **As a** System,  
- **I want to** validate candidate PII before allowing job activation,  
- **So that** malformed candidate data does not waste availability scans.

#### Acceptance Criteria:
1. Passport expiry rule applied per operator configuration. `[ASSUMPTION: the 6-month rule must be confirmed against the official requirements list before it becomes a hard gate]`
2. All required client fields (identity, birth, address, passport-issue data — 2026-08-20 amendment) must be present and non-empty before activation.
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

### Story 2.2: Global-Window Fair Queue Scheduler (D5 amended 2026-08-20)
- **As a** Scheduler,  
- **I want to** run every minute inside the global 07:00–18:00 Cairo window (daily, Friday included) and pick up to 3 active jobs by oldest `last_check` timestamp, scanning a rolling 8-week horizon,  
- **So that** any slot appearing inside the window is captured and checks are distributed fairly.

#### Acceptance Criteria:
1. Cron Trigger fires every minute; execution is gated to the global 07:00–18:00 Cairo window (daily, Friday included) — outside the window the tick exits immediately.
2. Scheduler queries D1 for enabled `ACTIVE` jobs ordered strictly by `last_check ASC`, processing up to 3 per tick.
3. Each job's scan covers the current week plus the next 7 weeks (rolling 8-week horizon, global constant — replaces the removed `start_date`–`end_date` per-client window).
4. Candidates with older checks are processed first, preventing backlog starvation.
5. No date-based expiry: a request stays `ACTIVE` until `BOOKED` or operator cancellation (D8).

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

### Story 3.2: Playwright Integration & Live Browser Fallback
- **As an** Operator,  
- **I want** Playwright to fill forms and execute submissions when direct HTTP POST requires browser DOM interaction,  
- **So that** booking execution is guaranteed even if direct HTTP submission encounters browser constraints.

#### Acceptance Criteria:
1. `@cloudflare/playwright` launches browser, navigates to BMEIA form, and populates candidate PII fields.
2. In Dry-Run mode (`DRY_RUN=true`), takes a screenshot of the pre-submit review page and halts cleanly without clicking `Submit`.
3. In Live mode (`DRY_RUN=false`), populates candidate fields, checks GDPR consent, submits the form, and extracts confirmation reference ID (`GESX-...`).

---

### Story 3.3: Direct HTTP Fast-Path & Autonomous Submission Engine
- **As a** Booking Engine,  
- **I want to** execute direct multi-step HTTP POST form submission to `POST /HomeWeb/Scheduler`,  
- **So that** appointments are captured in ultra-low latency (~200ms) before competitor bots.

#### Acceptance Criteria:
1. `executeDirectHttpBooking` sends Step 3 serialized candidate PII payload directly to `https://appointment.bmeia.gv.at/HomeWeb/Scheduler`.
2. Parses confirmation reference ID (`GESX-...`) from HTML response.
3. Automatically triggers Playwright browser fallback (`requiresPlaywrightFallback: true`) if HTTP direct response is unconfirmed or blocked.

---

## Epic 4: Admin Dashboard & Notifications

### Story 4.1: Single Operator SPA Admin Panel
- **As an** Operator,  
- **I want a** premium navy dashboard displaying active jobs, status badges, metrics, and modal forms,  
- **So that** I can monitor and control all automation jobs effortlessly.

> **2026-08-20 amendment (superseded same day):** the shipped dashboard was the premium redesign (`docs/implementation-artifacts/spec-spa-crud-premium-ui.md`, removed with the artifacts dir) — off-black navy palette, Bootstrap 5.3 RTL (CSS-only, SRI-pinned), Alexandria typeface, skeleton/empty/inline-error states — superseding the earlier "dark glassmorphism" direction. Superseded by the v6 Paper Dossier flip (see below).
>
> **2026-08-20 amendment (current):** the shipped dashboard is **v6 Paper Dossier** (light editorial, `docs/ux-spec.md`, code: `src/index.ts` `getAdminHTML`) — parchment canvas, paper cards, burnt-red accent, **hand-rolled CSS, no Bootstrap, no framework stylesheet**, Alexandria the only font request, same DOM/JS. Per operator request the same day: the header brand group and footer system line were removed (header holds only the `+ إضافة مرشح جديد` CTA), and the live Cairo-time metric card (`window-tag`/`val-cairo`) was removed — the global 07:00–18:00 window still governs scheduling server-side.

#### Acceptance Criteria:
1. Header hosts the single primary CTA (`+ إضافة مرشح جديد`); the v1 budget gauge, Cairo clock, and DRY-RUN status banner are **not shipped/removed** — budget is an NFR surfaced via Telegram (FR-9), the global Cairo window is server-side, and DRY-RUN state lives in `wrangler.toml` (`DRY_RUN` var) and Telegram alerts.
2. Client table lists all candidates with status pills and action toggles (Activate/Pause/Cancel — cancel added per D8, 2026-08-20; **Edit/Delete added per the CRUD story, same day**).
3. Responsive SPA loads in under 1 second from Cloudflare Workers Static Assets.

---

### Story 4.2: Telegram Notification Service
- **As an** Operator,  
- **I want to** receive instant Telegram notifications for successful bookings and critical errors,  
- **So that** I am alerted immediately when an appointment is secured.

#### Acceptance Criteria:
1. Telegram Bot API sends rich formatted markdown message on `BOOKED` status with candidate name, date, time, reference ID, and screenshot link.
2. Alert sent on critical budget warnings (≥90% browser budget used).
