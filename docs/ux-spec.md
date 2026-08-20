# UX & UI Specification — Single Operator Admin Panel (opran-booking)

> **Status:** FINAL (amended 2026-08-20 — shipped dashboard is the premium redesign; source of truth: `docs/implementation-artifacts/spec-spa-crud-premium-ui.md`)  
> **Target Device:** Desktop / Tablet Responsive (1280px+ optimized)  
> **Visual Direction:** Premium Navy Operational Dashboard — off-black navy, single desaturated blue accent, Bootstrap 5.3 RTL (CSS-only, SRI-pinned), Alexandria typeface  

---

## 1. Design System & Aesthetics

### 1.1 Color Palette (2026-08-20 — shipped tokens, src/index.ts `:root`)

```css
:root {
  /* Backgrounds — off-black navy family */
  --bg-surface: #0b0f1a;
  --bg-card: #111726;
  --bg-card-hover: #161e30;
  --border: rgba(148, 163, 184, 0.14);

  /* Primary & Accents — one desaturated brand accent, semantic colors for pills only */
  --primary: #4a7dff;
  --primary-hover: #3b6ae6;
  --success: #2dd4a7;
  --warning: #eab308;
  --danger: #f87171;

  /* Text */
  --text: #e8edf6;
  --text-muted: #94a3b8;
  --text-dim: #64748b;
}
```

- Ambient background: two radial gradients (primary tint top-right, success tint bottom-left) over `--bg-surface`, plus a fixed SVG-noise grain overlay (`feTurbulence` data-URI, `pointer-events: none`, opacity 0.035).
- Bootstrap dark-theme remap: `--bs-*` variables re-point to our tokens so `.table/.btn/.alert/.form-control` adopt the palette.
- Tinted shadows: cards use `0 12px 32px -16px rgba(3,7,18,.9)` (background hue, not pure black); the featured card adds a primary accent glow.

### 1.2 Typography & Visual Hierarchy
- **Primary Font**: `Alexandria` (variable Arabic+Latin, weights 400–800, one Google Fonts request, `display=swap`) — headings 700–800, labels 600, body 400–500. Fallback `system-ui`.
- **Monospace Font**: `JetBrains Mono` 500 (used for IDs, Timestamps, Error Codes, JSON payload previews).
- Motion: transitions on `transform`/`opacity` only (200–300ms), staggered `rise` keyframe reveal for metric cards on first load, `prefers-reduced-motion: reduce` kills all animation.

---

## 2. Layout Structure

The layout is a single-page application (SPA) comprising:
1. **Top Bar Header**: Platform Branding, Live Cairo Time Clock, Global Dry-Run Safety Badge, System Status Indicator.
2. **Key Performance Metrics Ribbon**: 4 summary cards displaying live operational stats.
3. **Main Content Workspace**: Tabbed view switching between:
   - **Clients & Jobs**: Main table view.
   - **Live Audit Log**: Real-time event feed.
   - **System Config**: Settings & safety overrides.

---

## 3. Screen Specifications

### Screen 1: Top Bar & Metrics Ribbon

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  OPRAN BOOKING  │  Cairo: 14:32:05 (07:00–18:00 Scanning)  │  [🛡️ DRY-RUN ACTIVE]  │  [⚡ System: Operational] │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│ ACTIVE JOBS         │ │ CHECKS TODAY        │ │ BROWSER BUDGET      │ │ SUCCESSFUL BOOKINGS │
│ 7 / 10 Active       │ │ 1,420 Checks        │ │ 46s / 540s (9%)     │ │ 0 Booked            │
└─────────────────────┘ └─────────────────────┘ └─────────────────────┘ └─────────────────────┘
```

#### Metrics Cards Details:
- **Active Jobs**: Current number of client jobs in `ACTIVE` state out of maximum limit (10).
- **Checks Today**: Total availability checks executed in the last 24h (discovery POSTs — these do not consume browser budget).
- **Browser Time Budget**: Gauge bar measuring cumulative Playwright browser seconds against the 540s (90%) safety limit. Turns Amber at 70%, Crimson at 90%. (Direct-HTTP discovery consumes ~0 browser seconds; Playwright fallback and first-slot capture are the main consumers.)
- **Successful Bookings**: Total count of jobs transitioned to `BOOKED` state.

---

### Screen 2: Client Management Table (`Clients & Jobs` Tab)

Displays all candidate clients with instant filter pills (`All`, `Active`, `Draft`, `Booked`, `Errors`).

#### Table Columns:
1. **Candidate Name & Passport**: Name (bold) + Masked Passport (`A12***78`).
2. **Category**: Badge `Bachelor` (Blue) or `Master/PhD` (Purple).
3. **Created**: Registration date of the request (per-client date ranges were removed 2026-08-20 — requests live until `BOOKED` or cancellation, D8).
4. **Status Badge**: Interactive state pill (see State Color Matrix below).
5. **Last Checked**: Relative time ("2 mins ago") + total check count.
6. **Actions**: Context menu / Action buttons:
   - `[Activate / Pause]` toggle button.
   - `[Cancel]` button — ends the request permanently (operator or client decision, D8).
   - `[Edit]` icon button — opens the shared add/edit modal in edit mode (prefill from the loaded clients array, no extra GET).
   - `[Delete]` icon button — native `confirm()` then `DELETE /api/clients/:id`; hidden for `BOOKED` rows (default-`disabled` + server 403 as backstop).

#### Status Badge Color Matrix:

| State | Badge Color | Icon / Animation |
|---|---|---|
| `DRAFT` | Muted Gray | Pencil Icon |
| `VALIDATION_ERROR` | Crimson Red | Warning Icon |
| `READY` | Cyan / Sky Blue | Checkmark Icon |
| `ACTIVE` | Emerald Green | Pulsing Pulse Dot |
| `SEARCHING` | Radiant Blue | Spinning Loader |
| `BOOKING` | Amber / Gold | Lock Icon |
| `BOOKED` | Emerald Glow | Star / Trophy Icon |
| `BOOKING_FAILED` | Orange / Red | Alert Triangle |
| `TEMPORARY_ERROR` | Muted Amber | Refresh Icon |
| `PORTAL_ERROR` | Bright Red | Shield Alert |
| `CANCELLED` | Dark Gray | Cross Circle |
| `EXPIRED` | Dim Gray (legacy — no longer reachable, D8) | Clock Icon |

---

### Screen 3: Add / Edit Client Modal

A structured form modal with instant client-side validation feedback.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Add New Client Candidate                                         [X] │
├──────────────────────────────────────────────────────────────────────┤
│ PERSONAL & PASSPORT DATA                                             │
│ First Name: [ Ahmed               ]  Last Name:  [ Hassan          ] │
│ Family Name at Birth: [  ...      ]                                  │
│ Gender:     (•) Male  ( ) Female     DoB:        [ 2002-05-14      ] │
│ Place of Birth: [ Cairo            ]  Country of Birth: [ Egypt     ] │
│ Nationality:[ Egyptian            ]  Nationality at Birth: [ ...    ] │
│ Address:    [ Street / House No.  ]  Postal Code: [ 11511          ] │
│ City:       [ Cairo               ]  Phone:      [ +201012345678   ] │
│ Email:      [ ahmed@example.com   ]                                  │
│ Passport #: [ A28491048           ]  Issue Date: [ 2024-10-15      ] │
│ Issuing Country: [ Egypt          ]  Exp Date:   [ 2029-10-15      ] │
├──────────────────────────────────────────────────────────────────────┤
│ APPOINTMENT RULES — GLOBAL, NOT EDITABLE PER CLIENT (2026-08-20)     │
│ Window: 07:00–18:00 Cairo time, every day (Friday included)         │
│ Lifetime: active until BOOKED or cancelled — no expiry date          │
│ Category:   [ Aufenthaltsbewilligung Student (nur Bachelor)  ▼ ]     │
├──────────────────────────────────────────────────────────────────────┤
│                      [ Cancel ]   [ Save as Draft ]  [ Save & Validate ]│
└──────────────────────────────────────────────────────────────────────┘
```

> **2026-08-20 decision:** the per-client "Start Date / End Date / Time Range / Allowed Days" controls were removed from this modal. All ACTIVE requests share one global Cairo window (07:00–18:00 daily) and live until booked or cancelled. The additional birth/address/passport-issue fields mirror the observed BMEIA registration form (screenshots) so no booking-path gap remains once G0 closes.
>
> **2026-08-20 (CRUD):** Add and Edit share one form + one modal, switched by a mode flag; inline Bootstrap alert error box instead of `window.alert()`; form errors surface server 400s. In edit mode the passport input is left empty with placeholder «اتركه فارغًا للإبقاء على الرقم الحالي» and its native `required` attribute is disabled so the keep-passport submission goes through.

---

### Screen 4: Live Audit Log Viewer (`Live Audit Log` Tab)

Continuous event feed showing real-time system activities.

#### Log Entry Format:
`[14:32:01] [NO_APPOINTMENT] Job #104 (Ahmed H.) -> Week 2026-09-07 (272ms)`  
`[14:31:01] [APPOINTMENT_FOUND] Job #102 (Sara M.) -> Week 2026-09-14 -> DO Lock Acquired`  
`[14:31:04] [DRY_RUN_STOPPED] Job #102 -> Payload Prepared -> Screenshot Saved -> Execution Halted`

---

## 4. Micro-Interactions & UX Polish

1. **State Transition Toast Notifications**: Slide-in toast notification when a job changes state (e.g. `Job #102 transitioned to BOOKING`).
2. **Dry-Run Banner**: Bright gold top border banner whenever `DRY_RUN=true` is enabled to guarantee high visibility.
3. **Empty States**: Helpful illustrations and copy when no active clients exist.
