# T — Track (Current Progress)

| Phase | Status | Details |
|---|---|---|
| Portal contract (G0 — discovery) | ✅ Done | `POST /HomeWeb/Scheduler` verified with live sessions, target calendar ID `44281520` (Bachelor MVP; repaired scanner contract for `message-error` vs `SLOTS`), ~270ms avg — `docs/portal-automation-spec.md` |
| Availability scanner | ✅ 2026-08-20 | Rolling 8-week horizon (`rollingMondays`) per job — D5 decision implemented & tested |
| Scheduler | ✅ 2026-08-20 | **D5 amended:** Global window 07:00–18:00 Cairo daily (incl. Friday) — exits before DB read, unit-tested |
| Job lifetime | ✅ 2026-08-20 | **D8:** No `EXPIRED` path; legacy columns written with global constants, never read by scheduler |
| Client model | ✅ CRUD + validation 2026-08-22 | Create/update/delete + prefill fields + BOOKED lock + **Bachelor-only category constraint & repaired scanner** — 117/117 tests |
| Live schema check (LONDON stage) | ✅ 2026-08-21 | Verified `MM/DD/YYYY` date format, split ZIP/City fields, English CAPTCHA |
| Docs sync | ✅ 2026-08-21 | `docs/prd.md`, `architecture.md`, `ux-spec.md`, `epics-and-stories.md` — fully aligned |
| API validation hardening | ✅ 2026-08-21 | Strict `category` check for POST/PUT to prevent 500s |
| Durable Object lock | ✅ Done & tested | 5-min TTL + `release` / `seal` (BOOKED ⇒ sealed) |
| Encryption & masking | ✅ Done & optimized | AES-256-GCM + PBKDF2 — in-memory key cache, 87× faster bulk decrypt |
| Telegram notifications | ✅ Code done | Not active yet — secrets missing |
| Operator panel (Arabic) | ✅ v6 Paper Dossier | Implemented `src/index.ts:690` `getAdminHTML()` |
| Tests | ✅ 63/63 + E2E | Full stack incl. London booking workflow |
| **Phase 1 — Infra** | ✅ Live | See table below |
| **Phase 2 — Security & speed** | ✅ Done | Encryption, auth, `Promise.all` parallelization, `ctx.waitUntil` background flush |
| **Live monitor** | 🔄 Live (07:00–18:00) | `https://opran-booking.maakebda.workers.dev` — deploy `7bc0cbb8` 2026-08-21 |
| Direct booking engine | ✅ 2026-08-21 | `executeDirectHttpBooking` + `executePlaywrightFallback` — full booking + `GESX-...` ref extraction |
| Panel auth (Cloudflare Access) | ✅ 2026-08-20 | Whole domain behind login (panel + API) — cron unaffected |
| Worker auth (`ADMIN_API_KEY`) | ✅ 2026-08-21 | `openssl rand -base64 32` → `wrangler secret put` + `wrangler deploy` — was `500` → now `401` w/o key, `200` w/ key |
| **Auth hardening (OWASP A07)** | ✅ 2026-08-21 | Keyed-hash session cookie (`__Host-`, never raw key) · constant-time `safeEqual` · `?token=` removed · `POST /logout` · `Cache-Control: no-store` + CSP/nosniff/referrer headers · deploy `d2871709` |
| Dual protection (Access + Worker) | ⚠️ Needs decision (see O) | `curl /api/status` returns `302 -> cloudflareaccess.com` before Worker — needs Service Token |
| Legal authorization | ✅ D7 2026-08-19 | "I authorize appointment booking automation via BMEIA platform" — operator scope only, does not close G0 |
| Telegram in system | ❌ Pending | Next phase — secrets missing |

## Deployed infra (Phase 1)

| Resource | ID / URL | Status |
|---|---|---|
| Account | `b3f785c015c3e0fbbac7af497d188022` (maakebda@gmail.com) | ✅ |
| Worker | `opran-booking` — https://opran-booking.maakebda.workers.dev | ✅ Live |
| D1 | `opran-booking-db` — `d4a096e4-dc38-4c21-9c42-31678abf1672` — 4 tables + 2 indexes — **migration 0001 applied 2026-08-20 (clients = 23 cols)** | ✅ |
| KV | `opran_booking_sessions` — `3740afe9c52b4111854321c0b014f1bb` | ✅ |
| Durable Object | `JOB_LOCK` → `JobLockDO` (SQLite — Free plan requirement) | ✅ |
| Browser binding | `MYBROWSER` | ✅ |
| Cron | `* * * * *` | ✅ |
| Smart Placement | Enabled — `cf-placement: local-MRS` | ✅ |
| Live checks | `/api/status` (with `X-API-Key`) → 200 · `/api/clients` → `[]` · `GET /` (browser) → Paper Dossier panel | ✅ 2026-08-21 |
| `DRY_RUN` | ❌ Removed 2026-08-21 | `wrangler.toml` var + `Env.DRY_RUN` + `dryRun` flag + `DRY_RUN_STOPPED` event removed — live booking only |
| `PII_ENCRYPTION_KEY` | Set via `wrangler secret put` (never displayed) | ✅ — `/api/clients` now `[]` not `500` |
| `ADMIN_API_KEY` | Set 2026-08-21 via `wrangler secret put` + `deploy` (in `secret list`) | ✅ — `src/index.ts:54` no longer returns `500` |

> **Diagnosis 2026-08-21:** Frontend error `{"error":"ADMIN_API_KEY not configured in production"}` came from `src/index.ts:54-59` — `ENVIRONMENT=production` in `wrangler.toml:12` with no secret. Fixed by generating secret and redeploying. Second layer remains: `curl` returns `302` from Cloudflare Access before Worker — needs Service Token for API (see O).

## Phase 2 summary (+ 2 prod bugs found by integration tests and fixed)

| Item | Result |
|---|---|
| D7 (operator authorization) | Documented in `docs/product-breif.ar.md` §4 + `docs/prd.md` (D1–D8) + `docs/portal-automation-spec.md` §9 |
| `PII_ENCRYPTION_KEY` | Generated securely (`openssl rand -base64 32` → `wrangler secret put`) and live-verified: `/api/clients` 500 → `[]` |
| Safe close without key | Integration test: POST/GET `/api/clients` → 500 with clear message |
| **Bug 1 — scheduler:** | `SELECT jobs.*, clients.*` (`id` collision) made `job.id` = *client* ID — all scheduler updates hit wrong row. Fixed: explicit columns in `SCHEDULER_PICK_QUERY` imported from `src/scheduler.ts` |
| **Bug 2 — create:** | `INSERT INTO clients` had 12 cols vs 11 `?` — `POST /api/clients` always failed. Fixed in `src/index.ts` |
| Integration tests (5) | Create → encrypt in D1 → mask in GET · safe close · scheduler fairness (oldest `last_check` first, exclude backoff) · DO lock cycle · expired lock takeover (real SQLite file) |
| Env limitation | Miniflare 3.20250718.3 does not support `dispatchScheduled` + Browser binding — scheduler live path still covered by unit + live prod check |

---
