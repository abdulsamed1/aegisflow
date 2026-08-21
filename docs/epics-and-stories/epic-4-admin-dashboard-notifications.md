# Epic 4: Admin Dashboard & Notifications

## Story 4.1: Single Operator SPA Admin Panel
- **As an** Operator,  
- **I want a** premium navy dashboard displaying active jobs, status badges, metrics, and modal forms,  
- **So that** I can monitor and control all automation jobs effortlessly.

> **2026-08-20 amendment (superseded same day):** the shipped dashboard was the premium redesign (`docs/implementation-artifacts/spec-spa-crud-premium-ui.md`, removed with the artifacts dir) — off-black navy palette, Bootstrap 5.3 RTL (CSS-only, SRI-pinned), Alexandria typeface, skeleton/empty/inline-error states — superseding the earlier "dark glassmorphism" direction. Superseded by the v6 Paper Dossier flip (see below).
>
> **2026-08-20 amendment (current):** the shipped dashboard is **v6 Paper Dossier** (light editorial, `docs/ux-spec.md`, code: `src/index.ts` `getAdminHTML`) — parchment canvas, paper cards, burnt-red accent, **hand-rolled CSS, no Bootstrap, no framework stylesheet**, Alexandria the only font request, same DOM/JS. Per operator request the same day: the header brand group and footer system line were removed (header holds only the `+ إضافة مرشح جديد` CTA), and the live Cairo-time metric card (`window-tag`/`val-cairo`) was removed — the global 07:00–18:00 window still governs scheduling server-side.

### Acceptance Criteria:
1. Header hosts the single primary CTA (`+ إضافة مرشح جديد`); the v1 budget gauge, Cairo clock, and DRY-RUN status banner are **not shipped/removed** — budget is an NFR surfaced via Telegram (FR-9), the global Cairo window is server-side; `DRY_RUN` retired 2026-08-21 (live booking only).
2. Client table lists all candidates with status pills and action toggles (Activate/Pause/Cancel — cancel added per D8, 2026-08-20; **Edit/Delete added per the CRUD story, same day**). All row `fetch()` `src/index.ts:1134,1140,1172,1190,1196` are same-origin with cookie auth — no `X-API-Key` in JS (audited 2026-08-21).
3. Responsive SPA (embedded in Worker `getAdminHTML()`, not separate Static Assets) loads in under 1 second; auth is Access edge `302` + Worker `__Host-opran_admin_token` session cookie (keyed hash, `Secure; HttpOnly; SameSite=Strict`) — Service Token only for external M2M, never for panel.

---

## Story 4.2: Telegram Notification Service
- **As an** Operator,  
- **I want to** receive instant Telegram notifications for successful bookings and critical errors,  
- **So that** I am alerted immediately when an appointment is secured.

### Acceptance Criteria:
1. Telegram Bot API sends rich formatted markdown message on `BOOKED` status with candidate name, date, time, reference ID, and screenshot link.
2. Alert sent on critical budget warnings (≥90% browser budget used).
