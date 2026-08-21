# Epic 3: Durable Locking & Playwright Booking Engine

## Story 3.1: Durable Object Atomic Job Lock
- **As a** Booking Engine,  
- **I want to** acquire a lock from a dedicated Durable Object actor before attempting any booking,  
- **So that** duplicate booking execution is physically impossible.

### Acceptance Criteria:
1. `JobLockDO` instance created per client job.
2. `acquireLock(job_id)` returns true only for the first caller; subsequent concurrent calls are rejected immediately.
3. `BOOKED` state permanently locks the DO actor against future acquisitions.

---

## Story 3.2: Playwright Integration & Live Browser Fallback
- **As an** Operator,  
- **I want** Playwright to fill forms and execute submissions when direct HTTP POST requires browser DOM interaction,  
- **So that** booking execution is guaranteed even if direct HTTP submission encounters browser constraints.

### Acceptance Criteria:
1. `@cloudflare/playwright` launches browser, navigates to BMEIA form, and populates candidate PII fields.
2. Populates candidate fields, checks GDPR consent, submits the form, and extracts confirmation reference ID (`GESX-...`) — live booking only (`DRY_RUN` retired 2026-08-21).

---

## Story 3.3: Direct HTTP Fast-Path & Autonomous Submission Engine
- **As a** Booking Engine,  
- **I want to** execute direct multi-step HTTP POST form submission to `POST /HomeWeb/Scheduler`,  
- **So that** appointments are captured in ultra-low latency (~200ms) before competitor bots.

### Acceptance Criteria:
1. `executeDirectHttpBooking` sends Step 3 serialized candidate PII payload directly to `https://appointment.bmeia.gv.at/HomeWeb/Scheduler`.
2. Parses confirmation reference ID (`GESX-...`) from HTML response.
3. Automatically triggers Playwright browser fallback (`requiresPlaywrightFallback: true`) if HTTP direct response is unconfirmed or blocked.

---
