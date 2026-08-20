# UX & UI Specification — Single Operator Admin Panel (opran-booking)

> **Status:** FINAL — amended 2026-08-20 to v4: **hand-rolled design system, zero third-party UI CSS** (visual source of truth: `docs/implementation-artifacts/spec-spa-crud-premium-ui.md`; design-md inspiration: Sentry via `awesome-design-md` + `designmd.co` + `designmd.app`; code source of truth: `src/index.ts` `getAdminHTML`)
> **Target Device:** Desktop / Tablet responsive (container max-width 1400px; collapses at 768px and 480px)
> **Visual Direction:** Violet-midnight operational dashboard — purple-night surfaces, violet hairlines, ONE loud electric-lime accent, Alexandria typeface, **hand-rolled CSS only — no Bootstrap, no framework CSS, one file, one request**. No glass, no gradient stacks, one accent color.

---

## 0. Revision Log

| Date | Change | Driven by |
|---|---|---|
| 2026-08-19 | v1: glassmorphism direction, Cairo font, tabbed layout (Clients / Audit Log / System Config), 12-state badge matrix, toasts, budget gauge | Original design spec |
| 2026-08-20 | v2: **premium redesign shipped** — navy token set, Alexandria typography, Bootstrap RTL CSS, single-view layout (no tabs), skeleton/empty/inline-error states, Edit/Delete CRUD actions, shared add/edit modal with keep-passport flow | Operator + redesign story (`spec-spa-crud-premium-ui.md`); v1-only surfaces (Audit Log tab, System Config tab, toasts, budget gauge, filter pills) are **explicitly not shipped** and out of scope — see §8 |
| 2026-08-20 | v3: **Sentry night + electric lime** — violet-midnight canvas family, one loud lime accent reserved for CTAs/focus/active pills, violet hairlines replace navy, micro-cap metric labels, lime glow on the featured card | Operator redesign decision; inspired by the **Sentry** design.md (discovered via `awesome-design-md`, `designmd.co`, `designmd.app` — purple night `#150f23`/`#1f1633`, hairline `#362d59`, accent `#c2ef4e`) |
| 2026-08-20 | v4: **full hand-rolled redesign — Bootstrap dropped** — custom CSS replaced the Bootstrap RTL CDN entirely (no framework stylesheet, no JS bundle); custom form controls (focus ring in lime, dark selects with SVG chevron), custom modal (raised surface `#241c42`, blur backdrop), brand mark tile, live window pulse dot, footer system line, 14px card radii; same DOM IDs and classes used by the loader JS, so the backend script block is untouched | Operator request: full UI/UX rechange, keep Arabic, fast performance (one fewer 200KB CDN request), keep Sentry-night direction |

The v2 changes supersede v1. Anything in v1 not listed in v2 does not exist in the product and must not be re-introduced without a new decision.

---

## 1. Design System

### 1.1 Color Palette (shipped tokens — `src/index.ts` `:root`, v4 Sentry night)

```css
:root {
  /* Backgrounds — violet-midnight family, depth by surface ladder, not by shadow */
  --bg-surface: #150f23;
  --bg-card: #1f1633;
  --bg-card-hover: #261d45;
  --bg-raised: #241c42;                         /* v4: modal/select surfaces one step above cards */
  --border: rgba(214, 205, 255, 0.10);          /* violet hairline */
  --border-strong: rgba(214, 205, 255, 0.22);   /* v4: input/modal borders read clearly */
  --border-accent: rgba(194, 239, 78, 0.35);

  /* Accents — ONE loud accent: electric lime, reserved for CTA/focus/active pills */
  --primary: #c2ef4e;
  --primary-hover: #d3f57a;
  --primary-ink: #13101f;                       /* near-black text ON the lime */
  --success: #22c55e; --warning: #f59e0b; --danger: #ef4444;  /* semantic trio, pills only */

  /* Text */
  --text: #f3eefc;
  --text-muted: #a89fce;
  --text-dim: #6d6590;

  /* Elevation — hairline inset + background-hue tint; the accent glow lives only on the featured card */
  --shadow-card: 0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px -16px rgba(8,5,18,0.85);
  --shadow-accent: 0 0 24px -8px rgba(194, 239, 78, 0.4);
}
```

Rules:
- One loud accent (`--primary` c2ef4e lime). It appears **only** on primary buttons, focus rings, active/brand badges, and the featured card glow — never decoratively. Semantic colors (`success`/`warning`/`danger`) appear **only** on pills.
- Violet night is the only canvas family; there is no light mode claim, no navy default (v2 navy tokens superseded by v3).
- Background atmosphere: two radial tints (lime at top-right ≤ 7%, violet at bottom-left ≤ 10%) over `--bg-surface`, plus one fixed SVG-noise grain overlay (`feTurbulence` data-URI, `pointer-events: none`, opacity 0.035). GPU-free; no image assets.
- **v4: no Bootstrap.** The document root is `lang="ar" dir="rtl" data-theme="night"`. All components (forms, selects, modal, pills, alerts, table) are hand-rolled custom CSS in the same inline `<style>` block — zero framework stylesheet, zero JS bundle, one font request. Custom form controls: dark surface `#191230`, hairline borders, lime focus ring (`box-shadow: 0 0 0 3px rgba(194,239,78,.15)`), custom SVG chevron on selects, `color-scheme: dark` for date inputs.

### 1.2 Typography

- **Primary:** `Alexandria` variable (Arabic + Latin, weights 400–800, one Google Fonts request, `display=swap`). Headings/brand 800, labels 600, body 400–500. Fallback stack `system-ui, -apple-system, sans-serif` only behind the webfont.
- **Monospace:** `JetBrains Mono` 500, `direction: ltr; display: inline-block` — reserved for IDs, masked passport numbers, timestamps, and error codes.
- No Inter, no Roboto, no Cairo (v1 font, dropped in v2).

### 1.3 Layout & Spacing

- Single-view SPA: `header` → metric ribbon → table card → modal. No tabs, no navigation — the operator's whole job is on one screen.
- Container max-width 1400px; body padding 24px (12px below 768px).
- Card radii 14px; pill radii 999px; control (button/input/select) radii 8px; grid gap 16px (10px below 768px).
- Responsive: metrics auto-fit `minmax(240px, 1fr)`; below 768px two columns, below 480px one column; table scrolls horizontally (`min-width: 580px`) with `-webkit-overflow-scrolling: touch`.

### 1.4 Elevation & Shape

- Cards: 1px `--border`, `--shadow-card` (background-hue tint, not flat black drop).
- The **featured** metric card (active candidates) spans 2 grid columns and carries `--border-accent` + `--shadow-accent` glow + a subtle 135° primary gradient wash (≤ 8% alpha) — the only gradient on screen, and it marks importance, not decoration.

### 1.5 Motion

- Transitions on `transform`/`background-color`/`box-shadow`/`border-color` only, 200–300ms. No transform on layout properties, no infinite animations except the skeleton shimmer.
- First-load reveal: metric cards stagger in via `rise` keyframe (opacity + 10px translateY, 0.06s cascade, 0.4s each).
- Skeleton rows: 200% background-position shimmer loop (1.2s).
- **`prefers-reduced-motion: reduce` kills all animation and transitions** (`animation: none !important; transition: none !important`).

---

## 2. Screen Specifications

### Screen 1: Header + Metric Ribbon

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│ [O] أوبيران لأتمتة الحجوزات             [⚡ محرك الفحص السريع]  [🛡️ DRY-RUN]   │
│     opran-booking · BMEIA Cairo                                        [+ إضافة مرشح] │
├────────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────┐ ┌──────────────────────┐ ┌──────────────┐ ┌──────────────┐ │
│ │ المرشحون النشطون (مميز)  │ │ نافذة الفحص:          │ │ فحوصات اليوم │ │ الحجوزات      │ │
│ │ 3 / 10                   │ │ ● داخـل نافذة الفحص   │ │ 1,420        │ │ الناجحة 0    │ │
│ └──────────────────────────┘ └──────────────────────┘ └──────────────┘ └──────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

- Header: brand mark (30px lime tile with ink `O` glyph + accent glow) + title «أوبيران لأتمتة الحجوزات» + mono eyebrow `opran-booking · BMEIA Cairo`; `⚡ محرك الفحص السريع` badge; `🛡️ وضع الاختبار التجريبي DRY-RUN` badge (rendered only when `DRY_RUN=true`); primary CTA `+ إضافة مرشح جديد`.
- Metric card 1 (**featured**, spans 2 columns): **المرشحون النشطون** — `activeJobs / 10`. Carries the accent-border glow.
- Metric card 2: **نافذة الفحص** — label states the global window (`07:00 – 18:00 القاهرة`); the value is the live Cairo time (18px mono) with a **live pulse dot** (`window-tag`, lime + 2s pulse animation when inside the window, dim when outside) and a status line «داخل نافذة الفحص — الفحص مفعّل» / «خارج نافذة الفحص». Refreshes every 10s.
- Metric card 3: **فحوصات اليوم** — `metricsToday.total_checks`.
- Metric card 4: **الحجوزات الناجحة** — `metricsToday.bookings_completed`, value in `--success`.
- Metric labels are micro-caps: 11px / 600-weight / `0.04em` letter-spacing in `--text-muted` (Sentry `micro-cap` treatment; Arabic has no uppercase, so it's tracking + weight).
- Numbers render in `JetBrains Mono` (fixed-width by face); metric values use `--text` (near-white) over muted labels; the featured card's number carries the lime glow.

### Screen 2: Client Table

5 columns, hand-rolled `table` (no framework table classes — hairline row separators, `#261d45` hover):

| Column | Content |
|---|---|
| اسم المرشح | `firstName lastName`, weight 700 |
| الفئة | بكالوريوس / ماجستير / دكتوراه (from `category`) |
| جواز السفر (مشفّر) | `maskedPassport` in `JetBrains Mono` — masked only, per AD-3, never plaintext |
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
- The read-only «قواعد المواعيد» box restates FR-3 (global window + no expiry) — no per-client schedule controls exist (v1 controls removed 2026-08-20). v4 restyle: violet tint `rgba(122,92,255,.08)` with a lime edge bar on the inline-start.
- **Passport keep-flow (edit mode):** the passport input opens empty with placeholder «اتركه فارغًا للإبقاء على الرقم الحالي» and **`required = false`** — empty means "keep existing ciphertext" (the plaintext is never re-sent to the browser). Add mode sets `required = true` and the example placeholder back.
- Buttons: `إلغاء` (`btn-outline-light`) closes without saving; submit label switches with mode — «حفظ وإنشاء المهمة» (POST) / «حفظ التعديلات» (PUT). Custom button base: 13px/600, 8px radius, `scale(0.98)` on press.
- Submission errors render **inline** in the alert box (server 400 messages, e.g. field-name errors); the modal stays open; nothing is written on failure.
- Modal (v4 custom): backdrop `rgba(8,5,18,.78)` + `backdrop-filter: blur(6px)`; dialog surface `--bg-raised #241c42` (one step above cards) with `--border-strong` and 16px radius; header separated by a hairline; `max-width: 660px`; close button `aria-label="إغلاق"` (✕, 30px ghost tile).

---

## 3. Status Presentation

Shipped pill set — two variants only, deliberately:

| Pill | Class | Shown for |
|---|---|---|
| «نشط ⚡» | `status-active` — **lime** pill (bg `rgba(194,239,78,.12)`, text `var(--primary)`) | job `enabled=1`, status not terminal |
| «متوقف ⏸» | `status-paused` — amber pill (`warning-bg`/`--warning`) | job `enabled=0`, status not terminal |
| «تم الحجز ✅» | `status-active` — lime pill | `BOOKED` — terminal |
| «ملغي 🚫» | `status-paused` — amber pill | `CANCELLED` — terminal |

The v1 12-states-of-the-state-machine badge matrix (colors/icons per `DRAFT`…`EXPIRED`) is **not shipped**: the dashboard collapses behavior to the four operator-meaningful conditions. Internal scheduler states (`ACTIVE`, `SEARCHING`, `BOOKING`…) remain in the domain model (see `docs/prd.md` §4) but are not rendered as per-state visuals.

---

## 4. Micro-Interactions & Feedback (shipped set)

1. **Hover/active:** background shift on hover for cards/rows; `scale(0.98)` on button press — 200–300ms, transform-only.
2. **Focus:** visible rings (`outline: 2px solid var(--primary); outline-offset: 2px`) on all buttons, inputs, selects — never `box-shadow: none` + nothing.
3. **Staggered reveal:** metric cards rise in on first load (0.06s cascade).
4. **Skeleton shimmer** while the table loads; **composed empty state** with CTA when there are no clients.
5. **Inline form errors** — server 400s land in a custom `alert-danger` box inside the modal (no `window.alert()` on forms).
6. **Delete guard** — native `confirm()` before delete; **known-minor:** if the DELETE itself fails (non-4xx/400), the error surfaces via `alert()` — tracked in `docs/implementation-artifacts/deferred-work.md`; deliberate trade-off, not shipped with a fancier toast.
7. **Auto-refresh:** dashboard reloads every 10s (`setInterval(loadDashboard, 10000)`) — near-real-time state without a socket layer.
8. **Live window pulse** — the window card dot turns lime and pulses (2s) only while inside the 07:00–18:00 Cairo window; dim outside. Real state, not decoration.

Not shipped (v1 aspirational items removed): toasts, budget gauge, filter pills, context menus, audit-log live feed.

---

## 5. Accessibility Floor

- Full RTL: `dir=rtl` document, Arabic microcopy; LTR islands (`direction: ltr`) only where the domain data is LTR (mono values, email, phone).
- Semantic markup: real `table/th/td`, real `label` + `input` pairing, `button` elements (no div-click handlers), native `confirm()` for destructive actions (benign for SR users — system dialog).
- Modal close gets `aria-label="إغلاق"`; the error box is `role="alert"` (custom `.alert`, not Bootstrap).
- Keyboard: all actions reachable (native buttons/inputs), focus rings visible, Escape/save flows not overridden.
- Contrast: text `#f3eefc` on `#1f1633` (~13:1); muted `#a89fce` on card (~7:1) — both above WCAG AA even at small sizes.
- `prefers-reduced-motion`: all animation disabled.

---

## 6. Do's and Don'ts

**Do** — keep the violet-night token family and one loud lime accent; keep the design system hand-rolled in the single inline `<style>` block (no framework CSS, no JS bundle — one fewer 200KB request); use Alexandria for everything text, JetBrains Mono for data; show the global window; mask the passport; keep add/edit in one modal; reload on 10s.
**Don't** — add a second accent or gradient stacks; return to a navy/blue-default look (v2 superseded); use glassmorphism (`backdrop-filter` only on the modal backdrop); add Inter/Roboto/Cairo/extra webfonts; render per-client schedule controls (global rules only); re-import Bootstrap or ship any new npm dependency (v4 removed it — see revision log); show plaintext passports or PII in logs; re-introduce tabs, toasts, budget gauges, or the 12-state badge matrix (v1) without an operator decision.

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