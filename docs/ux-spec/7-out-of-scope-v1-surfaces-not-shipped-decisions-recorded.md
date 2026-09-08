# 7. Out of Scope (v1 surfaces not shipped, decisions recorded)

| v1 item | Status | Reference |
|---|---|---|
| Live Audit Log tab | **Shipped 2026-09-08 (v7)** — audit ledger tile reuses `GET /api/logs` with client-side type/search filter; no new endpoint | `docs/prd.md` FR-8, FR-10 |
| System Config tab | Not shipped — config is env/secrets (`wrangler.toml`, `.dev.vars`, worker secrets) | — |
| Toast notifications | **Shipped 2026-09-08 (v7)** — success/error slips, auto-dismiss, `aria-live`; replace silent catches and delete `alert()` | — |
| Budget gauge | Not shipped — browser budget is NFR, surfaced via Telegram alerts (FR-9), not UI | `docs/prd.md` NFR-2 |
| Filter pills / context menus | Not shipped — 5-column table with row actions at ≤ 10 clients (D2 scale) | `docs/prd.md` D2 |
| Telegram success alerts | Shipped in code path, not in this dashboard's UI scope | `docs/prd.md` FR-9 |