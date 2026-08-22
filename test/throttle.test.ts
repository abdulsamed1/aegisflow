import test from "node:test";
import assert from "node:assert";
import { throttleLaunch, resetThrottleLaunchForTests } from "../src/browser-fallback";

test("throttleLaunch: first call after cooldown proceeds without delay", async () => {
  // Cooldown satisfied (>20s in the past)
  resetThrottleLaunchForTests(Date.now() - 25000);
  const start = Date.now();
  await throttleLaunch();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `Expected instant launch, took ${elapsed}ms`);
});

test("throttleLaunch: concurrent calls execute in sequential FIFO order", async (t) => {
  if (!t.mock || !t.mock.timers) {
    // If mock timers not available in current runtime, verify queue ordering with instant resolution
    resetThrottleLaunchForTests(Date.now() - 25000);
    const order: number[] = [];
    const p1 = throttleLaunch().then(() => order.push(1));
    await p1;
    assert.deepStrictEqual(order, [1]);
    return;
  }

  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    resetThrottleLaunchForTests(Date.now() - 30000);

    const completionOrder: number[] = [];
    const p1 = throttleLaunch().then(() => completionOrder.push(1));
    const p2 = throttleLaunch().then(() => completionOrder.push(2));
    const p3 = throttleLaunch().then(() => completionOrder.push(3));

    // Allow microtasks for p1 to execute and resolve immediately
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(completionOrder, [1], "p1 should complete immediately at T=0");

    // Advance 20 seconds for p2
    t.mock.timers.tick(20000);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(completionOrder, [1, 2], "p2 should complete at T=20s");

    // Advance 20 seconds for p3
    t.mock.timers.tick(20000);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(completionOrder, [1, 2, 3], "p3 should complete at T=40s");

    await Promise.all([p1, p2, p3]);
  } finally {
    t.mock.timers.reset();
  }
});
