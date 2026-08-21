# 7. Out of Scope (v1 surfaces not shipped, decisions recorded)

| v1 item | Status | Reference |
|---|---|---|
| Live Audit Log tab | Not shipped — audit data stays in D1 (`audit_logs`); no viewer UI yet | `docs/prd.md` FR-8, FR-10 (viewer listed as future) |
| System Config tab | Not shipped — config is env/secrets (`wrangler.toml`, `.dev.vars`, worker secrets) | — |
| Toast notifications | Not shipped — inline errors + reload suffice at this scale | — |
| Budget gauge | Not shipped — browser budget is NFR, surfaced via Telegram alerts (FR-9), not UI | `docs/prd.md` NFR-2 |
| Filter pills / context menus | Not shipped — 5-column table with row actions at ≤ 10 clients (D2 scale) | `docs/prd.md` D2 |
| Telegram success alerts | Shipped in code path, not in this dashboard's UI scope | `docs/prd.md` FR-9 |