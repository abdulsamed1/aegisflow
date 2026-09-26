# 6. Non-Functional Requirements (NFR)

## NFR-1: Security & Compliance
- **Zero Hardcoded Secrets**: Secrets (`PII_ENCRYPTION_KEY`, `ADMIN_API_KEY`, Telegram Token) stored exclusively in Cloudflare Worker Secrets (`wrangler secret put`); `ENVIRONMENT=production` enforces `500 ADMIN_API_KEY not configured` if missing — set 2026-08-21.
- **Dual-Layer Auth (hardened 2026-08-21):** Layer 1 — Cloudflare Access protects whole domain (edge `302 -> cloudflareaccess.com`, not in `src/index.ts`); Layer 2 — Worker checks `Bearer` / `Basic` (password=`key`) / `X-API-Key` / session cookie `__Host-aegisflow_admin_token` (`HttpOnly; Secure; SameSite=Strict; Max-Age=86400`) — cookie value is a **keyed hash of the key, never the key itself**; all compares **constant-time** (`safeEqual`); `?token=` URL auth removed; `POST /logout` clears the session. Browser panel `getAdminHTML()` is same-origin — all `fetch()` rely on cookies (no `X-API-Key` in JS, verified zero hits). Service Token (`CF-Access-Client-Id/Secret`) is **only for external M2M agents** server-side — never in browser JS/cookie. No custom rate limiter — Access edge + 256-bit key cover brute force ().
- **Log Masking**: Passport numbers and sensitive phone numbers masked (`XXXXXX1234`) in all application logs.
- **Data Retention**: Client PII automatically purged from D1 30 days post terminal state (`BOOKED`, `CANCELLED`, `EXPIRED`).
- **CORS:** `Allow-Origin: *` is safe (SameSite=Strict cookie never sent cross-site) — pinning deferred ().

## NFR-2: Cloudflare Free Tier Resource Budgeting
- Max Browser Time: 600 seconds/day. System monitors cumulative daily execution time and auto-trips at 90% (540s) with operator alert.
- Browser Concurrency: Maximum 3 concurrent browser sessions (puppeteer workers path, since the 2026-09-11 `@cloudflare/playwright` → `@cloudflare/puppeteer` migration).
- Launch Throttle: Minimum 20 seconds between browser launches, enforced via module-level sequential FIFO promise queue (`launchGate`) preventing simultaneous launches on parallel job fan-out. Billed browser seconds exclude this wait (`workStartTime` resets after the gate releases).
- Quota Conservation via Fast-Path: With booking duration reduced to **4–6s per attempt** (down from 40s+), the 600-second daily budget accommodates 100+ booking runs without premature exhaustion or HTTP 429 rate limits.

## NFR-3: Performance & Latency
- Availability check latency: Multi-week concurrent scan covers the 8-week rolling horizon in parallel via `Promise.all()`.
- Initial Navigation & Cookie Negotiation: Pre-seeded cookies (`AspxAutoDetectCookieSupport=1` & `ASP.NET_SessionId`) and direct form POST to `/HomeWeb/Scheduler` reach the week grid in **~1.2s**, eliminating 15s–30s of ASP.NET 302 redirect roundtrips under high load.
- In-Browser Slot Selection: A single in-browser `page.evaluate()` call inspects and checks target week slot radios in the DOM in 0.1ms, eliminating 20–40 sequential CDP WebSocket roundtrips over the network (~2s saved).
- Audio CAPTCHA Processing: Workers AI Whisper pipeline (`tiny-en` short-circuiting in ~300ms, fallback to `large-v3-turbo`) with an `AbortController` 6-second timeout ensures fast, hang-free CAPTCHA resolution.
- Background Telemetry: All database observability operations (`INSERT` to audit_logs, `UPDATE` to daily_metrics) are strictly offloaded to the background using `ctx.waitUntil()`, stripping ~150-300ms from the critical execution path before firing the booking POST.
- Cryptography: PBKDF2 iterations for AES-256-GCM derivation are cached in-memory, accelerating bulk PII decryption by ~87x.

---
