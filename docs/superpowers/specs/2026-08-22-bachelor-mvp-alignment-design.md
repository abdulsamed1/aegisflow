# 2026-08-22 Bachelor MVP Alignment Design

This document details the design for restricting the BMEIA appointment automation system to the MVP scope: **KAIRO** office and **CalendarId 44281520** (Aufenthaltsbewilligung Student – Bachelor) only, and documents the repaired scanner detection contract.

## Design Goals
1. **Strict Application-Level Constraint**: Prevent creation, update, or execution of booking jobs for any category other than `Bachelor`.
2. **UI Simplification**: Remove the option for `Master_PhD` from the Operator Admin Dashboard to prevent user selection.
3. **Correct Detection Contract Documentation**: Document the repaired scanner logic in the specifications to match the implementation in `src/scanner.ts` (which ignores the presence of `Please choose an appointment!` class `message-error` on valid slot pages).
4. **Test Alignment**: Update all unit and integration tests to use the `Bachelor` category and calendar ID `44281520`, and ensure they pass.

## Proposed Changes

### 1. Application Logic & Validation

#### [pre-submit-gate.ts](file:///home/abdu/production/opran-booking/src/pre-submit-gate.ts)
- Restrict `KNOWN_CALENDAR_IDS` to only `[44281520]`.
- Restrict `VALID_CATEGORIES` to only `["Bachelor"]`.

#### [index.ts](file:///home/abdu/production/opran-booking/src/index.ts)
- Update POST `/api/clients` validator to reject any category other than `"Bachelor"`.
- Update PUT `/api/clients/:id` validator to reject any category other than `"Bachelor"`.
- Update calendar ID assignment to default directly to `44281520`.
- In the Admin Dashboard HTML modal form, remove the select option for `Master_PhD` so that the select dropdown only presents `Bachelor`.

### 2. Test Suite Updates

#### [api.test.ts](file:///home/abdu/production/opran-booking/test/api.test.ts)
- Change tests that previously used `Master_PhD` to test the validation error when using `Master_PhD` (it should return `400 Bad Request` with `Invalid category. Must be 'Bachelor'`).
- Update client creation payloads in all other tests to use `Bachelor`.

#### [integration.miniflare.test.ts](file:///home/abdu/production/opran-booking/test/integration.miniflare.test.ts)
- Update PUT client update integration test to use `Bachelor` instead of `Master_PhD`.

#### [edge-cases-and-failures.test.ts](file:///home/abdu/production/opran-booking/test/edge-cases-and-failures.test.ts)
- Include `Master_PhD` in the list of invalid/non-supported categories checked in the gate case-sensitivity test.

### 3. Documentation Alignment

#### [1.md](file:///home/abdu/production/opran-booking/docs/portal-automation-spec/1.md)
- Update Section 1 to mention that only `Bachelor` (CalendarId `44281520`) is supported under the MVP scope.

#### [4-wizard.md](file:///home/abdu/production/opran-booking/docs/portal-automation-spec/4-wizard.md)
- Mark other categories/calendar IDs as out of scope for the MVP.

#### [5-discovery.md](file:///home/abdu/production/opran-booking/docs/portal-automation-spec/5-discovery.md)
- Update the detection contract to align with the repaired scanner:
  1. A page with `no appointments available` (case-insensitive) matches `NO_SLOTS`.
  2. A page containing radio inputs with date/time values (`value="M/D/YYYY H:MM:SS AM"`) or content in the scheduler grid matches `SLOTS`.
  3. Note that `<p class="message-error">Please choose an appointment!</p>` is NOT treated as a negative signal (no slots) since it appears on pages with slots.
  4. Anything else matches `UNKNOWN`.

#### [5-functional-requirements-fr.md](file:///home/abdu/production/opran-booking/docs/prd/5-functional-requirements-fr.md)
- Update FR-3 to state that the only supported `calendar_id` is `44281520` (Bachelor).
- Update FR-5 to align the 3-state response contract with the repaired scanner logic.

#### [11-rules.md](file:///home/abdu/production/opran-booking/docs/product-breif/11-rules.md)
- State that only `Bachelor` (44281520) is supported.

#### [6-2026-08-19.md](file:///home/abdu/production/opran-booking/docs/product-breif/6-2026-08-19.md)
- Mark Master/PhD as out of scope.

#### [t-track-current-progress.md](file:///home/abdu/production/opran-booking/docs/epics-and-stories/t-track-current-progress.md)
- Update phase G0 details.

## Verification Plan
1. **TypeScript Typecheck**: Run `npm run typecheck` to ensure no compile errors.
2. **Unit & Integration Tests**: Run `node --import tsx --test test/*.test.ts` to verify all 117 tests pass successfully.
