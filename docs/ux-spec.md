# UX & UI Specification — Single Operator Admin Panel (opran-booking)

> **Status:** FINAL  
> **Target Device:** Desktop / Tablet Responsive (1280px+ optimized)  
> **Visual Direction:** Sleek Dark Glassmorphism, Premium Operational Dashboard  

---

## 1. Design System & Aesthetics

### 1.1 Color Palette (HSL Tailored)

```css
:root {
  /* Backgrounds */
  --bg-dark: hsl(222, 47%, 7%);
  --bg-card: hsla(222, 40%, 12%, 0.7);
  --bg-card-hover: hsla(222, 40%, 16%, 0.8);
  --border-glass: hsla(217, 33%, 25%, 0.4);

  /* Primary & Accents */
  --primary-accent: hsl(210, 100%, 56%);    /* Radiant Blue */
  --success-glow: hsl(150, 80%, 42%);      /* Emerald Green */
  --warning-amber: hsl(38, 92%, 50%);      /* Amber Gold */
  --error-crimson: hsl(352, 83%, 58%);     /* Crimson Red */
  
  /* Text */
  --text-main: hsl(210, 40%, 98%);
  --text-muted: hsl(215, 20%, 65%);
  --text-dim: hsl(215, 16%, 45%);
}
```

### 1.2 Typography & Visual Hierarchy
- **Primary Font**: `Cairo` (Arabic-first with Latin support — matches the Arabic dashboard and the project's Cairo domain), fallback `system-ui`.
- **Monospace Font**: `JetBrains Mono`, `monospace` (used for IDs, Timestamps, Error Codes, JSON payload previews).

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
│  OPRAN BOOKING  │  Cairo: 14:32:05 (24/7 Scanning)  │  [🛡️ DRY-RUN ACTIVE]  │  [⚡ System: Operational] │
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
3. **Preferred Date Range**: Start Date → End Date.
4. **Status Badge**: Interactive state pill (see State Color Matrix below).
5. **Last Checked**: Relative time ("2 mins ago") + total check count.
6. **Actions**: Context menu / Action buttons:
   - `[Activate / Pause]` toggle button.
   - `[Edit]` icon button.
   - `[Logs]` icon button.

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
| `EXPIRED` | Dim Gray | Clock Icon |

---

### Screen 3: Add / Edit Client Modal

A structured form modal with instant client-side validation feedback.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Add New Client Candidate                                         [X] │
├──────────────────────────────────────────────────────────────────────┤
│ PERSONAL & PASSPORT DATA                                             │
│ First Name: [ Ahmed               ]  Last Name:  [ Hassan          ] │
│ Gender:     (•) Male  ( ) Female     DoB:        [ 2002-05-14      ] │
│ Nationality:[ Egyptian            ]  Phone:      [ +201012345678   ] │
│ Email:      [ ahmed@example.com   ]                                  │
│ Passport #: [ A28491048           ]  Exp Date:   [ 2029-10-15      ] │
├──────────────────────────────────────────────────────────────────────┤
│ APPOINTMENT PREFERENCES                                              │
│ Category:   [ Aufenthaltsbewilligung Student (nur Bachelor)  ▼ ]     │
│ Start Date: [ 2026-09-01          ]  End Date:   [ 2026-10-31      ] │
│ Time Range: [ 08:00 ] – [ 15:00 ] (Cairo time)                       │
│ Allowed Days: [x] Mon [x] Tue [x] Wed [x] Thu [ ] Sat [ ] Sun        │
│ (Friday closed by the portal)                                        │
├──────────────────────────────────────────────────────────────────────┤
│                      [ Cancel ]   [ Save as Draft ]  [ Save & Validate ]│
└──────────────────────────────────────────────────────────────────────┘
```

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
