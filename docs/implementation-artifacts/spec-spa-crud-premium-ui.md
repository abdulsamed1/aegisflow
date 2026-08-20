---
title: 'SPA Client CRUD + Premium UI Redesign'
created: '2026-08-20'
status: 'ready-for-review'
baseline_commit: 'e37f695'
decisions_locked: ['D5-amended (window 07:00–18:00, unchanged)', 'D8 (no expiry, unchanged)', 'AD-11 (global rules, unchanged)']
skill_applied: 'frontend/ui-ux/redesign-existing-projects'
---

# SPA Client CRUD + Premium UI Redesign

## Context

Operator needs full CRUD on clients from the SPA. Today: Create (modal) + Read (table) + job
toggle exist; client Update and Delete are missing. The dashboard must reach a premium,
non-generic 2027 look without slowing anything down. The booking hot path (cron → pick →
scan → book) is server-side and untouched by this work; the SPA is operator-only behind
Cloudflare Access, so its weight affects page load, not booking speed.

Locked constraints:
- Single Worker deployable. No bundler, no framework, no new build step.
- Reuse popular OSS components where they match this architecture.
- Performance first: smallest possible payload, cached assets, GPU-only animation.

## API (backend, `src/index.ts`)

1. `PUT /api/clients/:id`
   - Same 17 required fields as POST (`typeof === "string" && trim() !== ""`), else 400 naming the field.
   - Passport number: empty string allowed = keep existing encrypted value (plaintext passport is
     never re-sent to the browser); non-empty = re-encrypt.
   - Re-encrypts: firstName, lastName, familyNameAtBirth, street, postalCode, city, passportNumber,
     email, phone. Plaintext columns updated directly.
   - Recomputes `calendar_id` from category (same mapping as POST: Master_PhD → 44279679 else 44281520).
   - Job row untouched (status/enabled/last_check preserved).
   - 404 unknown client id; 200 `{success:true}`.
2. `DELETE /api/clients/:id`
   - 403 if the client's job is `BOOKED` (real booking evidence protected).
   - DELETE the client row; job cascades via FK.
   - One `INSERT` into audit_logs (event `CLIENT_DELETED`) for traceability — ponytail: one line,
     reuses the existing table.
   - 404 unknown id; 200 `{success:true}`.
3. `GET /api/clients` — additionally returns `email`, `phone`, `passportExpiry` for edit prefill.
   Passport number stays masked only.

## UI (dashboard, same Worker-served page)

### Component reuse (per redesign skill: work with existing stack, no rewrite)

- Bootstrap 5.3 RTL: **CSS only** (`bootstrap.rtl.min.css` via jsDelivr, version-pinned + SRI +
  `preconnect`). No `bootstrap.bundle.js` — delete confirm uses native `confirm()`
  (ponytail: platform feature, zero JS payload).
- Reused: form controls, buttons, table, modal markup classes. Existing custom CSS for those
  (~80 lines) is deleted — less code is the feature.
- Kept custom (zero churn): brand header, metric cards, status pills.

### Premium redesign (fix priority from skill)

1. **Typography** — swap system font to **Alexandria** (variable Arabic+Latin, one file request,
   `display=swap`). Headings 700–800, labels 600, body 400–500. Data/IDs/metrics keep
   `JetBrains Mono` with `font-variant-numeric: tabular-nums`. No Inter/system defaults.
2. **Color** — off-black navy background (`#0b0f1a` family), one desaturated brand accent
   (blue ~#4a7dff, saturation < 80%), semantic status colors kept for pills only. Tinted
   shadows (hue of background, not pure black). Ambient radial gradient + fixed SVG-noise
   overlay (data-URI, pointer-events none) to break flatness. No purple/blue AI gradients.
3. **States** — hover (background shift) + active (`scale(0.98)`) + visible focus rings on all
   interactive elements; transitions 200–300ms on transform/opacity only.
4. **Loading** — skeleton rows (CSS shimmer) while `/api/clients` loads, replacing the plain
   "جاري التحميل" row.
5. **Empty state** — composed block (icon + line + CTA button) instead of a bare table row.
6. **Errors** — inline error box inside the modal (Bootstrap alert) instead of `window.alert()`.
   Delete confirm stays native `confirm()`.
7. **Motion** — staggered fade-in of metric cards + table on first load (CSS keyframes,
   `transform`/`opacity` only, respects `prefers-reduced-motion`).
8. **Layout** — keep top-header (skill approves top nav for dashboards); metric grid becomes
   asymmetric: the "active candidates" card is the dominant one (accent edge glow); container
   max-width 1400px.

### CRUD interactions

- Row actions: تعديل / حذف next to existing pause/cancel. Hidden for BOOKED rows (server enforces too).
- Edit reuses the SAME modal/form as Add (DRY): one HTML form, a mode flag; prefill from the
  already-loaded clients array — no extra GET endpoint.
- Passport input in edit mode: empty + placeholder «اتركه فارغًا للإبقاء على الرقم الحالي».
- Submit handler branches POST (add) vs PUT (edit); success closes modal and reloads dashboard.

## Testing

Extend existing suites (no new framework):
- `test/api.test.ts` (Miniflare integration, real D1):
  - PUT: round-trip (update → GET shows new values; encrypted fields decrypt to new values),
    empty passport keeps old number, 400 missing field, 404 unknown id, category change
    recomputes calendar_id.
  - DELETE: removes client + job (cascade verified), 404 unknown, 403 on BOOKED job, audit row exists.
  - GET: returns email/phone/passportExpiry; passportNumber still masked.
- Manual browser pass after deploy (operator's own check): RTL look, edit prefill, delete confirm,
  skeleton, empty state, focus rings.

## Not in scope

Search/sort/pagination, bulk actions, soft-delete/restore, edit auditing, CSRF (Access gates the
origin), React/shadcn migration (architecture decision — no build step), Bootstrap JS bundle.
