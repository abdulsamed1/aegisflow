import test from "node:test";
import assert from "node:assert";
import {
  executePlaywrightFallback,
  resetThrottleLaunchForTests,
} from "../src/browser-fallback";

// Regression (prod 2026-09-06/08/10, job_1788962419784): each crashed booking
// pair billed ~20 "browser seconds" to daily_metrics while doing zero browser
// work. Root cause: executePlaywrightFallback() captures startTime BEFORE
// await throttleLaunch(), so the mandatory 20s launch-spacing wait (NFR-2) is
// included in every durationSeconds return — and scheduled() writes that value
// straight into total_browser_seconds, against which isCircuitBreakerTripped()
// compares the 540s budget. durationSeconds must cover only post-throttle
// browser/portal work.

const BACHELOR_CLIENT: any = { category: "Bachelor", calendarId: 44281520 };

test("durationSeconds excludes throttleLaunch queue wait (fast failure after full 20s gate)", async (t) => {
  if (!t.mock || !t.mock.timers) {
    t.skip("node:test mock timers unavailable — cannot simulate the 20s gate");
    return;
  }

  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    // lastLaunchAt = "just now" forces the next call to wait the full ~20s gate.
    resetThrottleLaunchForTests(Date.now());

    // Launcher fails IMMEDIATELY once the throttle releases it, isolating
    // "time in throttle" from "time in browser work" (post-throttle ≈ 0ms).
    const pending = executePlaywrightFallback({}, BACHELOR_CLIENT, {
      launcher: async () => {
        throw new Error("Unable to create new browser: code: 429: message: Rate limit exceeded");
      },
    } as any);

    // Let the call reach throttleLaunch's internal setTimeout, then fast-forward.
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(20000);
    await new Promise((r) => setImmediate(r));

    const res = await pending;
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.classification, "LAUNCH_ERROR");
    assert.ok(
      res.durationSeconds < 5,
      `durationSeconds must exclude the ~20s throttle wait (post-throttle work was instant). Got ${res.durationSeconds}s`
    );
  } finally {
    t.mock.timers.reset();
    resetThrottleLaunchForTests(0);
  }
});
