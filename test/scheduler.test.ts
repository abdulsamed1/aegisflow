import test from "node:test";
import assert from "node:assert";
import { getCairoTimeInfo, calculateMondayString } from "../src/scheduler";

test("Scheduler Engine: Cairo Time operating window evaluation", () => {
  // Fixed date: Monday Oct 5 2026 10:00 UTC (12:00 Cairo) -> Within operating window
  const openDate = new Date("2026-10-05T10:00:00Z");
  const infoOpen = getCairoTimeInfo(openDate);
  assert.strictEqual(infoOpen.dayOfWeek, "Monday");
  assert.strictEqual(infoOpen.isWithinWindow, true, "Monday 12:00 Cairo must be within window");

  // Fixed date: Friday Oct 9 2026 10:00 UTC -> Friday closed
  const fridayDate = new Date("2026-10-09T10:00:00Z");
  const infoFriday = getCairoTimeInfo(fridayDate);
  assert.strictEqual(infoFriday.dayOfWeek, "Friday");
  assert.strictEqual(infoFriday.isWithinWindow, false, "Friday must be outside operating window");
});

test("Scheduler Engine: Calculate Monday timestamp string for BMEIA", () => {
  const testDate = new Date("2026-10-07T12:00:00Z"); // Wednesday Oct 7 2026
  const mondayStr = calculateMondayString(testDate);
  assert.ok(mondayStr.startsWith("10/5/2026"), `Expected Monday Oct 5 2026, got ${mondayStr}`);
});
