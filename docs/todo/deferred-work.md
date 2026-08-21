# Deferred Work

> Moved from `docs/deferred-work.md` (deleted with guides 2026-08-20 — now tracked here). All items are real and unrelated to global window story.

- **CORS hardening:** `Access-Control-Allow-Origin: *` `src/index.ts:43` lets any site the operator visits call API cross-origin; pin to panel origin later.
- **CAPTCHA/vision integration:** ✅ Done 2026-08-21 — 2captcha solver in `src/captcha.ts` (`solveCaptcha`, `CAPTCHA_API_KEY` secret), wired in `src/browser-fallback.ts` wizard (BDC_* hidden + CaptchaText). Remaining: KAIRO confirmation still unverified.
- **Sunday week semantics:** `rollingMondays` returns this week's Monday; on Sunday that Monday is past, so week 1 may only "succeed" on past days. Fix before live booking: skip past weeks or start from next Monday on Sundays.
- **Table XSS escaping:** Rows built via unescaped `${...}` interpolation (name, jobId in onclick) `src/index.ts:1206`. Safe today because job IDs are generated — any imported/manual row or future free-text enables stored XSS.
- **Migrate FKs to `ON DELETE SET NULL`:** Deleting client today nulls `audit_logs.client_id/job_id` first because REFERENCES lack ON DELETE and D1 enforces FKs. Future migration with operator approval makes workaround redundant.
- **Expand delete/booking state guard:** ✅ Done 2026-08-21 — DO `/status` + DELETE 423 when locked/sealed (src/lock.ts, src/index.ts:DELETE).

---
