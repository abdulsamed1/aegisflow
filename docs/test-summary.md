# QA Test Automation Summary — opran-booking

> **Generated:** 2026-08-20 (updated after the global-window decisions D5/D8 + AD-11)  
> **Framework:** Node.js Native Test Runner + `tsx` (`node --import tsx --test`)  
> **Status:** 20 tests PASSING (15 unit + 5 Miniflare integration), `tsc --noEmit` clean

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
- [x] Week-range scan helper returns Mondays inside a given window. *(Being replaced — see below: the 2026-08-20 decisions remove per-client date windows.)*

> **2026-08-20 decisions (D5 amended, D8, AD-11) — pending test updates (land with the refactor):**
> - [ ] Global-window gating: tick inside 07:00–18:00 Cairo proceeds; outside exits immediately (pure function tested directly, every day incl. Friday).
> - [ ] Rolling horizon: current week + 7 forward Mondays (8-week global constant) — replaces the legacy week-range test.
> - [ ] No date-expiry: nothing in the scheduler sets `EXPIRED` (D8).

### Crypto & Masking (`test/crypto.test.ts`)
- [x] AES-256-GCM PII encrypt/decrypt round-trip.
- [x] Passport masking (`A9****32`).

### Backoff & Budget (`test/backoff.test.ts`)
- [x] Exponential backoff delay calculation (2, 4, 8… cap 60 min).
- [x] Circuit breaker trips at 540s (90% of 600s daily browser budget).

### API Contracts (`test/api.test.ts`)
- [x] `GET /api/status` returns operational metrics (mock D1).
- [x] `POST /api/clients` creates encrypted client + job (mock D1).
- [x] `GET /` serves the Arabic admin dashboard (mock env).

### Miniflare Integration (`test/integration.miniflare.test.ts` — added 2026-08-19)
- [x] Client creation encrypts PII at rest in real D1 and returns masked data on read.
- [x] Missing `PII_ENCRYPTION_KEY` fails closed with 500 (POST and GET).
- [x] Scheduler pick query returns oldest-outstanding jobs and excludes backoff jobs (AD-7 fairness).
- [x] Durable Object lock lifecycle (acquire, reject, release, seal).
- [x] Stale lock (crashed execution) expires and allows takeover after TTL.

> **2026-08-20 decisions — pending integration-test updates (land with the refactor):**
> - [ ] New client fields (birth, address, passport-issue) encrypt at rest per the field-class convention.
> - [ ] Job creation writes the global-constant legacy columns (window 07:00–18:00, all days, 8-week horizon) and the scheduler no longer reads them.

---

## 2. Explicitly NOT covered yet (and why)

| Area | Reason |
|------|--------|
| Live portal booking submission | Booking path UNVERIFIED — fail-closed by design until first-slot capture (G0 spec section 8) |
| `dispatchScheduled` Cron-path integration | Miniflare 3.20250718.3 has no `dispatchScheduled`; window gating is covered by pure-function unit tests + the live production tick |
| Playwright form-fill against live slots | Requires an actual appearing slot; captured per `portal-automation-spec.md` section 8 plan |
| Auth (Cloudflare Access) | Operator action pending — dashboard currently unauthenticated — P0 action item (Todo.md (أ)) |

---

## 3. Execution Benchmark (latest run)

```text
ℹ tests 20
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
