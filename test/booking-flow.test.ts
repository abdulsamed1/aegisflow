import test from "node:test";
import assert from "node:assert";
import { decideReverifyAction, decideRetryAction } from "../src/booking-flow";

test("reverify: SLOTS proceeds, NO_SLOTS aborts slot gone, UNKNOWN aborts unknown", () => {
  assert.strictEqual(decideReverifyAction({ status: "SLOTS" }), "PROCEED");
  assert.strictEqual(decideReverifyAction({ status: "NO_SLOTS" }), "ABORT_SLOT_GONE");
  assert.strictEqual(decideReverifyAction({ status: "UNKNOWN" }), "ABORT_UNKNOWN");
});

test("retry: only retry when first failed, rescan still SLOTS, breaker not tripped", () => {
  assert.strictEqual(decideRetryAction({ success: false }, { status: "SLOTS" }, false), "RETRY");
  assert.strictEqual(decideRetryAction({ success: false }, { status: "NO_SLOTS" }, false), "REQUEUE");
  assert.strictEqual(decideRetryAction({ success: false }, { status: "UNKNOWN" }, false), "REQUEUE");
  assert.strictEqual(decideRetryAction({ success: true }, { status: "SLOTS" }, false), "REQUEUE");
  assert.strictEqual(decideRetryAction({ success: false }, { status: "SLOTS" }, true), "REQUEUE");
});

test("retry: breaker tripped prevents retry even when slot still there", () => {
  assert.strictEqual(decideRetryAction({ success: false }, { status: "SLOTS" }, true), "REQUEUE");
});
