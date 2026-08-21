# 5. Security Architecture & Encryption Details

## 5.1 AES-256-GCM Encryption Helper Specification
- **Algorithm**: `AES-GCM` with 256-bit key length.
- **Initialization Vector (IV)**: 12-byte cryptographically secure random IV generated per encryption operation.
- **Storage Format**: Ciphertext formatted as `base64(IV + Ciphertext + Tag)`.
- **Key Source**: Loaded from `env.PII_ENCRYPTION_KEY` at runtime using Web Crypto API (`crypto.subtle`).

## 5.2 Dual-Layer Authentication — Audited 2026-08-21 (src/index.ts:36-125)

**Layer 1 — Cloudflare Access (Edge, outside Worker code):**
- Protects the **whole Worker domain** (`opran-booking.maakebda.workers.dev`, path `/*`) — verified live `302 -> cloudflareaccess.com` for both `GET /` and `GET /api/*`. Not referenced in `src/index.ts` (zero `CF-Access-*` hits).
- Browser flow: `GET /` → `302` to `cloudflareaccess.com/login` → OTP → sets `CF_Authorization`/`CF_AppSession` (HttpOnly, edge-only) → request reaches Worker.
- Cron `scheduled()` `src/index.ts:473` is **not** affected — it never passes through `fetch()` auth.

**Layer 2 — Worker `ADMIN_API_KEY` (src/index.ts:54-125):**
- Secret binding `Env.ADMIN_API_KEY` `src/index.ts:21`; `wrangler.toml:12` `ENVIRONMENT=production` triggers `500 ADMIN_API_KEY not configured` `src/index.ts:54-59` if missing — now set 2026-08-21 via `wrangler secret put` + `deploy 7bc0cbb8`.
- All routes under `if (env.ADMIN_API_KEY)` `src/index.ts:61` require one of: `Authorization: Bearer <key>` `67`, `Authorization: Basic` (password=`key`) `69-74`, `X-API-Key: <key>` `80`, `?token=<key>` or `Cookie: opran_admin_token=<key>` `85-93`.
- Panel bootstrap: `GET /?token=<key>` `114-122` → `302` + `Set-Cookie: opran_admin_token=<key>; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict` `119`. Browser then sends that cookie automatically on same-origin `fetch()`.

**Same-origin panel model (src/index.ts:690 getAdminHTML):**
- Frontend is **inside the Worker** — no separate SPA build. All `fetch()` calls `1134,1140,1172,1190,1196` (`/api/status`, `/api/clients`, `/api/jobs/*`, `/api/logs`) are **bare same-origin** with **no** `X-API-Key`/`CF-Access-*` headers — they rely on cookies (`CF_Authorization` + `opran_admin_token`) sent automatically. Verified by grep: zero auth headers in `getAdminHTML()`.
- `ADMIN_API_KEY` is **never embedded** in HTML/JS literals; `opran_admin_token` cookie value equals the key (hence `HttpOnly`).

**Service Token scope (audited):**
- **Not required for browser UI** — same-origin + cookie already satisfies both layers. Service Token (`CF-Access-Client-Id`/`Secret`) is for **external machine-to-machine callers only** (monitoring, CI, backend proxy) that cannot do interactive Access login. Must be sent server-side, never in `getAdminHTML()` JS (would expose secret).
- Correct Access config: keep whole-domain `Allow` (operator email); if M2M needed, **add** a second application scoped to `Path: /api/*` with action **`Service Auth`** (allow token) — never `Bypass`. No Worker code change needed for M2M (agent adds two headers server-side).

**CORS:** `src/index.ts:42-45` currently `Allow-Origin: *` + `Allow-Headers: Content-Type` only — deferred hardening to pin to panel origin (Todo.md).

---
