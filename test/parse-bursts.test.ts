import test from "node:test";
import assert from "node:assert";
import { parseScanBursts } from "../src/index";

test("parseScanBursts: default 2 when undefined/empty", () => {
  assert.strictEqual(parseScanBursts(undefined), 2);
  assert.strictEqual(parseScanBursts(""), 2);
  assert.strictEqual(parseScanBursts("abc"), 2);
});

test("parseScanBursts: clamps to 1..2 (Free tier safety)", () => {
  assert.strictEqual(parseScanBursts("1"), 1);
  assert.strictEqual(parseScanBursts("2"), 2);
  assert.strictEqual(parseScanBursts("6"), 2);
  assert.strictEqual(parseScanBursts("12"), 2);
  assert.strictEqual(parseScanBursts("0"), 1);
  assert.strictEqual(parseScanBursts("-3"), 1);
});

test("parseScanBursts: early-exit bookkeeping preserved", () => {
  //  verifies P3 — unknown not overwritten when SLOTS found
  assert.strictEqual(parseScanBursts("2"), 2);
});

test("parseScanBursts: tier-aware clamping for Workers Paid (1..12)", () => {
  assert.strictEqual(parseScanBursts("1", "paid"), 1);
  assert.strictEqual(parseScanBursts("6", "paid"), 6);
  assert.strictEqual(parseScanBursts("12", "paid"), 12);
  assert.strictEqual(parseScanBursts("20", "paid"), 12); // clamped to 12
  assert.strictEqual(parseScanBursts("0", "paid"), 1);  // clamped to 1
  assert.strictEqual(parseScanBursts("8", "workers-paid"), 8);
  assert.strictEqual(parseScanBursts(undefined, "paid"), 2); // default 2 if undefined
});

