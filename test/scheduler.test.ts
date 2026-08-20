import test from "node:test";
import assert from "node:assert";
import { getCairoTimeInfo, calculateMondayString, rollingMondays } from "../src/scheduler";
import worker from "../src/index";

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

test("Scheduler Engine: global window includes Friday", () => {
  const friday = new Date("2026-10-09T10:00:00Z"); // 13:00 Cairo, Friday
  assert.strictEqual(getCairoTimeInfo(friday).isWithinWindow, true);
});

test("Scheduler Engine: inside global window on a weekday", () => {
  const sunday = new Date("2026-10-04T08:00:00Z"); // 11:00 Cairo, Sunday
  assert.strictEqual(getCairoTimeInfo(sunday).isWithinWindow, true);
});

test("Scheduler Engine: 07:00 Cairo is inside, 18:00 Cairo is outside", () => {
  // October 2026 is Cairo DST (UTC+3) — boundary instants computed for that offset
  assert.strictEqual(getCairoTimeInfo(new Date("2026-10-04T04:00:00Z")).isWithinWindow, true);
  assert.strictEqual(getCairoTimeInfo(new Date("2026-10-04T15:00:00Z")).isWithinWindow, false);
});

test("Scheduler Engine: midnight Cairo is outside the window", () => {
  assert.strictEqual(getCairoTimeInfo(new Date("2026-10-04T21:00:00Z")).isWithinWindow, false);
});

test("Scheduler Engine: outside window before 07:00 and after 18:00", () => {
  assert.strictEqual(getCairoTimeInfo(new Date("2026-10-04T03:59:00Z")).isWithinWindow, false);
  assert.strictEqual(getCairoTimeInfo(new Date("2026-10-04T16:00:00Z")).isWithinWindow, false);
});

test("Scheduler Engine: rolling horizon returns current week plus 7 Mondays", () => {
  const mondays = rollingMondays(new Date("2026-10-07T12:00:00Z"));
  assert.strictEqual(mondays.length, 8);
  assert.ok(mondays[0].startsWith("10/5/2026"), `First must be Oct 5, got ${mondays[0]}`);
  assert.ok(mondays[7].startsWith("11/23/2026"), `Eighth must be Nov 23, got ${mondays[7]}`);
  for (const m of mondays) assert.ok(m.endsWith("12:00:00 AM"), "BMEIA format");
});

test("Scheduler Engine: rolling horizon crosses year boundary", () => {
  const mondays = rollingMondays(new Date("2026-12-22T12:00:00Z"));
  assert.strictEqual(mondays.length, 8);
  assert.ok(mondays[0].startsWith("12/21/2026"));
  assert.ok(mondays[7].startsWith("2/8/2027"));
});

test("Scheduler Engine: scheduled tick exits before any DB read outside the global window", async () => {
  let dbTouched = false;
  const env: any = {
    DB: new Proxy({}, {
      get: () => {
        dbTouched = true;
        throw new Error("DB touched outside window");
      }
    })
  };
  // 19:00 Cairo (Oct 4 16:00Z, DST +3) → outside window
  await worker.scheduled({} as any, env, {} as any, new Date("2026-10-04T16:00:00Z"));
  assert.strictEqual(dbTouched, false, "Gate must exit before the first DB read");

  // 11:00 Cairo (Oct 4 08:00Z) → inside window → must reach the DB (discriminating control)
  await assert.rejects(
    worker.scheduled({} as any, env, {} as any, new Date("2026-10-04T08:00:00Z")),
    /DB touched/
  );
});
