# 6. Non-Functional Requirements (NFR)

## NFR-1: Security & Compliance
- **Zero Hardcoded Secrets**: Secrets (`PII_ENCRYPTION_KEY`, `ADMIN_API_KEY`, Telegram Token) stored exclusively in Cloudflare Worker Secrets (`wrangler secret put`); `ENVIRONMENT=production` enforces `500 ADMIN_API_KEY not configured` if missing — set 2026-08-21.
- **Dual-Layer Auth (hardened 2026-08-21):** Layer 1 — Cloudflare Access protects whole domain (edge `302 -> cloudflareaccess.com`, not in `src/index.ts`); Layer 2 — Worker checks `Bearer` / `Basic` (password=`key`) / `X-API-Key` / session cookie `__Host-opran_admin_token` (`HttpOnly; Secure; SameSite=Strict; Max-Age=86400`) — cookie value is a **keyed hash of the key, never the key itself**; all compares **constant-time** (`safeEqual`); `?token=` URL auth removed; `POST /logout` clears the session. Browser panel `getAdminHTML()` is same-origin — all `fetch()` rely on cookies (no `X-API-Key` in JS, verified zero hits). Service Token (`CF-Access-Client-Id/Secret`) is **only for external M2M agents** server-side — never in browser JS/cookie. No custom rate limiter — Access edge + 256-bit key cover brute force (ponytail).
- **Log Masking**: Passport numbers and sensitive phone numbers masked (`XXXXXX1234`) in all application logs.
- **Data Retention**: Client PII automatically purged from D1 30 days post terminal state (`BOOKED`, `CANCELLED`, `EXPIRED`).
- **CORS:** `Allow-Origin: *` is safe (SameSite=Strict cookie never sent cross-site) — pinning deferred (ponytail).

## NFR-2: Cloudflare Free Tier Resource Budgeting
- Max Browser Time: 600 seconds/day. System monitors cumulative daily execution time and auto-trips at 90% (540s) with operator alert.
- Browser Concurrency: Maximum 3 concurrent Playwright browser sessions.
- Launch Throttle: Minimum 20 seconds between browser launches.

## NFR-3: Performance & Latency
- Availability check latency: To beat competing bots, the system employs **Concurrent Multi-Candidate Parallel Fan-Out**. All 8-week horizon scans for all active jobs (up to 24 parallel requests) are dispatched simultaneously via `Promise.all()`.
- Background Telemetry: All database observability operations (`INSERT` to audit_logs, `UPDATE` to daily_metrics) are strictly offloaded to the background using `ctx.waitUntil()`, stripping ~150-300ms from the critical execution path before firing the booking POST.
- Cryptography: PBKDF2 iterations for AES-256-GCM derivation are cached in-memory, accelerating bulk PII decryption by ~87x.

---
