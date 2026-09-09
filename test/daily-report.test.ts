import test from "node:test";
import assert from "node:assert";
import { aggregateDailyReport, filterRowsByCairoDay } from "../src/daily-report";
import { getCairoDateString } from "../src/scheduler";

function row(job_id: string, event_type: string, week: string, created_at: string): any {
  return { job_id, client_id: `c_${job_id}`, event_type, details: JSON.stringify({ week }), created_at };
}

//  minimal fixtures per validation spec
test("daily-report: same-slot persisting across ticks must not overcount", () => {
  const day = "2026-08-21";
  const rows = [
    row("j1", "APPOINTMENT_FOUND", "8/18/2026", "2026-08-21 08:00:00"),
    row("j1", "APPOINTMENT_FOUND", "8/18/2026", "2026-08-21 08:01:00"),
    row("j1", "APPOINTMENT_FOUND", "8/18/2026", "2026-08-21 08:02:00"),
  ];
  const agg = aggregateDailyReport(rows, day);
  assert.strictEqual(agg.opportunities_found, 1);
  assert.strictEqual(agg.was_open, true);
});

test("daily-report: slot found then SLOT_GONE must count as missed (B)", () => {
  const day = "2026-08-21";
  const rows = [
    row("j1", "APPOINTMENT_FOUND", "8/18/2026", "2026-08-21 09:00:00"),
    { job_id: "j1", client_id: "c_j1", event_type: "SLOT_GONE_PRE_LAUNCH", details: JSON.stringify({ week: "8/18/2026" }), created_at: "2026-08-21 09:01:00" },
  ];
  const agg = aggregateDailyReport(rows, day);
  assert.strictEqual(agg.opportunities_missed, 1);
  assert.strictEqual(agg.opportunities_booked, 0);
});

test("daily-report: slot found then BOOKED must not count as missed", () => {
  const day = "2026-08-21";
  const rows = [
    row("j1", "APPOINTMENT_FOUND", "8/18/2026", "2026-08-21 10:00:00"),
    { job_id: "j1", client_id: "c_j1", event_type: "BOOKED", details: JSON.stringify({ week: "8/18/2026" }), created_at: "2026-08-21 10:02:00" },
  ];
  const agg = aggregateDailyReport(rows, day);
  assert.strictEqual(agg.opportunities_booked, 1);
  assert.strictEqual(agg.opportunities_missed, 0);
});

test("daily-report: day with zero APPOINTMENT_FOUND was_open false", () => {
  const agg = aggregateDailyReport([], "2026-08-21");
  assert.strictEqual(agg.was_open, false);
  assert.strictEqual(agg.opportunities_found, 0);
});

test("daily-report: Cairo-day bucketing across UTC midnight boundary", () => {
  // 2026-08-21 22:00 UTC = 2026-08-22 01:00 Cairo (UTC+3 DST) — must bucket to 08-22, not 08-21
  const rows = [
    row("j1", "APPOINTMENT_FOUND", "8/18/2026", "2026-08-21 22:00:00"),
  ];
  assert.strictEqual(getCairoDateString(new Date("2026-08-21T22:00:00Z")), "2026-08-22");
  const filtered21 = filterRowsByCairoDay(rows, "2026-08-21");
  const filtered22 = filterRowsByCairoDay(rows, "2026-08-22");
  assert.strictEqual(filtered21.length, 0);
  assert.strictEqual(filtered22.length, 1);
});

test("daily-report: distinct weeks are separate opportunities", () => {
  const day = "2026-08-21";
  const rows = [
    row("j1", "APPOINTMENT_FOUND", "8/18/2026", "2026-08-21 08:00:00"),
    row("j1", "APPOINTMENT_FOUND", "8/25/2026", "2026-08-21 08:01:00"),
  ];
  const agg = aggregateDailyReport(rows, day);
  assert.strictEqual(agg.opportunities_found, 2);
});

test("daily-report: BOOKING_FAILED alone counts as missed, BOOKED overrides it", () => {
  const day = "2026-08-21";
  const rowsFailed = [
    row("j1", "APPOINTMENT_FOUND", "8/18/2026", "2026-08-21 11:00:00"),
    { job_id: "j1", client_id: "c_j1", event_type: "BOOKING_FAILED", details: JSON.stringify({ week: "8/18/2026" }), created_at: "2026-08-21 11:01:00" },
  ];
  assert.strictEqual(aggregateDailyReport(rowsFailed, day).opportunities_missed, 1);
  const rowsOverridden = [
    row("j1", "APPOINTMENT_FOUND", "8/18/2026", "2026-08-21 11:00:00"),
    { job_id: "j1", client_id: "c_j1", event_type: "BOOKING_FAILED", details: JSON.stringify({ week: "8/18/2026" }), created_at: "2026-08-21 11:01:00" },
    { job_id: "j1", client_id: "c_j1", event_type: "BOOKED", details: JSON.stringify({ week: "8/18/2026" }), created_at: "2026-08-21 11:02:00" },
  ];
  assert.strictEqual(aggregateDailyReport(rowsOverridden, day).opportunities_missed, 0);
  assert.strictEqual(aggregateDailyReport(rowsOverridden, day).opportunities_booked, 1);
});

test("daily-report: empty or null week and detached rows are ignored", () => {
  const day = "2026-08-21";
  const rows: any[] = [
    { job_id: "j1", client_id: "c_j1", event_type: "APPOINTMENT_FOUND", details: JSON.stringify({ week: "" }), created_at: "2026-08-21 12:00:00" },
    { job_id: null, client_id: null, event_type: "APPOINTMENT_FOUND", details: JSON.stringify({ week: "8/18/2026" }), created_at: "2026-08-21 12:01:00" },
    { job_id: "j2", client_id: "c_j2", event_type: "APPOINTMENT_FOUND", details: JSON.stringify({ matchedMonday: "8/18/2026" }), created_at: "2026-08-21 12:02:00" },
  ];
  const agg = aggregateDailyReport(rows, day);
  assert.strictEqual(agg.opportunities_found, 1);
  assert.strictEqual(agg.was_open, true);
});

test("daily-report: Invalid Date rows are filtered safely", () => {
  const rows: any[] = [
    row("j1", "APPOINTMENT_FOUND", "8/18/2026", "bad-timestamp"),
    row("j1", "APPOINTMENT_FOUND", "8/18/2026", "2026-08-21 13:00:00"),
  ];
  assert.strictEqual(filterRowsByCairoDay(rows, "2026-08-21").length, 1);
});
