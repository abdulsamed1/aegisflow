# Pre-Execution Audit & Task Tracker — BMEIA Appointment Automation (opran-booking)

> **Standard:** AGENTS.md Rule 4 (Pre-Execution Documentation) & Production Lessons.
> **Last Updated:** 2026-08-19 (post G0-gating review round)

---

## High Priority / Critical Gaps

- [ ] **[G0 Portal Evidence Capture] Document First Available Appointment Slot**
  - **Why:** Booking path structure (slot element, data entry fields, BotDetect CAPTCHA location, confirmation screen) is `UNVERIFIED` because no slots were open during the baseline capture.
  - **Context:** Booking engine fails closed (`Booking path UNVERIFIED`) until a live slot is captured per `portal-automation-spec.md` section 8. Dry-Run stays enforced.
  - **Depends on:** Live portal monitoring (24/7 scanner already running this loop).

- [ ] **[Legal Compliance] Written Operator Automation Authorization**
  - **Why:** BMEIA portal contains no visible Terms of Service or Imprint inside the wizard.
  - **Context:** Legal decision cannot be inferred from markup; explicit written operator approval required before any live booking.
  - **Depends on:** Operator decision (open question in brief section 22).

- [ ] **[P0 Security] Admin Authentication (Cloudflare Access)**
  - **Why:** The dashboard API is currently unauthenticated — anyone can list decrypted client names, create, pause, or cancel jobs.
  - **Context:** Brief section 13 proposed Cloudflare Access (free up to 50 users); decision must land in PRD and be deployed before production use.
  - **Depends on:** PRD auth decision.

---

## Core System Architecture & Implementation Tasks

- [x] **[P1] Product Requirements Document (`docs/prd.md`)** — updated to 24/7 scanning (D5) and G0-gated booking engine.
- [x] **[P1] UX Specification (`docs/ux-spec.md`)** — synced with real dashboard (Cairo font, 24/7 metric, rules fields).
- [x] **[P1] Technical Architecture (`docs/architecture.md`)** — single `status` source (jobs only), corrected measured latencies, booking flow marked UNVERIFIED.
- [x] **[P1] Epics & User Stories (`docs/epics-and-stories.md`)** — Story 3.3 converted to first-slot capture spike.
- [x] **[P1] Cloudflare Worker Project Scaffolding** — `wrangler.toml`, `package.json`, `tsconfig.json`, `db/schema.sql`, worker entry point.
- [x] **[P2] Direct HTTP Discovery Engine** — `POST /HomeWeb/Scheduler` with warmed session cookies (KV) and 3-state G0 contract (measured ~270ms avg).
- [x] **[P2] Fair 24/7 Scheduler** — up to 3 jobs/tick by oldest `last_check`, week-range scan inside client's accepted dates.
- [x] **[P2] Durable Object Job Locking** — `JobLockDO` with 5-minute crash-safe lease, release/seal lifecycle.
- [x] **[P3] Telegram Bot Notification Service** — BOOKED / DRY-RUN slot / critical alerts.
- [x] **[P3] Test Suite** — 15 passing tests + clean typecheck (see `docs/test-summary.md`).

---

## Deferred / Next

- [ ] **[P1] Integration tests on Miniflare (local Workers runtime)**
  - **Why:** Current API tests use a hand-rolled mock D1; production lessons require data actually read/written against real emulated infrastructure.
  - **Context:** Start from `test/api.test.ts` and swap the mock env for Miniflare D1/KV/DO bindings.
  - **Depends on:** `db/schema.sql` migrations running locally.

- [ ] **[P1] Replace placeholder resource IDs in `wrangler.toml`**
  - **Why:** `database_id` and KV `id` are placeholders; `wrangler deploy` will fail until real resources are created and bound.

- [ ] **[P2] Verify `placement = smart` availability on Workers Free plan**
  - **Why:** AD-8 relies on it; unverified on the free tier.

- [ ] **[P2] Confirm the 6-month passport-validity rule against official requirements**
  - **Why:** Currently an `[ASSUMPTION]` in PRD FR-2 / Story 1.3; must be confirmed before it becomes a hard validation gate.
