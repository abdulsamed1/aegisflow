# 2. Locked Strategic Decisions (D1–D8)

| ID | Decision | Locked Value | Rationale |
|---|---|---|---|
| **D1** | Automation Scope | Autonomous booking up to final `Submit` (with mandatory initial Dry-Run mode) | Operator requirement for competitive speed |
| **D2** | MVP Scale | Up to 10 active concurrent client jobs | Micro-operator scale fitting Cloudflare Free Tier |
| **D3** | Cost Policy | $0 cost target on Cloudflare Free Tier ($5 Paid Workers fallback if needed) | Zero-cost initial deployment mandate |
| **D4** | Notifications | Telegram Bot API for Operator alerts exclusively | Streamlined single-channel operational alerts |
| **D5** | Scanning Schedule | Global Cairo operating window **07:00–18:00, every day (Friday included)**; scanning runs every minute inside the window only | Operator decision 2026-08-20 — **amends the 2026-08-19 lock (24/7, no window)**; same underlying rationale: no fixed release schedule exists on the portal |
| **D6** | User Architecture | Single Operator admin account | Simplified MVP scope without multi-tenancy |
| **D7** | Operator Authorization | "أنا أصرّح بأتمتة عملية حجز المواعيد عبر منصة BMEIA باستخدام النظام." — records the operator's explicit authorization to automate the BMEIA appointment booking process using this system | Operator statement 2026-08-19; documents operator authorization only — not BMEIA approval, not a legal conclusion |
| **D8** | Request Lifetime | A request stays `ACTIVE` **forever** until `BOOKED` or operator/client cancellation — no date-based expiry | Operator decision 2026-08-20; the `EXPIRED` state is retained only for schema compatibility — no code path sets it |

---
