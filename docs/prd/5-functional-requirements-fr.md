# 5. Functional Requirements (FR)

## FR-1: Client Management & PII Schema
- System shall store complete client profile: First Name, Last Name, Family Name at Birth, Gender, Date of Birth, Place of Birth, Country of Birth, Nationality, Nationality at Birth, Passport Number, Passport Issue Date, Passport Issuing Country, Passport Expiry, Street & House Number, Postal Code, City, Email, Phone Number, Category (Bachelor only in MVP scope; CalendarId 44281520).
- All client PII fields shall be encrypted using AES-256-GCM before writing to Cloudflare D1. Encryption classes follow the 2026-08-20 convention: identity/contact strings (names, passport number, address street/city/postal code, email, phone) encrypted; dates and categorical values (DoB, passport dates, nationalities, place/country of birth) plaintext — same class as the pre-existing `dob`/`nationality` columns.

## FR-2: Structural Validation Engine
- System shall validate client data against BMEIA requirements prior to allowing transition to `READY`.
- `[ASSUMPTION — to confirm against the official requirements list]` Passport expiration must be valid for at least 6 months beyond the target appointment window.
- Invalid data transitions the record to `VALIDATION_ERROR` with explicit error details displayed in UI.

## FR-3: Appointment Preference Rules
- Preference rules are **global and identical for every client** (operator decision 2026-08-20 — no per-client customization):
  - Operating window: every day, 07:00–18:00 Cairo time (Friday included).
  - Scan horizon: current week + 7 forward weeks (8 Mondays, global constant).
- The supported `calendar_id` under the MVP scope is exclusively `44281520` (Bachelor). (Master/PhD `44279679` and other categories are out of scope).
- No per-client date range, day selection, or time range is collected or stored.

## FR-4: Fair Scheduler Engine (Global Cairo Window)
- Scheduler shall run via Cloudflare Worker Cron Trigger every 1 minute, **only inside the global Cairo window 07:00–18:00, daily including Friday** (D5 as amended 2026-08-20); outside the window each tick exits immediately.
- **Burst scanning (2026-08-21,  tier-aware)**: native Cron is limited to 1/min, so each tick repeats the 8-Monday scan `SCAN_BURSTS` times via `parseScanBursts(v?, planTier?)` (default 2 ≈ every 30s, cap 2 on Free tier / 12 on Workers Paid). Free cap 2 keeps fetches + D1 under 50 subrequests/invocation; `setTimeout(30000)` between bursts gives even spacing. Budget: 3 jobs × 8 × 2 × 660 ≈31k req/day + aggregated `NO_APPOINTMENT` logs (was 95k with 6×). Configurable via `wrangler.toml [vars] SCAN_BURSTS` and `PLAN_TIER`.
- Fairness Algorithm: Selects up to 3 `ACTIVE` jobs per tick ordered strictly by **oldest `last_check` timestamp** (measuring outstanding backlog, NOT daily attempt counts).
- Rolling Horizon Scan: Each job's availability scan covers the current week plus the next 7 weeks (8 Mondays, global constant in `src/scheduler.ts`) — the portal accepts any `Monday` value (G0 §5).
- Backoff Policy: Jobs with `TEMPORARY_ERROR` apply exponential backoff (2, 4, 8, 16, 32, max 60 minutes). Exception — `BOOKING_FAILED` never backs off (never-park policy, operator-mandated 2026-09-11): it requeues with `backoff_until = NULL`, retrying next tick while slots verify. Rationale: `check_count` grows ~16–48 per scan tick, so any derived backoff parked every failed job the 60-minute cap. Guards that stay: single same-tick retry, 20s launch throttle, per-job DO lock, reverify gate, 540s circuit breaker.

## FR-5: Single POST Discovery Scanner
- Discovery scanner shall execute availability checks via direct HTTP `POST` to `https://appointment.bmeia.gv.at/HomeWeb/Scheduler` (verified contract: `docs/portal-automation-spec.md` section 5).
- Payload parameters (verified only): `Language=en`, `Office=KAIRO`, `CalendarId=44281520`, `PersonCount=1`, `Monday=<Week_Monday>`, `Command=Next`.
- Session handling: Worker must warm cookies via a GET redirect pass (`AspxAutoDetectCookieSupport=1` + `ASP.NET_SessionId`) and persist them in KV.
- Measured latency: ~270ms average (first request ~770ms, steady state 116–216ms).
- **3-state response contract**:
  1. Response containing `no appointments available` (case-insensitive) → `NO_SLOTS`.
  2. Response containing `input[type="radio"]` elements with date/time values (`value="M/D/YYYY h:mm:ss AM/PM"`) or slot entries in the scheduler grid → `SLOTS` (note: `<p class="message-error">Please choose an appointment!</p>` is present on valid slot pages and is NOT treated as no slots).
  3. Anything else (non-200, unexpected structure without radios and without the no-appointments message) → `UNKNOWN` — **never** treated as a slot. Since 2026-09-11 the cause is tagged (`ScanResult.errorKind`): `TRANSPORT` = no usable HTTP response (non-OK status, fetch throw — portal edge down/blocking) vs `PARSE` = HTTP 200 with unexpected markup (portal answered). A burst in which EVERY fetch dies at transport (`isTransportOutage`) skips the job's remaining bursts: one aggregated `UNKNOWN_RESPONSE` row (`{aggregatedTransportFailures, weeks, burstsSkipped, error}`) replaces up to 8 rows per skipped burst, and the 30s inter-burst sleep is skipped. Any `SLOTS`, `NO_SLOTS`, or `PARSE` result proves the portal answered — scanning continues normally.

## FR-6: Distributed Locking & Double-Booking Prevention
- Each client job shall be bound to a dedicated Cloudflare Durable Object instance acting as an atomic state lock.
- Before executing a booking attempt (`BOOKING` state), the Worker must acquire the DO lock.
- Once a job reaches `BOOKED` state, the DO lock permanently seals the job, preventing any further checks or duplicate bookings.

## FR-7: Booking Engine (Puppeteer Fast-Path Wizard — Direct HTTP Retired)
- **Verified path is the browser wizard via `@cloudflare/puppeteer` (`launchBrowser`)** (revised 2026-09-24 with Fast-Path direct POST navigation):
  - **Cookie Pre-Seeding (OPT-8)**: Puppeteer pre-seeds `AspxAutoDetectCookieSupport=1` and `ASP.NET_SessionId` prior to navigation, eliminating ASP.NET 302 redirect loops that timed out under peak release traffic.
  - **Fast-Path Direct POST Navigation (OPT-1)**: `executePlaywrightFallback` submits an atomic synthetic form POST to `/HomeWeb/Scheduler` with canonical parameters (`Office=KAIRO`, `CalendarId`, `PersonCount=1`, `Monday=<Week_Monday>`, `Command=Next`), landing directly on the week grid in **~1.2 seconds** (bypassing Steps 1–4). If direct POST does not land on the grid, it falls back cleanly to the full wizard.
  - **Atomic In-Browser Radio Slot Selection (OPT-2)**: Slot radios are evaluated and selected inside a single `page.evaluate()` DOM call in 0.1ms, eliminating 20–40 sequential CDP roundtrips across the remote WebSocket.
  - **Atomic Batch Form Fill (OPT-3)**: 17 personal data fields and GDPR consent are batch-populated in 1 `page.evaluate()` call, dispatching native `focus`, `input`, `change`, and `blur` events.
  - **Low-Latency Audio CAPTCHA Pipeline (OPT-7)**: Solves BotDetect audio challenges via Workers AI Whisper (`whisper-tiny-en` short-circuiting on 4-5 chars, fallback to `whisper-large-v3-turbo`) with a 6-second `AbortController` timeout guard, with image OCR fallback (Tesseract.js / vision).
  - **Submission & Confirmation**: Submits form via `input#nextButton` and extracts `GESX-...`. Total browser wall time is slashed from ~40s down to **4–6 seconds** per attempt, easily preserving the 600s daily budget across 100+ booking runs without hitting 429 rate limits.
- **Autonomous Submission**: browser wizard submits via `@cloudflare/puppeteer` (`launchBrowser`), solves CAPTCHA via `src/captcha.ts` audio-first pipeline, and parses `GESX-...`.
- **Direct HTTP `executeDirectHttpBooking` is dead for live booking** — retained only for unit-test payload helpers (`buildStep3DetailsPayload` correct names) and not called from `src/index.ts scheduled()` (verified 2026-08-21). Do not reintroduce as primary without re-verifying portal `Token/BDC_*` handling.

## FR-8: Audit Logging & Metrics
- All events shall be logged to D1 table `audit_logs` with the canonical event set from the brief section 17:
  `NO_APPOINTMENT, APPOINTMENT_FOUND, RULE_MISMATCH, UNKNOWN_RESPONSE, BOOKING_STARTED, SUBMITTED, BOOKED, BOOKING_FAILED, BOOKING_RETRY, SLOT_GONE_PRE_LAUNCH, PRE_SUBMIT_BLOCKED, TEMPORARY_ERROR, PORTAL_ERROR, BUDGET_WARNING, NOTIFY_SENT` ( `DRY_RUN_STOPPED` retired 2026-08-21 with `DRY_RUN` removal ).
- Implementation-added event (2026-08-20, client deletion): `CLIENT_DELETED` — written by `DELETE /api/clients/:id` after detaching the client's scheduler audit rows (`client_id`/`job_id` → NULL; see architecture.md §3 note).
- Logs shall include `job_id`, `client_id`, `event_type`, `duration_ms`, `error_code`, and ISO timestamp.

## FR-9: Operator Telegram Alerts
- System shall send immediate Telegram alerts via Bot API (all non-blocking `bgTasks`, sent only when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are configured) for:
  - `SLOTS DETECTED` (2026-09-11, operator-parallel flow): **Arabic** instant alarm — job, client first name, week, `Bachelor` category, portal URL, apply-manually-in-parallel instruction. Fires after decrypt, before reverify; KV-deduped per job+week (30-min TTL) so a live slot doesn't re-alarm every tick. No passport PII on the alarm path.
  - Booking steps: `STARTED` (attempt 1/2), `SUBMITTED` (slot + stage), `RETRY` (classification + error), terminal-tick `FAILED` (classification + error + explicit never-parked notice), `SLOT_GONE` stand-down (stop manual effort), gate-blocked `VALIDATION_ERROR`.
  - `BOOKED`: Client name, appointment date/time, reference ID, screenshot link.
  - `CRITICAL`: Daily browser budget reaching 90%, repeated portal errors, consecutive check failures (>5).

## FR-10: Operator Admin Dashboard
- Single-page web application **embedded in the Worker** `src/index.ts getAdminHTML()` (not separate Static Assets) — same-origin to `/api/*` so `fetch()` authenticates via `__Host-aegisflow_admin_token` + `CF_Authorization` cookies (no `X-API-Key`/`CF-Access-*` in JS, audited 2026-08-21).
- Functions: Client listing, status filtering, client creation/editing/**deletion**, job activation/pausing/cancellation, audit log viewer, live metrics (checks/hr, slot hit rate).
- Auth: Access edge login (OTP) → Worker `GET /` Basic dialog or header auth, session cookie `__Host-aegisflow_admin_token` = `base64(SHA-256("aegisflow-session-v1|<key>"))` (`HttpOnly; Secure; SameSite=Strict; Max-Age=86400`) — never the raw key; constant-time compares; `POST /logout` clears it; cron `scheduled()` unaffected. `?token=` URL auth removed (log/referrer leak).

---
