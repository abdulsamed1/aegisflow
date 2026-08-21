# 3. Status Presentation

Shipped pill set — two variants only, deliberately:

| Pill | Class | Shown for |
|---|---|---|
| «متوقف ⏸» | `status-paused` — **ink stamp** pill (`--text` ink text, `--border-strong` outline) | job `enabled=0`, status not terminal |
| «نشط ⚡» | `status-active` — **solid red stamp** (bg `--primary`, text `--primary-ink` paper) | job `enabled=1`, status not terminal |
| «تم الحجز ✅» | `status-active` — solid red stamp | `BOOKED` — terminal |
| «ملغي 🚫» | `status-paused` — ink stamp pill | `CANCELLED` — terminal |

The v1 12-states-of-the-state-machine badge matrix (colors/icons per `DRAFT`…`EXPIRED`) is **not shipped**: the dashboard collapses behavior to the four operator-meaningful conditions. Internal scheduler states (`ACTIVE`, `SEARCHING`, `BOOKING`…) remain in the domain model (see `docs/prd.md` §4) but are not rendered as per-state visuals.

---
