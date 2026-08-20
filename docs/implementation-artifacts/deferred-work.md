# Deferred Work

Findings surfaced by the 2026-08-20 global-rules-refactor review that are real but not caused by that story.

- source_spec: none
  summary: Protect /api/clients GET from unauthenticated CORS-open exfiltration and per-field PBKDF2 CPU amplification
  evidence: The endpoint decrypts full PII (now 9 fields incl. address) with `Access-Control-Allow-Origin: *` and no auth; each decryptPII re-runs 100k PBKDF2 iterations, so any site open in the operator's browser can fetch decrypted passports/addresses and hammer CPU. Blocked on the operator's Access-app click (Todo.md item 2, "(أ)"); the established fix is the Access app + `ALLOWED_ORIGINS` gate per AGENTS.md env patterns, optionally deriving the CryptoKey once per request (src/crypto.ts).

- source_spec: none
  summary: Throttle per-job-per-week re-scans to cut portal load
  evidence: With the daily 07:00–18:00 window and cron every minute, each ACTIVE job re-scans the same 8 Mondays ~60x/hour until a SLOTS break. The operator chose the window; adding a per-job-week "scanned today" dedup (KV or DB) would cut portal requests meaningfully. Not needed for correctness; revisit when live scanning ramps.

- source_spec: none
  summary: Decide Sunday-week semantics — the horizon's first Monday is in the past on Cairo Sundays
  evidence: `rollingMondays` returns the current week's Monday; on Sunday (and to a lesser degree late-week days) that Monday is elapsed, so the first week scanned can only "succeed" on days already gone. Pre-existing behavior, invisible in DRY-RUN (G0), but must be resolved before live booking: either skip elapsed weeks or start the horizon at the next Monday on Sundays.

- source_spec: none
  summary: Escape interpolated values in the admin dashboard table renderer (XSS hardening)
  evidence: The dashboard builds rows via unescaped `${...}` innerHTML interpolation (first/last name, jobId in inline onclick). Safe today only because job IDs are generated, but any imported/manual row or future free-text rendering would enable stored XSS. Pre-existing pattern, not introduced by the refactor.
