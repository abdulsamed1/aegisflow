import test from "node:test";
import assert from "node:assert";
import { classifyLaunchError, executePlaywrightFallback } from "../src/browser-fallback";
import { decideRetryAction } from "../src/booking-flow";

// Regression (prod 2026-09-06/08/10, job_1788962419784): the scanner finds a
// slot, then EVERY booking attempt crashes in playwright.launch with
// "browserType.connectOverCDP: [unenv] fs.mkdtemp is not implemented yet!",
// and the blind same-tick retry deterministically 429s
// ("Unable to create new browser: code: 429: message: Rate limit exceeded").
// Both were classified UNKNOWN, so decideRetryAction kept retrying and each
// crashed pair burned ~20s of the daily browser budget doing nothing.

// --- Failure classification: platform launch errors must be LAUNCH_ERROR ---

test("classifyLaunchError: exact mkdtemp crash string from prod audit log → LAUNCH_ERROR", () => {
  assert.strictEqual(
    classifyLaunchError("browserType.connectOverCDP: [unenv] fs.mkdtemp is not implemented yet!"),
    "LAUNCH_ERROR"
  );
});

test("classifyLaunchError: exact 429 string from prod audit log → LAUNCH_ERROR", () => {
  assert.strictEqual(
    classifyLaunchError("Unable to create new browser: code: 429: message: Rate limit exceeded"),
    "LAUNCH_ERROR"
  );
});

test("classifyLaunchError: missing MYBROWSER binding → LAUNCH_ERROR", () => {
  assert.strictEqual(
    classifyLaunchError("Cloudflare MYBROWSER binding not configured."),
    "LAUNCH_ERROR"
  );
});

test("classifyLaunchError: navigation timeout stays TRANSIENT_ERROR (existing behavior preserved)", () => {
  assert.strictEqual(
    classifyLaunchError("Navigation timeout of 30000 ms exceeded"),
    "TRANSIENT_ERROR"
  );
});

test("classifyLaunchError: genuinely unknown message stays UNKNOWN (existing behavior preserved)", () => {
  assert.strictEqual(classifyLaunchError("some unexpected boom"), "UNKNOWN");
});

// --- Retry decision: deterministic launch failures must REQUEUE, not RETRY ---

test("decideRetryAction: LAUNCH_ERROR + slot still SLOTS + breaker clear → REQUEUE (no blind retry)", () => {
  assert.strictEqual(
    decideRetryAction(
      { success: false, classification: "LAUNCH_ERROR" },
      { status: "SLOTS" },
      false
    ),
    "REQUEUE"
  );
});

test("decideRetryAction: TRANSIENT_ERROR + SLOTS → RETRY (existing retry coverage preserved)", () => {
  assert.strictEqual(
    decideRetryAction(
      { success: false, classification: "TRANSIENT_ERROR" },
      { status: "SLOTS" },
      false
    ),
    "RETRY"
  );
});

test("decideRetryAction: UNKNOWN + SLOTS → RETRY (existing retry coverage preserved)", () => {
  assert.strictEqual(
    decideRetryAction({ success: false, classification: "UNKNOWN" }, { status: "SLOTS" }, false),
    "RETRY"
  );
});

test("decideRetryAction: legacy caller without classification + SLOTS → RETRY (backward compatible)", () => {
  assert.strictEqual(
    decideRetryAction({ success: false }, { status: "SLOTS" }, false),
    "RETRY"
  );
});

test("decideRetryAction: success / tripped breaker / slot gone → REQUEUE (existing behavior preserved)", () => {
  assert.strictEqual(decideRetryAction({ success: true }, { status: "SLOTS" }, false), "REQUEUE");
  assert.strictEqual(
    decideRetryAction({ success: false, classification: "TRANSIENT_ERROR" }, { status: "SLOTS" }, true),
    "REQUEUE"
  );
  assert.strictEqual(
    decideRetryAction({ success: false, classification: "TRANSIENT_ERROR" }, { status: "NO_SLOTS" }, false),
    "REQUEUE"
  );
});

// --- End-to-end through executePlaywrightFallback: launch-time failure carries LAUNCH_ERROR ---

test("executePlaywrightFallback: missing browser binding surfaces LAUNCH_ERROR (not UNKNOWN)", async () => {
  const client: any = { category: "Bachelor", calendarId: 44281520 };
  const res = await executePlaywrightFallback(null, client);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.classification, "LAUNCH_ERROR");
  assert.ok(res.errorMessage && res.errorMessage.length > 0, "platform error must stay visible for the operator");
});
