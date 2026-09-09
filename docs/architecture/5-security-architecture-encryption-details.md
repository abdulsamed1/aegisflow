# 5. Security Architecture & Encryption Details

## 5.1 AES-256-GCM Encryption Helper Specification
- **Algorithm**: `AES-GCM` with 256-bit key length.
- **Initialization Vector (IV)**: 12-byte cryptographically secure random IV generated per encryption operation.
- **Storage Format**: Ciphertext formatted as `base64(IV + Ciphertext + Tag)`.
- **Key Source**: Loaded from `env.PII_ENCRYPTION_KEY` at runtime using Web Crypto API (`crypto.subtle`).

## 5.2 Dual-Layer Authentication — Audited 2026-08-21, Hardened 2026-08-21 (src/index.ts:36-124)

**Layer 1 — Cloudflare Access (Edge, outside Worker code):**
- Protects the **whole Worker domain** (`aegisflow.maakebda.workers.dev`, path `/*`) — verified live `302 -> cloudflareaccess.com` for both `GET /` and `GET /api/*`. Not referenced in `src/index.ts` (zero `CF-Access-*` hits).
- Browser flow: `GET /` → `302` to `cloudflareaccess.com/login` → OTP → sets `CF_Authorization`/`CF_AppSession` (HttpOnly, edge-only) → request reaches Worker.
- Cron `scheduled()` is **not** affected — it never passes through `fetch()` auth.

**Layer 2 — Worker `ADMIN_API_KEY` (src/index.ts:52-124):**
- Secret binding `Env.ADMIN_API_KEY`; `ENVIRONMENT=production` triggers `500 ADMIN_API_KEY not configured` if missing — set 2026-08-21 via `wrangler secret put`.
- Accepted credentials (all compared with **constant-time `safeEqual`**): `Authorization: Bearer <key>`, `Authorization: Basic` (password=`key`, username ignored), `X-API-Key: <key>`, or session cookie `__Host-aegisflow_admin_token` (`HttpOnly; Secure; Path=/; Max-Age=86400; SameSite=Strict`).
- **Session cookie hardening 2026-08-21:** cookie value is `base64(SHA-256("aegisflow-session-v1|<key>"))` — a **keyed hash, never the raw key** (cookie leak ≠ master-key leak; rotating `ADMIN_API_KEY` revokes all sessions). `?token=<key>` in URL **removed** (query strings leak into logs/referrers — OWASP skill Step 5). Browser login: native `Basic` dialog on `GET /` → on success the HTML response also sets the session cookie so the panel's same-origin `fetch()` is authenticated. `POST /logout` clears the cookie.
- **No custom rate limiter ():** Layer 1 Access edge (OTP + its own limits) + 256-bit random key make credential-stuffing infeasible.

**Same-origin panel model (src/index.ts getAdminHTML):**
- Frontend is **inside the Worker** — no separate SPA build. All `fetch()` calls are **bare same-origin** with **no** `X-API-Key`/`CF-Access-*` headers — they rely on cookies (`CF_Authorization` + `__Host-aegisflow_admin_token`) sent automatically.
- `ADMIN_API_KEY` is **never embedded** in HTML/JS literals.
- HTML responses ship security headers: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, CSP (`frame-ancestors 'none'`, `base-uri 'none'`, script/style `'unsafe-inline'` for the embedded SPA, Google Fonts allowed); all API responses get `Cache-Control: no-store` (PII).

**Service Token scope (audited):**
- **Not required for browser UI** — same-origin + cookie already satisfies both layers. Service Token (`CF-Access-Client-Id`/`Secret`) is for **external machine-to-machine callers only** (monitoring, CI, backend proxy) that cannot do interactive Access login. Must be sent server-side, never in `getAdminHTML()` JS (would expose secret).
- Correct Access config: keep whole-domain `Allow` (operator email); if M2M needed, **add** a second application scoped to `Path: /api/*` with action **`Service Auth`** (allow token) — never `Bypass`. No Worker code change needed for M2M (agent adds two headers server-side).

**CORS:** `Allow-Origin: *` + `Allow-Headers: Content-Type` only — cookie auth is SameSite=Strict same-origin, so `*` never exposes credentials (deferred pinning to panel origin, ).

---
