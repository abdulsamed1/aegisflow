# Test Automation Summary — opran-booking

## Overview
Generated and executed automated API & E2E tests for candidate CRUD endpoints, scheduling logic, and portal payload serialization matching live BMEIA forms.

## Test Suite Execution Results

- **Total Test Cases**: 125
- **Passing**: 125
- **Failing**: 0
- **Duration**: ~18 seconds
- **Last verified**: 2026-08-22 (performance audit fixes: FIFO throttle queue + parallel whisper audio captcha + tier-aware burst scanning)

---

## Test Coverage Breakdown

### 1. API Endpoints (`test/api.test.ts`)
- [x] `GET /api/status` — Returns operational status metrics (live only).
- [x] `GET /api/clients` — Decrypts stored PII and returns masked passport strings.
- [x] `POST /api/clients` — Creates encrypted candidate records and validates required fields & enums (400 Bad Request on invalid category).
- [x] `PUT /api/clients/:id` — Updates existing candidate data, recomputes calendarId, and handles empty passport string preservation.
- [x] `DELETE /api/clients/:id` — Safely removes candidates, detaches foreign key references in audit logs, and protects `BOOKED` jobs (403 Forbidden).

### 2. E2E & Booking Engine Pipeline (`test/e2e-workflow.test.ts`, `test/booking.test.ts`, `test/throttle.test.ts`, `test/captcha.test.ts`, `test/parse-bursts.test.ts`)
- [x] Candidate Onboarding & Lifecycle Flow.
- [x] Date Conversion: ISO (`YYYY-MM-DD`) to portal format (`MM/DD/YYYY`).
- [x] Step 3 Payload Serialization: Serializes 18 PII fields, split postal code & city, consent, and CAPTCHA challenge text.
- [x] Booking Confirmation Extraction: Regex parsing of reference IDs (`GESX-...`) from confirmation HTML.
- [x] Browser Launch Throttling: Sequential FIFO launch queue verification (`test/throttle.test.ts`).
- [x] CAPTCHA Audio Solving: Parallel Whisper selection, fallback to turbo, and timing (`test/captcha.test.ts`).
- [x] Burst Scanning: Tier-aware clamping (Free 1..2, Paid 1..12) (`test/parse-bursts.test.ts`).

### 3. Miniflare Integration & Security Tests (`test/integration.miniflare.test.ts`)
- [x] AES-256-GCM PII encryption at rest in Cloudflare D1.
- [x] Durable Object concurrency locking & TTL expiration takeover.
- [x] Fail-closed 500 error when `PII_ENCRYPTION_KEY` is missing.
- [x] D1 SQLite `CHECK` constraint enforcement for category values.

---

## Next Steps
- Execute automated suite in CI pipeline (`npm test`).
- Live booking only — `DRY_RUN` retired 2026-08-21.
