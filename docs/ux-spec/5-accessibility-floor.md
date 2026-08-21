# 5. Accessibility Floor

- Full RTL: `dir=rtl` document, Arabic microcopy; LTR islands (`direction: ltr`) only where the domain data is LTR (mono values, email, phone).
- Semantic markup: real `table/th/td`, real `label` + `input` pairing, `button` elements (no div-click handlers), native `confirm()` for destructive actions (benign for SR users — system dialog).
- Modal close gets `aria-label="إغلاق"`; the error box is `role="alert"` (custom `.alert`, not Bootstrap).
- Keyboard: all actions reachable (native buttons/inputs), focus rings visible, Escape/save flows not overridden.
- Contrast: ink `#23201a` on parchment `#f4efe6` (~14:1); body `#4a4438` on paper `#fbf8f1` (~8:1); paper `#fbf8f1` on red `#b33a2b` (~6:1) — all above WCAG AA even at small sizes (red on paper 6:1 clears AA large/UI components; semantic tints stay in the pill text).
- `prefers-reduced-motion`: all animation disabled.

---
