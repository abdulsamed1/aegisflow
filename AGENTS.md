# AGENTS.md — aegisflow operator rules (written 2026-09-08 after the rename incident)

Read this before touching bindings, secrets, the dashboard, or D1. Every rule
below cost a production outage to learn.

## 1. Cloudflare names: labels are NOT identity

- `wrangler.toml` `database_name`, KV titles, DO namespace names, the Access
  team slug (`...cloudflareaccess.com`) are **birth names / display labels**.
  Bindings resolve by **ID** (`database_id`, KV `id`, DO `namespace_id`).
- NEVER "rename" a resource by editing the label and expecting the remote to
  follow. `wrangler d1 list` / dashboard is truth; the toml label must match it.
- NEVER recreate a KV/DO/D1 just to fix a stale name — you orphan live state
  (locks, sessions, rows). Stale names (`opran-booking-db`,
  `opran-booking_JobLockDO`) are cosmetic. Leave them.

## 2. Renaming / recreating a Worker orphans its secrets

- Changing `name` in `wrangler.toml` creates a **new** Worker; the old one is
  orphaned, NOT renamed. Secrets are per-Worker.
- Proven 2026-09-08: all CLI secret puts targeted worker `opran-booking`
  (see `~/.config/.wrangler/logs/*secret*`); live worker `aegisflow` got a
  separately-set `PII_ENCRYPTION_KEY`. Result: one client's AES-GCM ciphertext
  became undecryptable → `GET /api/clients` 500'd the **entire ledger** every 10s.
- After ANY rename/recreation: verify the live secret decrypts existing rows
  before deleting the old worker. Secrets are **unviewable** after creation —
  record values in a password manager at creation time.

## 3. Dashboard inline JS: the template-literal trap

- `getAdminHTML()` (`src/index.ts`) is a backtick template. `\'` inside it
  collapses to `'` in the served page → browser `SyntaxError` kills the WHOLE
  `<script>` (zero fetches fire, page sits on skeletons forever). `tsc` cannot
  see this; only a browser or a parse check can.
- NEVER write `\'` in dashboard JS. Build quoted strings by concatenation.
- After ANY dashboard edit, ALL of these must pass:
  1. `npm run typecheck`
  2. `npm test` (includes the `vm.Script` parse test in `test/api.test.ts` —
     renders `/` and parses the served script; it caught this exact bug class)
  3. `node --check` on the rendered inline script (see `/tmp/opencode/extract.mjs` pattern)
  4. Scan the template region for bare `${` (every client-side interpolation
     must be `\${`): any bare one 500s `/` at render time.

## 4. Fetch errors must surface the server's message

- NEVER `await res.json()` without an `res.ok` check — a 500 body parses fine
  as JSON and the UI then dies later with a cryptic `X.map is not a function`,
  hiding the real cause. Use the `fetchJSON()` helper (throws
  `HTTP <status>: <server error>`).
- Polling loops (10s tick) must use deduped toasts (see `toast(msg, kind, key)`),
  or one persistent failure spams the operator forever.

## 5. Workers Free CPU budget: 10ms kills full-table scans

- Measured 2026-09-08: `/api/daily-report` over ~10k `audit_logs` rows cost
  **~2.6s CPU** (per-row `toLocaleTimeString` ≈100µs each — it constructs a
  formatter per call — plus 2–3× `JSON.parse` per row, plus per-day
  re-aggregation). The platform kills the isolate → edge **HTTP 503**.
- Rules for any read path: filter in SQL (`NOT IN`, day windows), share
  `Intl.DateTimeFormat` instances module-level (see `cairoTimeFmt`), parse each
  row's `details` once, skip noise rows before parse/format, merge sorted
  inputs instead of re-sorting. Re-benchmark with the 10k-row mix
  (`/tmp/opencode/bench*.mjs` pattern) before shipping report-path changes.
- Endpoint behavior that must hold: `/api/status`, `/api/logs`, `/api/clients`
  stay failure-independent — one slow/broken endpoint must never blank the rest.

## 6. One bad row must never 500 a whole ledger

- `GET /api/clients` isolates per-row decrypt failures into a flagged
  `{ ..., decryptError: true, maskedPassport: "****" }` row (⚠ pill in UI)
  instead of rejecting `Promise.all`. Same principle applies to any future
  list endpoint: catch per item, flag, keep the array an array.
- A ⚠ `تعذر فك التشفير` row means key mismatch (see §2), NOT corruption until
  proven otherwise: verify SQL works → ciphertext shapes sane (base64, ≥13 raw
  bytes) → secret present → only then conclude mismatch.

## 7. Diagnose from the browser's evidence, not theories

- A HAR with **zero** `/api/*` entries means the script never ran (→ §3), not
  an auth/edge problem. Anonymous-curl 302s to `cloudflareaccess.com` are
  EXPECTED (Access login) — do not chase them.
- `contentscript.js` / `MaxListeners` / `ObjectMultiplex` console lines are
  wallet-extension noise, not app errors.
- Production deploys come from the **GitHub integration**: local changes do
  nothing until pushed. Never assume HEAD == live — check the served bytes
  (HAR, `versions view`) first.

## 8. Destructive D1 ops

- NEVER delete applicant data without explicit operator confirmation of the
  exact scope. Mirror app delete semantics: detach `audit_logs`
  (`client_id/job_id → NULL`) BEFORE deleting jobs/clients (FK safety).
- Report `changes` counts back and sanity-check them (a 17k-row detach is
  expected for a per-minute cron client — but pause and confirm before
  proceeding if a count surprises you).
- Trial-decrypts of prod ciphertext: boolean output ONLY, shred temp files
  immediately after, never print keys or plaintext.

## 9. Session workflow (non-negotiable)

- Systematic debugging: root cause with evidence BEFORE fixes; single
  hypothesis; failing test FIRST (`test/api.test.ts`), then minimal fix.
- Verify every change: `typecheck` + full suite + rendered-output checks above.
- Only commit/push on explicit request. Uncommitted work + what it needs
  (push → GitHub auto-deploy) must be stated at the end of every session.
