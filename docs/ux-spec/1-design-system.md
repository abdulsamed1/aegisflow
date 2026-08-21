# 1. Design System

## 1.1 Color Palette (shipped tokens — `src/index.ts` `:root`, v6 Paper Dossier)

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

## 1.2 Typography

- **Primary:** `Alexandria` variable (Arabic + Latin, weights 400–800, one Google Fonts request, `display=swap`). Headings/brand 800, labels 600, body 400–500. Fallback stack `system-ui, -apple-system, sans-serif` only behind the webfont.
- **Monospace:** **no webfont — v6 drops the JetBrains Mono request** (one fewer network request): system mono stack `ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace` with `font-variant-numeric: tabular-nums`, `direction: ltr; display: inline-block` — reserved for IDs, masked passport numbers, timestamps, statistics, and error codes.
- No Inter, no Roboto, no Cairo (v1 font, dropped in v2), no JetBrains Mono (dropped in v6).

## 1.3 Layout & Spacing

- Single-view SPA: `header` → metric ribbon → table card → modal. No tabs, no navigation — the operator's whole job is on one screen.
- Container max-width 1400px; body padding 24px (12px below 768px).
- Card radii 12px; pill radii 999px; control (button/input/select) radii 8px; grid gap 16px (10px below 768px).
- Responsive: metrics auto-fit `minmax(240px, 1fr)`; below 768px two columns, below 480px one column; table scrolls horizontally (`min-width: 580px`) with `-webkit-overflow-scrolling: touch`.

## 1.4 Elevation & Shape

- Cards: 1px `--border` hairline on paper surfaces; **no drop shadows** (all v3–v5 shadows removed; light theme needs none — tone + rules carry separation).
- Paper-weave texture: `body::before` carries two static repeating-linear-gradient bands at ~2% alpha — subtle paper fiber, no animation, GPU-free. The one texture on screen.
- The **featured** metric card (active candidates) spans 2 grid columns and is a **full burnt-red band** (`--primary` background, `--primary-ink` paper text) — the red surface IS the signal; no glow, no gradient.

## 1.5 Motion

- Transitions on `transform`/`background-color`/`border-color` only, 200–300ms. No transform on layout properties, no infinite animations except the skeleton shimmer.
- First-load reveal: metric cards stagger in via `rise` keyframe (opacity + 10px translateY, 0.06s cascade, 0.4s each).
- Skeleton rows: 200% background-position shimmer loop (1.2s).
- **`prefers-reduced-motion: reduce` kills all animation and transitions** (`animation: none !important; transition: none !important`).

---
