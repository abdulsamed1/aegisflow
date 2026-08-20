# Deferred Work

Findings surfaced by the 2026-08-20 global-rules-refactor review that are real but not caused by that story.

- source_spec: none
  summary: Protect /api/clients GET from unauthenticated exfiltration and per-field PBKDF2 CPU amplification
  evidence: UPDATE 2026-08-20: Cloudflare Access is now enabled on the whole hostname (dashboard + API redirect to the Access login; cron triggers unaffected), so the unauthenticated-exfiltration and anonymous-CPU-amplification halves of this item are mitigated at the edge. What remains inside the authenticated boundary: `Access-Control-Allow-Origin: *` still allows any site the operator is logged into to call the API cross-origin, and each decryptPII re-runs 100k PBKDF2 iterations (now 9 fields incl. address). Optional hardening: derive the CryptoKey once per request (src/crypto.ts) and/or pin CORS to the dashboard origin. Not blocking.

- source_spec: none
  summary: Throttle per-job-per-week re-scans to cut portal load
  evidence: With the daily 07:00–18:00 window and cron every minute, each ACTIVE job re-scans the same 8 Mondays ~60x/hour until a SLOTS break. The operator chose the window; adding a per-job-week "scanned today" dedup (KV or DB) would cut portal requests meaningfully. Not needed for correctness; revisit when live scanning ramps.

- source_spec: none
  summary: Decide Sunday-week semantics — the horizon's first Monday is in the past on Cairo Sundays
  evidence: `rollingMondays` returns the current week's Monday; on Sunday (and to a lesser degree late-week days) that Monday is elapsed, so the first week scanned can only "succeed" on days already gone. Pre-existing behavior, invisible in DRY-RUN (G0), but must be resolved before live booking: either skip elapsed weeks or start the horizon at the next Monday on Sundays.

- source_spec: none
  summary: Escape interpolated values in the admin dashboard table renderer (XSS hardening)
  evidence: The dashboard builds rows via unescaped `${...}` innerHTML interpolation (first/last name, jobId in inline onclick). Safe today only because job IDs are generated, but any imported/manual row or future free-text rendering would enable stored XSS. Pre-existing pattern, not introduced by the refactor.

- source_spec: none
  summary: Migrate audit_logs FKs to ON DELETE SET NULL
  evidence: 2026-08-20 CRUD workaround: DELETE /api/clients/:id now nulls audit_logs.client_id/job_id before deleting (fix commit 3e0fe0b), because the table's REFERENCES lack an ON DELETE action and scheduler scan rows would block deletes (D1 enforces FKs). The null-then-delete is correct and covered by an integration test, but an operator-gated migration adding ON DELETE SET NULL would make the workaround unnecessary. Revisit at the next schema migration.

- source_spec: none
  summary: Widen the delete/booking state guard beyond BOOKED before live booking
  evidence: The DELETE route guards only BOOKED (403), and cascade-deleting a job mid-flight (ACTIVE/SEARCHING/BOOKING under a DO lock) would strand the lock. Safe today: single operator behind Access + booking path UNVERIFIED. Revisit before G0 closes: guard all mid-flight states and coordinate with the DO lock.
