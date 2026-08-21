# 5. Functional Requirements (FR)

## FR-1: Client Management & PII Schema
- System shall store complete client profile: First Name, Last Name, Family Name at Birth, Gender, Date of Birth, Place of Birth, Country of Birth, Nationality, Nationality at Birth, Passport Number, Passport Issue Date, Passport Issuing Country, Passport Expiry, Street & House Number, Postal Code, City, Email, Phone Number, Category (Bachelor vs. Master/PhD).
- All client PII fields shall be encrypted using AES-256-GCM before writing to Cloudflare D1. Encryption classes follow the 2026-08-20 convention: identity/contact strings (names, passport number, address street/city/postal code, email, phone) encrypted; dates and categorical values (DoB, passport dates, nationalities, place/country of birth) plaintext — same class as the pre-existing `dob`/`nationality` columns.

## FR-2: Structural Validation Engine
- System shall validate client data against BMEIA requirements prior to allowing transition to `READY`.
- `[ASSUMPTION — to confirm against the official requirements list]` Passport expiration must be valid for at least 6 months beyond the target appointment window.
- Invalid data transitions the record to `VALIDATION_ERROR` with explicit error details displayed in UI.

## FR-3: Appointment Preference Rules
- Preference rules are **global and identical for every client** (operator decision 2026-08-20 — no per-client customization):
  - Operating window: every day, 07:00–18:00 Cairo time (Friday included).
  - Scan horizon: current week + 7 forward weeks (8 Mondays, global constant).
- The only per-client preference is `calendar_id`: `44281520` (Bachelor) or `44279679` (Master/PhD/Scholarship).
- No per-client date range, day selection, or time range is collected or stored.

## FR-4: Fair Scheduler Engine (Global Cairo Window)
- Scheduler shall run via Cloudflare Worker Cron Trigger every 1 minute, **only inside the global Cairo window 07:00–18:00, daily including Friday** (D5 as amended 2026-08-20); outside the window each tick exits immediately.
- **Burst scanning (2026-08-21, ponytail free-tier safe)**: native Cron is limited to 1/min, so each tick repeats the 8-Monday scan `SCAN_BURSTS` times via `parseScanBursts()` (default 2 ≈ every 30s, cap 2 on Free tier / 12 on Workers Paid). Free cap 2 keeps fetches + D1 under 50 subrequests/invocation; `setTimeout(30000)` between bursts gives even spacing. Budget: 3 jobs × 8 × 2 × 660 ≈31k req/day + aggregated `NO_APPOINTMENT` logs (was 95k with 6×). Configurable via `wrangler.toml [vars] SCAN_BURSTS`.
- Fairness Algorithm: Selects up to 3 `ACTIVE` jobs per tick ordered strictly by **oldest `last_check` timestamp** (measuring outstanding backlog, NOT daily attempt counts).
- Rolling Horizon Scan: Each job's availability scan covers the current week plus the next 7 weeks (8 Mondays, global constant in `src/scheduler.ts`) — the portal accepts any `Monday` value (G0 §5).
- Backoff Policy: Jobs with `TEMPORARY_ERROR` or `BOOKING_FAILED` apply exponential backoff (2, 4, 8, 16, 32, max 60 minutes).

## FR-5: Single POST Discovery Scanner
- Discovery scanner shall execute availability checks via direct HTTP `POST` to `https://appointment.bmeia.gv.at/HomeWeb/Scheduler` (verified contract: `docs/portal-automation-spec.md` section 5).
- Payload parameters (verified only): `Language=en`, `Office=KAIRO`, `CalendarId=<ID>`, `PersonCount=1`, `Monday=<Week_Monday>`, `Command=Next`.
- Session handling: Worker must warm cookies via a GET redirect pass (`AspxAutoDetectCookieSupport=1` + `ASP.NET_SessionId`) and persist them in KV.
- Measured latency: ~270ms average (first request ~770ms, steady state 116–216ms).
- **3-state response contract**:
  1. `p.message-error` / "no appointments available" → `NO_SLOTS`.
  2. Scheduler page without the error and a non-empty week grid → `SLOTS`.
  3. Anything else (non-200, unexpected structure) → `UNKNOWN` — **never** treated as a slot.

## FR-6: Distributed Locking & Double-Booking Prevention
- Each client job shall be bound to a dedicated Cloudflare Durable Object instance acting as an atomic state lock.
- Before executing a booking attempt (`BOOKING` state), the Worker must acquire the DO lock.
- Once a job reaches `BOOKED` state, the DO lock permanently seals the job, preventing any further checks or duplicate bookings.

## FR-7: Booking Engine (Playwright Wizard — Direct HTTP Retired)
- **Verified path is Playwright only** (`docs/portal-automation-spec.md §6` revised 2026-08-21, London evidence). `executePlaywrightFallback` navigates Office→CalendarId→PersonCount→Info→Week grid radios→Slot→Personal data (31 real names `Lastname/Firstname/DateOfBirth/TraveldocumentNumber/Sex/Postcode/Telephone/DSGVOAccepted` + `BDC_*/CaptchaText` + `Token/StartTime`) and extracts `GESX-...`; success only with reference. The `~200ms` figure in prior revisions applied only to the scanner POST (`FR-5`), not booking — wizard is ~35-50s including open-source OCR (tesseract.js) and 20s throttle (NFR-2).
- **Autonomous Submission**: Playwright wizard submits via `@cloudflare/playwright`, solves CAPTCHA locally via `src/captcha.ts` (tesseract.js, Apache 2.0, no API key, 1-2s vs 2captcha 10-60s poll), and parses `GESX-...`.
- **Direct HTTP `executeDirectHttpBooking` is dead for live booking** — retained only for unit-test payload helpers (`buildStep3DetailsPayload` correct names) and not called from `src/index.ts scheduled()` (verified 2026-08-21). Do not reintroduce as primary without re-verifying portal `Token/BDC_*` handling.

## FR-8: Audit Logging & Metrics
- All events shall be logged to D1 table `audit_logs` with the canonical event set from the brief section 17:
  `NO_APPOINTMENT, APPOINTMENT_FOUND, RULE_MISMATCH, UNKNOWN_RESPONSE, BOOKING_STARTED, SUBMITTED, BOOKED, BOOKING_FAILED, TEMPORARY_ERROR, PORTAL_ERROR, BUDGET_WARNING, NOTIFY_SENT` ( `DRY_RUN_STOPPED` retired 2026-08-21 with `DRY_RUN` removal ).
- Implementation-added event (2026-08-20, client deletion): `CLIENT_DELETED` — written by `DELETE /api/clients/:id` after detaching the client's scheduler audit rows (`client_id`/`job_id` → NULL; see architecture.md §3 note).
- Logs shall include `job_id`, `client_id`, `event_type`, `duration_ms`, `error_code`, and ISO timestamp.

## FR-9: Operator Telegram Alerts
- System shall send immediate Telegram alerts via Bot API for:
  - `BOOKED`: Client name, appointment date/time, reference ID, screenshot link.
  - `CRITICAL`: Daily browser budget reaching 90%, repeated portal errors, consecutive check failures (>5).

## FR-10: Operator Admin Dashboard
- Single-page web application **embedded in the Worker** `src/index.ts getAdminHTML()` (not separate Static Assets) — same-origin to `/api/*` so `fetch()` authenticates via `__Host-opran_admin_token` + `CF_Authorization` cookies (no `X-API-Key`/`CF-Access-*` in JS, audited 2026-08-21).
- Functions: Client listing, status filtering, client creation/editing/**deletion**, job activation/pausing/cancellation, audit log viewer, live metrics (checks/hr, slot hit rate).
- Auth: Access edge login (OTP) → Worker `GET /` Basic dialog or header auth, session cookie `__Host-opran_admin_token` = `base64(SHA-256("opran-session-v1|<key>"))` (`HttpOnly; Secure; SameSite=Strict; Max-Age=86400`) — never the raw key; constant-time compares; `POST /logout` clears it; cron `scheduled()` unaffected. `?token=` URL auth removed (log/referrer leak).

---
