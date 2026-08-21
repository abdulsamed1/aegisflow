# KAIRO + Bachelor Only MVP Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict the booking automation system to the Bachelor category (44281520) and update documentation to reflect the focus and the repaired scanner contract.

**Architecture:** Update gates, API validators, dashboard HTML, tests, and documentation. Keep the database schema intact to avoid database migration overhead.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare D1, Miniflare, node --test.

## Global Constraints
- Target Office: KAIRO
- Target Calendar ID: 44281520 (Bachelor)
- Only allowed category: Bachelor
- Verify all 117 tests pass successfully

---

### Task 1: Update Pre-Submit Gate Validation

**Files:**
- Modify: `src/pre-submit-gate.ts:13-16`
- Test: `test/edge-cases-and-failures.test.ts`

- [ ] **Step 1: Write/Update the pre-submit gate validation**
  Update `src/pre-submit-gate.ts`:
  ```typescript
  const KNOWN_CALENDAR_IDS = [44281520] as const;
  const VALID_GENDERS = ["Male", "Female"] as const;
  const VALID_CATEGORIES = ["Bachelor"] as const;
  ```
- [ ] **Step 2: Run verification**
  Run: `npm run typecheck`
  Expected: Success.

- [ ] **Step 3: Commit**
  ```bash
  git add src/pre-submit-gate.ts
  git commit -m "feat: restrict pre-submit gate to Bachelor category and calendar ID"
  ```

---

### Task 2: Restrict Endpoints and UI in Worker

**Files:**
- Modify: `src/index.ts`
- Test: `test/api.test.ts`

- [ ] **Step 1: Enforce Bachelor only in POST and PUT API routes**
  Update `src/index.ts` lines 251-256 and 354-359 to check `body.category !== "Bachelor"`. Update calendarId assignment to 44281520.
- [ ] **Step 2: Update HTML template**
  Remove the `<option value="Master_PhD">` option from the select dropdown in `src/index.ts`.
- [ ] **Step 3: Run verification**
  Run: `npm run typecheck`
  Expected: Success.
- [ ] **Step 4: Commit**
  ```bash
  git add src/index.ts
  git commit -m "feat: restrict API endpoints and UI to Bachelor category only"
  ```

---

### Task 3: Update Test Suite

**Files:**
- Modify: `test/api.test.ts`
- Modify: `test/integration.miniflare.test.ts`
- Modify: `test/edge-cases-and-failures.test.ts`

- [ ] **Step 1: Adjust test cases for Bachelor-only category**
  Update `test/api.test.ts` to expect rejection of `Master_PhD` and use `Bachelor` in other tests.
  Update `test/integration.miniflare.test.ts` to use `Bachelor` in the update test.
  Update `test/edge-cases-and-failures.test.ts` to include `Master_PhD` as an invalid category in `invalidEnums`.
- [ ] **Step 2: Run verification**
  Run: `node --import tsx --test test/*.test.ts`
  Expected: 117 tests passing.
- [ ] **Step 3: Commit**
  ```bash
  git add test/api.test.ts test/integration.miniflare.test.ts test/edge-cases-and-failures.test.ts
  git commit -m "test: align test suite with Bachelor-only constraints"
  ```

---

### Task 4: Update Documentation

**Files:**
- Modify: `docs/portal-automation-spec/1.md`
- Modify: `docs/portal-automation-spec/4-wizard.md`
- Modify: `docs/portal-automation-spec/5-discovery.md`
- Modify: `docs/prd/5-functional-requirements-fr.md`
- Modify: `docs/product-breif/11-rules.md`
- Modify: `docs/product-breif/6-2026-08-19.md`
- Modify: `docs/epics-and-stories/t-track-current-progress.md`

- [ ] **Step 1: Update documentation files**
  Rewrite documentation references to focus on `Bachelor` (44281520) and update the scanner detection contract in `docs/portal-automation-spec/5-discovery.md` and `docs/prd/5-functional-requirements-fr.md` to match the repaired scanner.
- [ ] **Step 2: Commit**
  ```bash
  git add docs/
  git commit -m "docs: align documentation with Bachelor focus and repaired scanner"
  ```
