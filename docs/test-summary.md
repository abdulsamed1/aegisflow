# QA Test Automation Summary — opran-booking

> **Generated:** 2026-08-20 (updated after the SPA CRUD + premium UI work and the final-review fix wave — PUT/DELETE/prefill/dashboard, FK detach, passport edit mode)  
> **Framework:** Node.js Native Test Runner + `tsx` (`node --import tsx --test`)  
> **Status:** 47 tests PASSING (38 unit + 9 Miniflare integration), `tsc --noEmit` clean

---

## 1. Test Suites (current, verified)

### Booking Engine (`test/booking.test.ts`)
- [x] Payload contains only G0-verified discovery fields (`Command=Next`, no fabricated booking fields).
- [x] Batch parallel dispatch stays Dry-Run only.
- [x] Live booking fails closed while the portal booking path is UNVERIFIED (no network submission, no fabricated reference).

### E2E Workflow (`test/e2e-workflow.test.ts`)
- [x] Onboarding → Dry-Run execution halts before any submission.
- [x] Live execution returns `Booking path UNVERIFIED` with zero network calls to the portal.
- [x] Dashboard HTML serves without unverified latency claims.

### Scheduler (`test/scheduler.test.ts`)
- [x] Cairo time info returns weekday names for display.
- [x] Monday timestamp string matches BMEIA `M/d/yyyy h:mm:ss tt` format.
- [x] Global-window gating: Friday included, inside/outside the 07:00–18:00 Cairo window, 18:00 boundary excluded (D5 amended).
- [x] Scheduled tick exits before any DB read outside the window (proxy-DB discriminating test, `scheduled` level).
- [x] Rolling horizon: `rollingMondays` returns the current week plus 7 forward Mondays (8-week global constant) and crosses year boundaries (AD-11).
- [x] No date-expiry path: `listMondaysInRange` deleted; nothing in the scheduler sets `EXPIRED` (D8).

### Crypto & Masking (`test/crypto.test.ts`)
- [x] AES-256-GCM PII encrypt/decrypt round-trip.
- [x] Passport masking (`A9****32`).

### Backoff & Budget (`test/backoff.test.ts`)
- [x] Exponential backoff delay calculation (2, 4, 8… cap 60 min).
- [x] Circuit breaker trips at 540s (90% of 600s daily browser budget).

### API Contracts (`test/api.test.ts`)
- [x] `GET /api/status` returns operational metrics (mock D1).
- [x] `POST /api/clients` creates encrypted client + job with the complete profile (mock D1).
- [x] `POST /api/clients` returns 400 naming the missing field (new and original required fields), on null bodies and non-string values — nothing written.
- [x] `POST /api/jobs/:id/cancel` marks the job `CANCELLED` + disabled (terminal-state contract).
- [x] `PUT /api/clients/:id` — full-field update with re-encryption (200/400/404); empty passport keeps existing ciphertext; calendar_id follows the category.
- [x] `DELETE /api/clients/:id` — hard delete (200/404), BOOKED guard (403), `CLIENT_DELETED` audit row written.
- [x] `GET /api/clients` returns email/phone/passportExpiry for edit prefill; passport stays masked-only.
- [x] Admin HTML carries the 9 new profile fields + global-rules block + cancel action, and no per-client schedule controls.
- [x] `GET /` serves the Arabic admin dashboard (mock env).
- [x] Dashboard: Bootstrap RTL CSS (SRI-pinned), Alexandria font, dark theme, skeleton + empty states, edit/delete affordances with native confirm(), no alert()-based form errors.

### Miniflare Integration (`test/integration.miniflare.test.ts` — added 2026-08-19)
- [x] Client creation encrypts PII at rest in real D1 and returns masked data on read.
- [x] New profile fields stored encrypted per class (family name at birth, street, postal code, city) and plaintext per class (place of birth, passport issue date) — verified against real D1 rows.
- [x] Legacy job columns written once with global constants (07:00/18:00, all 7 days).
- [x] Missing `PII_ENCRYPTION_KEY` fails closed with 500 (POST and GET).
- [x] Scheduler pick query returns oldest-outstanding jobs, excludes backoff jobs, and never selects the legacy per-client date columns (AD-7 fairness + D8/AD-11).
- [x] Durable Object lock lifecycle (acquire, reject, release, seal).
- [x] Stale lock (crashed execution) expires and allows takeover after TTL.
- [x] `PUT /api/clients/:id` round-trip in real D1: re-encryption, category→calendar recompute, empty-passport keeps ciphertext, job untouched.
- [x] `DELETE /api/clients/:id` in real D1: client + job cascade, `CLIENT_DELETED` audit row with the deleted id.
- [x] `DELETE /api/clients/:id` returns 403 for a BOOKED job (rows remain).
- [x] `DELETE /api/clients/:id` FK-detach regression: succeeds even when scheduler audit rows reference the client — those rows survive with `client_id`/`job_id` NULL (fix 3e0fe0b; D1 enforces FKs).

---

## 2. Explicitly NOT covered yet (and why)

| Area | Reason |
|------|--------|
| Live portal booking submission | Booking path UNVERIFIED — fail-closed by design until first-slot capture (G0 spec section 8) |
| `dispatchScheduled` Cron-path integration | Miniflare 3.20250718.3 has no `dispatchScheduled`; window gating is covered by pure-function unit tests + the live production tick |
| Playwright form-fill against live slots | Requires an actual appearing slot; captured per `portal-automation-spec.md` section 8 plan |
| Auth (Cloudflare Access) | ✅ Enabled 2026-08-20 — whole hostname (dashboard + API) behind the Access login; cron unaffected. Remaining hardening is optional (CORS pinning, PBKDF2 key reuse) — see `docs/implementation-artifacts/deferred-work.md` |

---

## 3. Execution Benchmark (latest run)

```text
ℹ tests 47
ℹ pass 47
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
