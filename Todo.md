# Pre-Execution Audit & Task Tracker — BMEIA Appointment Automation (opran-booking)

> **Standard:** AGENTS.md Rule 4 (Pre-Execution Documentation) & Production Lessons.
> **Last Updated:** 2026-08-19

---

## High Priority / Critical Gaps

- [ ] **[G0 Portal Evidence Capture] Document First Available Appointment Slot**
  - **Why:** Booking path structure (slot element, data entry fields, BotDetect CAPTCHA location, confirmation screen) is currently `UNVERIFIED` because no slots were open during initial baseline capture.
  - **Context:** Dry-Run mode MUST remain enforced until a live appointment slot is detected, captured, and verified.
  - **Depends on:** Live portal monitoring.

- [ ] **[Legal Compliance] Written Operator Automation Authorization**
  - **Why:** BMEIA appointment portal contains no visible Terms of Service or Imprint inside the application wizard.
  - **Context:** Legal decision cannot be inferred from portal markup; explicit written operator approval is required before lifting Dry-Run mode.
  - **Depends on:** Operator decision.

---

## Core System Architecture & Implementation Tasks

- [x] **[P1] Complete Product Requirements Document (`docs/prd.md`)**
  - **Why:** Establish single source of truth for scope, state machine, schedule rules, Telegram alerts, and D1 PII encryption.
  - **Context:** Converts `product-breif.ar.md` and `portal-automation-spec.md` into standard PRD format.

- [x] **[P1] Complete UX Specification (`docs/ux-spec.md`)**
  - **Why:** Define single-operator admin panel layout, client management forms, job status indicators, and audit log viewer.

- [x] **[P1] Complete Technical Architecture (`docs/architecture.md`)**
  - **Why:** Define Cloudflare Workers topology, D1 SQLite schema, Durable Object state locks, KV session storage, and `@cloudflare/playwright` browser integration.

- [x] **[P1] Complete Epics & User Stories (`docs/epics-and-stories.md`)**
  - **Why:** Break down platform requirements into actionable, testable epics and user stories.

- [x] **[P1] Cloudflare Worker Project Scaffolding**
  - **Why:** Initialize `wrangler.toml`, `package.json`, `tsconfig.json`, D1 `schema.sql`, and worker TypeScript entry point (`src/index.ts`).

- [x] **[P2] Direct HTTP Fast-Path Availability & Booking Engine**
  - **Why:** Execute ultra-fast direct HTTP `POST` submissions (~10ms–50ms) directly from Cloudflare Worker `fetch()` context without browser overhead.stamp (outstanding workload) rather than daily inflow count.
  - **Context:** Enforces production lesson from AGENTS.md.

- [ ] **[P2] Durable Object Job Locking**
  - **Why:** Guarantee zero double-booking by enforcing atomic state locking per client job via Durable Object.

  - **Why:** Execute fast, direct availability checks (`POST /HomeWeb/Scheduler`) without traversing multi-step wizard UI (~10ms response time).

- [ ] **[P3] Telegram Bot Notification Service**
  - **Why:** Notify operator instantly upon `BOOKED` status or critical budget/portal errors.
