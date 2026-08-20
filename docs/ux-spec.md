# UX & UI Specification — Single Operator Admin Panel (opran-booking)

> **Status:** FINAL — amended 2026-08-20 to v6: **Paper Dossier — light editorial embassy case-file** (visual source of truth: `docs/implementation-artifacts/spec-spa-crud-premium-ui.md`; direction: operator + redesign audit — v5's near-black template was operator-rejected as generic; code source of truth: `src/index.ts` `getAdminHTML`)
> **Target Device:** Desktop / Tablet responsive (container max-width 1400px; collapses at 768px and 480px)
> **Visual Direction:** Light editorial dossier — warm parchment canvas `#f4efe6`, paper-white cards, ink text, hairline ledger rules, ONE burnt-red accent, Alexandria typeface (still the only font request — JetBrains Mono dropped for a system mono stack), **hand-rolled CSS only — no Bootstrap, no framework CSS, one file, one font request, zero images**. No shadows, no gradients, no grain overlay; depth via paper weave texture (static CSS gradients) + hairlines + alternating ledger rows.

---

## 0. Revision Log

| Date | Change | Driven by |
|---|---|---|
| 2026-08-19 | v1: glassmorphism direction, Cairo font, tabbed layout (Clients / Audit Log / System Config), 12-state badge matrix, toasts, budget gauge | Original design spec |
| 2026-08-20 | v2: **premium redesign shipped** — navy token set, Alexandria typography, Bootstrap RTL CSS, single-view layout (no tabs), skeleton/empty/inline-error states, Edit/Delete CRUD actions, shared add/edit modal with keep-passport flow | Operator + redesign story (`spec-spa-crud-premium-ui.md`); v1-only surfaces (Audit Log tab, System Config tab, toasts, budget gauge, filter pills) are **explicitly not shipped** and out of scope — see §8 |
| 2026-08-20 | v3: **Sentry night + electric lime** — violet-midnight canvas family, one loud lime accent reserved for CTAs/focus/active pills, violet hairlines replace navy, micro-cap metric labels, lime glow on the featured card | Operator redesign decision; inspired by the **Sentry** design.md (discovered via `awesome-design-md`, `designmd.co`, `designmd.app` — purple night `#150f23`/`#1f1633`, hairline `#362d59`, accent `#c2ef4e`) |
| 2026-08-20 | v4: **full hand-rolled redesign — Bootstrap dropped** — custom CSS replaced the Bootstrap RTL CDN entirely (no framework stylesheet, no JS bundle); custom form controls (focus ring in lime, dark selects with SVG chevron), custom modal (raised surface `#241c42`, blur backdrop), brand mark tile, live window pulse dot, footer system line, 14px card radii; same DOM IDs and classes used by the loader JS, so the backend script block is untouched | Operator request: full UI/UX rechange, keep Arabic, fast performance (one fewer 200KB CDN request), keep Sentry-night direction |
| 2026-08-20 | v5: **ClickHouse design system** — Sentry's own design.md was replaced after discovering it was the literal source of the v3/v4 tokens; now grounded in ClickHouse's **official design.md** (`voltagent/awesome-design-md` / `design-md/clickhouse`): near-black flat canvas `#0a0a0a` (no radial tints, no grain overlay), gray surface ladder `#1a1a1a`/`#242424`, hairline borders `#2a2a2a`/`#3a3a3a` replace violet, **all shadows and glows removed** (depth by surface ladder + hairlines only), one electric-yellow accent `#faff69` (hover `#e6eb52`, ink `#0a0a0a`) moved from lime; yellow now carries the featured card (full yellow band, black text, no glow), fastpath badge, active pill, stat numbers, focus borders and live dot; card radii 12px; `--border-accent` → `rgba(250,255,105,.35)`; same DOM IDs/classes/JS — loader script block untouched; **flagged gaps:** Alexandria stands in for the source's Inter (Inter has no Arabic glyphs); JetBrains Mono kept (it IS the source's code family); modal surface/backdrop geometry and row hover lift are ergonomic carryovers not stated in the source | Operator redesign decision; design.md source: **ClickHouse** (Sentry design.md superseded — v3/v4 were literal Sentry tokens) |
| 2026-08-20 | v6: **Paper Dossier — full direction flip to light editorial** — operator rejected v5's near-black + single-yellow as "very basic and generic" (a template look); new direction is an embassy case-file: warm parchment canvas `#f4efe6`, paper surfaces `#fbf8f1`/`#ffffff`, ink text `#23201a`, warm hairline ledger rules, ONE burnt-red accent `#b33a2b`; components re-skinned as dossier artifacts: red seal tile + letterhead header, stamp-style badges/pills (double hairline border), ruled ledger table with alternating row tint, featured metric card as a full burnt-red band (paper text, same DOM); **JetBrains Mono request dropped** — system mono stack + `tabular-nums` (one fewer network request); paper-weave texture via two static CSS repeating-gradients (~2% alpha, GPU-free); `data-theme="night"` → `"paper"`, `color-scheme: dark` → `light` (attribute only — no CSS/JS reads it, test updated); focus = red border only, zero glow; live dot red; same DOM IDs/classes/JS — loader script block untouched; **flagged gaps:** no design.md catalog source maps to this direction (operator-directed), all tokens operator-approved; paper weave substitutes the redesign audit's grain recommendation at zero cost | Operator request: v5 still reads generic/template; performance first — light theme, one font request, zero images |

The v2 changes supersede v1. Anything in v1 not listed in v2 does not exist in the product and must not be re-introduced without a new decision.
The v5 changes supersede the v3/v4 visual direction. Anything in v3/v4 not listed in v5 (violet midnight family, lime accent, radial tints, grain, shadows/glows) does not exist in the product — revitalizing those tokens (or any Sentry design.md token) requires a new operator decision.
The v6 changes supersede the v5 near-black direction. Anything in v3/v4/v5 not listed in v6 (dark canvas family, yellow/lime accents, glow-focused states) does not exist in the product — returning to any dark-canvas token set or the ClickHouse/Sentry design.md tokens requires a new operator decision.

---

## 1. Design System

### 1.1 Color Palette (shipped tokens — `src/index.ts` `:root`, v6 Paper Dossier)

```css
:root {
  /* Backgrounds — warm parchment family, light theme */
  --bg-surface: #f4efe6;        /* canvas: parchment */
  --bg-card: #fbf8f1;           /* surface-card: paper */
  --bg-card-hover: #efe8da;     /* paper in shadow */
  --bg-raised: #ffffff;         /* raised: modal/select surfaces */
  --border: #d8d0bf;            /* hairline: warm ledger rule */
  --border-strong: #b0a48c;     /* hairline-strong: input/modal borders read clearly */
  --border-accent: rgba(179, 58, 43, 0.35);

  /* Accents — ONE loud accent: burnt red, reserved for CTA/seal/badges/featured card */
  --primary: #b33a2b;
  --primary-hover: #992e21;     /* primary-active */
  --primary-ink: #fbf8f1;       /* paper text ON the red */
  --success: #1f7a4d; --warning: #a15c07; --danger: #c0392b;  /* semantic trio darkened for light bg, pills only */

  /* Text */
  --text: #23201a;              /* ink */
  --text-muted: #4a4438;        /* body */
  --text-dim: #8a8170;          /* muted-soft */

  /* Elevation — none. Depth from surface tone + ledger rules; zero drop shadows, zero glow
     (a static paper-weave texture lives on body::before — see 1.4) */
}
```

Rules:
- One loud accent (`--primary` b33a2b burnt red). It appears **only** on primary buttons, the seal tile, focus borders, stamp-style badges/pills, stat numbers, the live dot, and the featured card band — never decoratively. Semantic colors (`success`/`warning`/`danger`) appear **only** on pills (darkened for light-bg contrast).
- Parchment is the only canvas family — a **light** theme; there is no dark mode toggle, no navy default (v2 superseded), no violet-midnight default (v3/v4 superseded), no near-black default (v5 superseded).
- Background atmosphere: `--bg-surface` parchment plus a **paper-weave weave texture**: two static `repeating-linear-gradient` bands (~2% alpha, 45°/135°) on `body::before`, `pointer-events: none`. GPU-free, zero images, no grain overlay, no radial tints.
- **v6: no Bootstrap, no shadows, light theme.** The document root is `lang="ar" dir="rtl" data-theme="paper"`. All components (forms, selects, modal, pills, alerts, table) are hand-rolled custom CSS in the same inline `<style>` block — zero framework stylesheet, zero JS bundle, one font request. Custom form controls: paper surface `#ffffff`, hairline borders, **red focus border only** (no glow ring), custom SVG chevron on selects, `color-scheme: light` for date inputs.

### 1.2 Typography

- **Primary:** `Alexandria` variable (Arabic + Latin, weights 400–800, one Google Fonts request, `display=swap`). Headings/brand 800, labels 600, body 400–500. Fallback stack `system-ui, -apple-system, sans-serif` only behind the webfont.
- **Monospace:** **no webfont — v6 drops the JetBrains Mono request** (one fewer network request): system mono stack `ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace` with `font-variant-numeric: tabular-nums`, `direction: ltr; display: inline-block` — reserved for IDs, masked passport numbers, timestamps, statistics, and error codes.
- No Inter, no Roboto, no Cairo (v1 font, dropped in v2), no JetBrains Mono (dropped in v6).

### 1.3 Layout & Spacing

- Single-view SPA: `header` → metric ribbon → table card → modal. No tabs, no navigation — the operator's whole job is on one screen.
- Container max-width 1400px; body padding 24px (12px below 768px).
- Card radii 12px; pill radii 999px; control (button/input/select) radii 8px; grid gap 16px (10px below 768px).
- Responsive: metrics auto-fit `minmax(240px, 1fr)`; below 768px two columns, below 480px one column; table scrolls horizontally (`min-width: 580px`) with `-webkit-overflow-scrolling: touch`.

### 1.4 Elevation & Shape

- Cards: 1px `--border` hairline on paper surfaces; **no drop shadows** (all v3–v5 shadows removed; light theme needs none — tone + rules carry separation).
- Paper-weave texture: `body::before` carries two static repeating-linear-gradient bands at ~2% alpha — subtle paper fiber, no animation, GPU-free. The one texture on screen.
- The **featured** metric card (active candidates) spans 2 grid columns and is a **full burnt-red band** (`--primary` background, `--primary-ink` paper text) — the red surface IS the signal; no glow, no gradient.

### 1.5 Motion

- Transitions on `transform`/`background-color`/`border-color` only, 200–300ms. No transform on layout properties, no infinite animations except the skeleton shimmer.
- First-load reveal: metric cards stagger in via `rise` keyframe (opacity + 10px translateY, 0.06s cascade, 0.4s each).
- Skeleton rows: 200% background-position shimmer loop (1.2s).
- **`prefers-reduced-motion: reduce` kills all animation and transitions** (`animation: none !important; transition: none !important`).

---

## 2. Screen Specifications

### Screen 1: Header + Metric Ribbon

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│                                                                 [+ إضافة مرشح] │
├────────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────┐ ┌──────────────────────┐ ┌──────────────┐ ┌──────────────┐ │
│ │ المرشحون النشطون (مميز)  │ │ فحوصات اليوم │ │ الحجوزات      │ │
│ │ 3 / 10                   │ │ 1,420        │ │ الناجحة 0    │ │
│ └──────────────────────────┘ └──────────────────────┘ └──────────────┘ └──────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

- Header: minimal — the primary CTA `+ إضافة مرشح جديد` only (brand group, seal tile, title, eyebrow, fastpath badge, and DRY-RUN badge removed 2026-08-20 per operator request; DRY-RUN status is visible via Telegram alerts and `wrangler.toml` `DRY_RUN` var).
- Metric card 1 (**featured**, spans 2 columns): **المرشحون النشطون** — `activeJobs / 10`. Carries the full burnt-red band with paper text.
- Metric card 2: **فحوصات اليوم** — `metricsToday.total_checks` (the live Cairo-time window card, `window-tag`/`val-cairo`, was removed 2026-08-20 per operator request; the global window still governs scheduling server-side and is stated in the rules box).
- Metric card 3: **الحجوزات الناجحة** — `metricsToday.bookings_completed`, value in `--success`.
- Metric labels are micro-caps: 11px / 600-weight / `0.05em` letter-spacing in `--text-muted` (dossier ledger treatment; Arabic has no uppercase, so it's tracking + weight).
- Numbers render in the system mono stack (`tabular-nums`; fixed-width by face); metric values use `--text` ink over muted labels; the featured card's value is `--primary-ink` paper on the red band.

### Screen 2: Client Table

5 columns, hand-rolled `table` (no framework table classes — **ruled ledger**: hairline row separators, alternating paper row tint, `#efe8da` hover):

| Column | Content |
|---|---|
| اسم المرشح | `firstName lastName`, weight 700 |
| الفئة | بكالوريوس / ماجستير / دكتوراه (from `category`) |
| جواز السفر (مشفّر) | `maskedPassport` in the system mono stack — masked only, per AD-3, never plaintext |
| حالة المهمة | pill — see §3 Status Presentation |
| الإجراءات | row actions — see below |

Row actions (rendered only when `jobId` exists and status is neither `CANCELLED` nor `BOOKED`):

| Button | Style | Behavior |
|---|---|---|
| إيقاف مؤقت / تفعيل | `btn-outline-light btn-sm` | `POST /api/jobs/:id/pause` \| `activate`, then reload |
| تعديل | `btn-outline-light btn-sm` | `openEditModal(id)` — prefills from the loaded clients array (no extra GET) |
| حذف | `btn-outline-danger btn-sm` | native `confirm('سيتم حذف المرشح ومهمته نهائيًا…')` then `DELETE /api/clients/:id`; on failure surfaces the server error (see §5 known-minor) |
| إلغاء | `btn-outline-danger btn-sm` | `POST /api/jobs/:id/cancel` — terminal, D8 |

Failure states:
- **Loading:** 3 skeleton shimmer rows (`colspan=5`) replace the tbody until `/api/clients` resolves.
- **Empty:** composed block — 📋 icon, «لا يوجد مرشحون بعد», muted guidance line («أضف أول مرشح ليبدأ النظام بالفحص في نافذة 07:00 – 18:00»), and a primary CTA re-opening the add modal.

Terminal rows (`BOOKED` / `CANCELLED`) render **no actions** — nothing to resurrect, per D8. BOOKED rows are additionally protected server-side (403).

### Screen 3: Add / Edit Client Modal

One shared modal, one shared HTML form, switched by a mode flag (`editingClientId`) — DRY by construction.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ [mode] إضافة مرشح جديد للنظام / تعديل بيانات المرشح                   [X] │
├────────────────────────────────────────────────────────────────────────────┤
│ ⚠ inline error box (custom .alert-danger, hidden unless a 4xx returns)     │
│ ┌────────────┐ ┌────────────┐                                              │
│ │ الاسم الأول │ │ اسم العائلة │    فئة الحجز [بكالوريوس / ماجستير… ▼]        │
│ └────────────┘ └────────────┘                                              │
│ ⏰ قواعد المواعيد موحّدة لجميع الطلبات: الفحص يوميًا 07:00–18:00 القاهرة،    │
│    والطلب يبقى نشطًا حتى إتمام الحجز أو الإلغاء.  (read-only info box)      │
│ اسم العائلة عند الميلاد · مكان الميلاد · بلد الميلاد · الجنسية عند الميلاد   │
│ الشارع/العنوان · الرمز البريدي · المدينة · رقم الجواز · تاريخ انتهاء الجواز │
│ تاريخ إصدار الجواز · جهة الإصدار · تاريخ الميلاد · النوع · البريد · الهاتف  │
│ ┌──────┐ ┌────────────────────────────┐                                    │
│ │ إلغاء │ │ [حفظ وإنشاء المهمة / حفظ التعديلات] │                              │
│ └──────┘ └────────────────────────────┘                                    │
└────────────────────────────────────────────────────────────────────────────┘
```

- 18 fields, 2-column responsive grid (`form-grid`, single column below 480px). LTR inputs (postal code, email, phone, passport number) use `direction: ltr` inline.
- Field labels are muted 600-weight above filled controls; required inputs use native `required` + `placeholder` example values (e.g. «أحمد», «١٢ شارع التحرير», `11511`, `A12345678`).
- The read-only «قواعد المواعيد» box restates FR-3 (global window + no expiry) — no per-client schedule controls exist (v1 controls removed 2026-08-20). v6 restyle: red tint `rgba(179,58,43,.06)` with a `--border-accent` edge bar on the inline-start.
- **Passport keep-flow (edit mode):** the passport input opens empty with placeholder «اتركه فارغًا للإبقاء على الرقم الحالي» and **`required = false`** — empty means "keep existing ciphertext" (the plaintext is never re-sent to the browser). Add mode sets `required = true` and the example placeholder back.
- Buttons: `إلغاء` (`btn-outline-light`) closes without saving; submit label switches with mode — «حفظ وإنشاء المهمة» (POST) / «حفظ التعديلات» (PUT). Custom button base: 13px/600, 8px radius, `scale(0.98)` on press.
- Submission errors render **inline** in the alert box (server 400 messages, e.g. field-name errors); the modal stays open; nothing is written on failure.
- Modal (v6 custom): backdrop `rgba(35,32,26,.45)` + `backdrop-filter: blur(6px)`; dialog surface `--bg-raised #ffffff` (paper, one step above cards) with `--border-strong` and 12px radius; header separated by a hairline; `max-width: 660px`; close button `aria-label="إغلاق"` (✕, 30px ghost tile).

---

## 3. Status Presentation

Shipped pill set — two variants only, deliberately:

| Pill | Class | Shown for |
|---|---|---|
| «متوقف ⏸» | `status-paused` — **ink stamp** pill (`--text` ink text, `--border-strong` outline) | job `enabled=0`, status not terminal |
| «نشط ⚡» | `status-active` — **solid red stamp** (bg `--primary`, text `--primary-ink` paper) | job `enabled=1`, status not terminal |
| «تم الحجز ✅» | `status-active` — solid red stamp | `BOOKED` — terminal |
| «ملغي 🚫» | `status-paused` — ink stamp pill | `CANCELLED` — terminal |

The v1 12-states-of-the-state-machine badge matrix (colors/icons per `DRAFT`…`EXPIRED`) is **not shipped**: the dashboard collapses behavior to the four operator-meaningful conditions. Internal scheduler states (`ACTIVE`, `SEARCHING`, `BOOKING`…) remain in the domain model (see `docs/prd.md` §4) but are not rendered as per-state visuals.

---

## 4. Micro-Interactions & Feedback (shipped set)

1. **Hover/active:** background shift on hover for cards/rows; `scale(0.98)` on button press — 200–300ms, transform-only.
2. **Focus:** visible red border (`border-color: var(--primary)`) on all buttons, inputs, selects — never `box-shadow: none` + nothing.
3. **Staggered reveal:** metric cards rise in on first load (0.06s cascade).
4. **Skeleton shimmer** while the table loads; **composed empty state** with CTA when there are no clients.
5. **Inline form errors** — server 400s land in a custom `alert-danger` box inside the modal (no `window.alert()` on forms).
6. **Delete guard** — native `confirm()` before delete; **known-minor:** if the DELETE itself fails (non-4xx/400), the error surfaces via `alert()` — tracked in `docs/implementation-artifacts/deferred-work.md`; deliberate trade-off, not shipped with a fancier toast.
7. **Auto-refresh:** dashboard reloads every 10s (`setInterval(loadDashboard, 10000)`) — near-real-time state without a socket layer.

Not shipped (v1 aspirational items removed): toasts, budget gauge, filter pills, context menus, audit-log live feed.

---

## 5. Accessibility Floor

- Full RTL: `dir=rtl` document, Arabic microcopy; LTR islands (`direction: ltr`) only where the domain data is LTR (mono values, email, phone).
- Semantic markup: real `table/th/td`, real `label` + `input` pairing, `button` elements (no div-click handlers), native `confirm()` for destructive actions (benign for SR users — system dialog).
- Modal close gets `aria-label="إغلاق"`; the error box is `role="alert"` (custom `.alert`, not Bootstrap).
- Keyboard: all actions reachable (native buttons/inputs), focus rings visible, Escape/save flows not overridden.
- Contrast: ink `#23201a` on parchment `#f4efe6` (~14:1); body `#4a4438` on paper `#fbf8f1` (~8:1); paper `#fbf8f1` on red `#b33a2b` (~6:1) — all above WCAG AA even at small sizes (red on paper 6:1 clears AA large/UI components; semantic tints stay in the pill text).
- `prefers-reduced-motion`: all animation disabled.

---

## 6. Do's and Don'ts

**Do** — keep the parchment token family, one loud burnt-red accent, and the editorial dossier treatment (seal tile, stamp pills, ruled ledger rows); keep the design system hand-rolled in the single inline `<style>` block (no framework CSS, no JS bundle, one font request, zero images); use Alexandria for everything text, the system mono stack for data; show the global window; mask the passport; keep add/edit in one modal; reload on 10s.
**Don't** — add a second accent, gradient stacks, grain overlays, drop shadows, or glows (v3–v5 shadows/atmosphere removed; depth is surface tone + ledger rules + paper weave); return to a navy/blue-default look (v2 superseded), the violet-midnight Sentry look (v3/v4 superseded), or any near-black dark canvas (v5 superseded — no dark mode claim); use glassmorphism (`backdrop-filter` only on the modal backdrop); add Inter/Roboto/Cairo/JetBrains Mono/extra webfonts; render per-client schedule controls (global rules only); re-import Bootstrap or ship any new npm dependency (v4 removed it — see revision log); show plaintext passports or PII in logs; re-introduce tabs, toasts, budget gauges, or the 12-state badge matrix (v1) without an operator decision.

---

## 7. Out of Scope (v1 surfaces not shipped, decisions recorded)

| v1 item | Status | Reference |
|---|---|---|
| Live Audit Log tab | Not shipped — audit data stays in D1 (`audit_logs`); no viewer UI yet | `docs/prd.md` FR-8, FR-10 (viewer listed as future) |
| System Config tab | Not shipped — config is env/secrets (`wrangler.toml`, `.dev.vars`, worker secrets) | — |
| Toast notifications | Not shipped — inline errors + reload suffice at this scale | — |
| Budget gauge | Not shipped — browser budget is NFR, surfaced via Telegram alerts (FR-9), not UI | `docs/prd.md` NFR-2 |
| Filter pills / context menus | Not shipped — 5-column table with row actions at ≤ 10 clients (D2 scale) | `docs/prd.md` D2 |
| Telegram success alerts | Shipped in code path, not in this dashboard's UI scope | `docs/prd.md` FR-9 |