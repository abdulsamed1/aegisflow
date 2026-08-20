---
title: 'Global operating rules refactor (D5/D8/AD-11) + complete client profile'
type: 'refactor'
created: '2026-08-20'
status: 'done'
baseline_commit: '6ffcf5f'
review_loop_iteration: 0
context:
  - '{project-root}/opran-booking/docs/prd.md'
  - '{project-root}/opran-booking/docs/architecture.md'
  - '{project-root}/opran-booking/docs/ux-spec.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The admin form still enforces per-client appointment rules (start/end date, time range, accepted days) that the operator removed on 2026-08-20, and the client profile is missing BMEIA birth/address/passport-issue fields visible in the reference screenshots. The scheduler still scans per-client date windows, marks jobs `EXPIRED`, and carries a dead Sat–Thu 07–15 gate.

**Approach:** Enforce one global operating rule for all ACTIVE requests: Cairo 07:00–18:00 daily (Friday included) with a rolling 8-week horizon; requests stay ACTIVE forever until `BOOKED`/`CANCELLED`. Remove the schedule controls from the form, add the missing fields, and expose the existing cancel endpoint in the UI.

## Boundaries & Constraints

**Always:**
- Global window: 07:00–18:00 Africa/Cairo, every day including Friday. Outside it the cron tick exits immediately — before any DB read.
- Horizon: current week + 7 forward Mondays (8 weeks, global constant) for every ACTIVE job. Replaces `start_date`/`end_date` scanning entirely.
- No date-based expiry: no code path sets `EXPIRED`. The enum stays in the schema CHECK for compatibility only.
- Legacy job columns (`start_date`, `end_date`, `allowed_days`, `preferred_time_start/end`) are written once with global constants (07:00/18:00, all 7 days, horizon span) and never read by the scheduler.
- Encryption split per AD schema: encrypted — `family_name_at_birth_enc`, `address_street_enc`, `address_postal_code_enc`, `address_city_enc`; plaintext — `place_of_birth`, `country_of_birth`, `nationality_at_birth`, `passport_issue_date`, `passport_issuing_country` (same class as current `dob`/`nationality`).
- G0 unchanged: booking stays fail-closed dry-run; no live-booking enablement here.
- TDD red-green-refactor for every code change. No hardcoded secrets.

**Ask First:** Production D1 migration (new ALTER statements), and deployment. HALT and ask before touching production.

**Never:** No per-client schedule customization; no new endpoints (cancel already exists); no changes to `scanner.ts`/`booking-http.ts` booking logic beyond the `DecryptedClientData` field additions; no deleting the `EXPIRED` enum value; no unrelated refactors (telegram, locks, metrics).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | ACTIVE job, tick 14:00 Cairo Sunday | Scan proceeds against 8 rolling Mondays (current week + 7) | N/A |
| EDGE_OUTSIDE_WINDOW | Tick 19:00 or 06:59 Cairo | Tick exits immediately, no DB access | N/A |
| EDGE_FRIDAY | Tick 10:00 Cairo Friday | Scan proceeds (Friday is a workday) | N/A |
| EDGE_BOUNDARY_1800 | Tick exactly 18:00:00 Cairo | Outside window (interval `[07:00, 18:00)`); tick exits | N/A |
| EDGE_YEAR_ROLLOVER | Now = Dec 22 | Horizon crosses into January; Mondays continue correctly | N/A |
| EDGE_LEGACY_PAST_DATES | Job with stored `end_date` already in the past | Job still scanned on the rolling horizon; never `EXPIRED` | N/A |
| ERROR_MISSING_FIELD | POST /api/clients missing one of the 9 new required fields | 400 with field-specific message; nothing written | 400 JSON `{ error }` |
| EDGE_CANCEL | `POST /api/jobs/:id/cancel` on ACTIVE job | Job → `enabled=0`, `CANCELLED`; excluded from scheduler picks | N/A |

</frozen-after-approval>

## Code Map

- `src/scheduler.ts` -- window gate (`getCairoTimeInfo`), `rollingMondays` (new), `SCHEDULER_PICK_QUERY`; `listMondaysInRange` (delete)
- `src/index.ts` -- `scheduled` handler (gate + rolling scan, remove EXPIRED), `POST /api/clients`, `getAdminHTML` modal (lines ~670-799)
- `db/schema.sql` -- `clients` +9 columns; legacy `jobs` columns semantics unchanged
- `src/booking-http.ts` -- `DecryptedClientData` shape (add fields)
- `src/crypto.ts` -- reuse `encryptPII`/`decryptPII` (no change)
- `test/scheduler.test.ts`, `test/api.test.ts`, `test/integration.miniflare.test.ts` -- TDD targets; integration test embeds its own schema copy (lines 16-74) that must mirror `db/schema.sql`

## Tasks & Acceptance

**Execution:**
- [x] `test/scheduler.test.ts` -- RED: window gate (inside/outside/Friday/18:00 boundary), `rollingMondays` (8 Mondays, year rollover, legacy-window discrimination), no-EXPIRED behavior -- replaces the old `listMondaysInRange` assertions
- [x] `src/scheduler.ts` -- GREEN: rewrite `getCairoTimeInfo` gate to daily 07:00-18:00 Cairo; add pure `rollingMondays(horizonWeeks=8, now)`; delete `listMondaysInRange` and drop `start_date`/`end_date` from `SCHEDULER_PICK_QUERY`'s SELECT -- window/horizon are global, per-client columns are write-only legacy
- [x] `db/schema.sql` -- add the 9 `clients` columns (encrypted per class, NOT NULL like siblings) -- single source of truth
- [x] `src/index.ts` -- gate `scheduled` first via `getCairoTimeInfo().isWithinWindow`; iterate `rollingMondays()` per job; delete the EXPIRED transition; extend `POST /api/clients` (9 new fields, required validation → 400, encrypt per class, INSERT) and `GET` decrypt path; rewrite modal: remove startDate/endDate/timeStart/timeEnd/day-checkboxes, add 9 fields + read-only global-rules block (07:00-18:00 Cairo daily, active until booked/cancelled) + Cancel button calling the existing cancel endpoint -- one form, one operating model
- [x] `src/booking-http.ts` -- extend `DecryptedClientData` with the new fields; decrypt the new encrypted columns in the handler before booking payload build -- booking payload completeness, no behavior change
- [x] `test/api.test.ts` -- RED: POST with new fields creates encrypted client (assert 400 on missing required field); GET /admin HTML asserts new fields + global-rules block + cancel control present and no `startDate`/`timeStart`/`.day-check` controls -- UI contract regression guard
- [x] `test/integration.miniflare.test.ts` -- update embedded schema copy; add: new encrypted fields stored as ciphertext and decrypted on read; legacy job columns written with global constants -- real D1 proof
- [x] `docs/test-summary.md` + `Todo.md` -- flip pending `[ ]` items to done, check off §3 item 1 -- docs drift prevention (AGENTS.md rule)

**Acceptance Criteria:**
- Given an enabled ACTIVE job, when a tick runs inside the Cairo 07:00-18:00 window (any day, Friday included), then the job scans exactly the current week plus the next 7 Mondays regardless of its stored `start_date`/`end_date`, and is never marked `EXPIRED`.
- Given a tick outside the window, when the `scheduled` handler runs, then it returns before any DB query.
- Given a client POST carrying the full new-field payload, when saved, then PII columns are stored encrypted per class and plaintext columns per architecture; a POST missing any required field returns 400 and writes nothing.
- Given the admin dashboard, when rendered, then the client form shows the 9 new fields, the read-only global-rules block, and a working Cancel action; no per-client date/time/day controls exist.
- Given `npm test` and `npm run typecheck`, when run, then all suites pass with output pristine.

## Spec Change Log

## Design Notes

- Window semantics: half-open interval `[07:00, 18:00)` Africa/Cairo, computed via `Intl.DateTimeFormat` weekday + hour (the existing mechanism), with Friday no longer excluded.
- `rollingMondays` returns BMEIA-format strings (`M/d/yyyy 12:00:00 AM`, reuse `calculateMondayString`) for the Monday of the current week and the next 7 Mondays.
- Legacy constants at job insert: `allowed_days` = all 7 days (JSON), `preferred_time_start` = "07:00", `preferred_time_end` = "18:00", `start_date` = today ISO, `end_date` = today + 56 days ISO. Values are cosmetic for DB inspection only — the scheduler never reads them.
- Existing defaults preserved: `nationality` = "Egyptian", `gender` = "Male"; `calendar_id` derived from category as today.

## Verification

**Commands:**
- `npm test` -- expected: all suites green, output pristine
- `npm run typecheck` -- expected: clean `tsc --noEmit`
- `npx wrangler deploy --dry-run` -- expected: bundle builds

## Suggested Review Order

**Global scheduling rule (entry point)**

- One global gate replaces the dead per-day list — the whole D5 decision in two lines
  [`scheduler.ts:38`](../../src/scheduler.ts#L38)

- Tick exits before any DB read; `now` param is the test seam for the gate
  [`index.ts:258`](../../src/index.ts#L258)

- 8-week rolling horizon constant + pure function replacing `listMondaysInRange`
  [`scheduler.ts:79`](../../src/scheduler.ts#L79)

- Pick query drops the legacy per-client date columns entirely (D8/AD-11)
  [`scheduler.ts:62`](../../src/scheduler.ts#L62)

- Horizon computed once per tick, EXPIRED transition deleted
  [`index.ts:289`](../../src/index.ts#L289)

**Client profile & boundary validation**

- Boundary validation: invalid JSON, null, non-string, missing required fields → 400
  [`index.ts:128`](../../src/index.ts#L128)

- 21-column INSERT with class-based encryption split
  [`index.ts:145`](../../src/index.ts#L145)

- 9 new schema columns; legacy job columns annotated as never-read
  [`db/schema.sql:18`](../../db/schema.sql#L18)

- Production migration artifact (operator-gated, DEFAULT '' safe on rows)
  [`0001_clients_global_rules.sql:1`](../../db/migrations/0001_clients_global_rules.sql#L1)

- Booking-data contract extended for G0 close
  [`booking-http.ts:8`](../../src/booking-http.ts#L8)

**Admin dashboard UX**

- Global-rules info block replacing per-client date/time/day controls
  [`index.ts:747`](../../src/index.ts#L747)

- Terminal states rendered without resurrect buttons; cancel action wired
  [`index.ts:904`](../../src/index.ts#L904)

- Form surfaces server 400s; status tile reflects window state
  [`index.ts:873`](../../src/index.ts#L873)

**Correctness guards from review**

- BOOKED write guarded against a cancel landing mid-booking (D8 terminal semantics)
  [`index.ts:416`](../../src/index.ts#L416)

**Tests**

- Gate boundary matrix, midnight, horizon spans, tick-level no-DB-read discriminator
  [`scheduler.test.ts:29`](../../test/scheduler.test.ts#L29)

- API contract: 400 matrix, cancel endpoint, stored-row column positions
  [`api.test.ts:123`](../../test/api.test.ts#L123)

- Real-D1 proof: encryption classes at rest, legacy constants, no date-column read
  [`integration.miniflare.test.ts:120`](../../test/integration.miniflare.test.ts#L120)
