# 4. Micro-Interactions & Feedback (shipped set)

1. **Hover/active:** background shift on hover for cards/rows; `scale(0.98)` on button press — 200–300ms, transform-only.
2. **Focus:** visible red border (`border-color: var(--primary)`) on all buttons, inputs, selects — never `box-shadow: none` + nothing.
3. **Staggered reveal:** metric cards rise in on first load (0.06s cascade).
4. **Skeleton shimmer** while the table loads; **composed empty state** with CTA when there are no clients.
5. **Inline form errors** — server 400s land in a custom `alert-danger` box inside the modal (no `window.alert()` on forms).
6. **Delete guard** — native `confirm()` before delete; **known-minor:** if the DELETE itself fails (non-4xx/400), the error surfaces via `alert()` — deliberate trade-off, not shipped with a fancier toast (this was tracked in `docs/implementation-artifacts/deferred-work.md`, since removed; deferral list now lives in `Todo.md`).
7. **Auto-refresh:** dashboard reloads every 10s (`setInterval(loadDashboard, 10000)`) — near-real-time state without a socket layer.

Not shipped (v1 aspirational items removed): toasts, budget gauge, filter pills, context menus, audit-log live feed.

---
