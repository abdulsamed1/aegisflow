import test from "node:test";
import assert from "node:assert";
import { calculateBackoffMinutes, isCircuitBreakerTripped } from "../src/backoff";

test("Backoff Manager: Exponential backoff calculation", () => {
  assert.strictEqual(calculateBackoffMinutes(0), 0);
  assert.strictEqual(calculateBackoffMinutes(1), 2);
  assert.strictEqual(calculateBackoffMinutes(2), 4);
  assert.strictEqual(calculateBackoffMinutes(3), 8);
  assert.strictEqual(calculateBackoffMinutes(4), 16);
  assert.strictEqual(calculateBackoffMinutes(5), 32);
  assert.strictEqual(calculateBackoffMinutes(6), 60, "Must cap at 60 minutes");
  assert.strictEqual(calculateBackoffMinutes(10), 60, "Must cap at 60 minutes");
});

test("Backoff Manager: Circuit Breaker budget threshold", () => {
  assert.strictEqual(isCircuitBreakerTripped(500.0), false, "500s < 540s threshold");
  assert.strictEqual(isCircuitBreakerTripped(540.0), true, "540s reaches threshold");
  assert.strictEqual(isCircuitBreakerTripped(550.0), true, "550s exceeds threshold");
});
