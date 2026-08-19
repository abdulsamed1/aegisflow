import test from "node:test";
import assert from "node:assert";
import { getCairoTimeInfo, calculateMondayString, listMondaysInRange } from "../src/scheduler";

test("Scheduler Engine: Cairo time info returns weekday names for display", () => {
  const fixed = new Date("2026-10-09T10:00:00Z"); // Friday Oct 9 2026
  const info = getCairoTimeInfo(fixed);
  assert.strictEqual(info.dayOfWeek, "Friday");
  assert.strictEqual(typeof info.formattedCairoTime, "string");
});

test("Scheduler Engine: Calculate Monday timestamp string for BMEIA", () => {
  const testDate = new Date("2026-10-07T12:00:00Z"); // Wednesday Oct 7 2026
  const mondayStr = calculateMondayString(testDate);
  assert.ok(mondayStr.startsWith("10/5/2026"), `Expected Monday Oct 5 2026, got ${mondayStr}`);
  assert.ok(mondayStr.endsWith("12:00:00 AM"), "Must match BMEIA M/d/yyyy h:mm:ss tt format");
});

test("Scheduler Engine: Week range scan respects client accepted date window", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const mondays = listMondaysInRange("2026-10-01", "2026-10-31", now);

  assert.ok(mondays.length >= 1, "Must return at least one Monday within window");
  assert.ok(mondays[0].startsWith("10/5/2026"), "First Monday must be Oct 5 2026 (current week)");
  for (const m of mondays) {
    const monthDay = m.split(" ")[0];
    const month = parseInt(monthDay.split("/")[0], 10);
    const day = parseInt(monthDay.split("/")[1], 10);
    assert.ok(month >= 10 && day <= 31, `Monday ${monthDay} must not exceed the window`);
  }
  assert.ok(!mondays.some((m) => m.startsWith("11/")), "No Mondays past end_date (Oct 31)");
});
