# QA Test Automation Summary — opran-booking

> **Generated:** 2026-08-19 (updated after G0-gating review)  
> **Framework:** Node.js Native Test Runner + `tsx` (`node --import tsx --test`)  
> **Status:** 15 tests PASSING, `tsc --noEmit` clean

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
- [x] Cairo time info returns weekday names for display (24/7 scanning — no window gate, per decision D5).
- [x] Monday timestamp string matches BMEIA `M/d/yyyy h:mm:ss tt` format.
- [x] Week-range scan respects the client's accepted date window (no scans past `end_date`).

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

---

## 2. Explicitly NOT covered yet (and why)

| Area | Reason |
|------|--------|
| Live portal booking submission | Booking path UNVERIFIED — fail-closed by design until first-slot capture (G0 spec section 8) |
| Real D1/KV/DO integration | Unit-level mock env only; integration tests with Miniflare (local) are the next step after schema migration runs |
| Playwright form-fill against live slots | Requires an actual appearing slot; captured per `portal-automation-spec.md` section 8 plan |
| Auth (Cloudflare Access) | Decision pending in PRD; dashboard currently unauthenticated — P0 action item |

---

## 3. Execution Benchmark (latest run)

```text
ℹ tests 15
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms ~525ms
```
