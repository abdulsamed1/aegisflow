# 2. Screen Specifications

## Screen 1: Header + Metric Ribbon

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

- Header: minimal — the primary CTA `+ إضافة مرشح جديد` only (brand group, seal tile, title, eyebrow, fastpath badge, and DRY-RUN badge removed 2026-08-20; `DRY_RUN` retired 2026-08-21, live booking only).
- Metric card 1 (**featured**, spans 2 columns): **المرشحون النشطون** — `activeJobs / 10`. Carries the full burnt-red band with paper text.
- Metric card 2: **فحوصات اليوم** — `metricsToday.total_checks` (the live Cairo-time window card, `window-tag`/`val-cairo`, was removed 2026-08-20 per operator request; the global window still governs scheduling server-side and is stated in the rules box).
- Metric card 3: **الحجوزات الناجحة** — `metricsToday.bookings_completed`, value in `--success`.
- Metric labels are micro-caps: 11px / 600-weight / `0.05em` letter-spacing in `--text-muted` (dossier ledger treatment; Arabic has no uppercase, so it's tracking + weight).
- Numbers render in the system mono stack (`tabular-nums`; fixed-width by face); metric values use `--text` ink over muted labels; the featured card's value is `--primary-ink` paper on the red band.

## Screen 2: Client Table

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
- **Auth:** `GET /` `src/index.ts:98` returns `401 WWW-Authenticate: Basic` if no `opran_admin_token` cookie; `fetch('/api/*')` `1134,1140,1172,1190,1196` returns `401 Unauthorized` unless cookie present. Same-origin cookies (`CF_Authorization` from Access + `opran_admin_token` `119`) are sent automatically — no `X-API-Key`/`CF-Access-*` in `getAdminHTML()` JS (audited).

Terminal rows (`BOOKED` / `CANCELLED`) render **no actions** — nothing to resurrect, per D8. BOOKED rows are additionally protected server-side (403).

## Screen 3: Add / Edit Client Modal

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
