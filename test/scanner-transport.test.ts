import test from "node:test";
import assert from "node:assert";
import { scanAvailability, isTransportOutage } from "../src/scanner";

// Regression (prod 2026-09-01→11): ~5.8k UNKNOWN_RESPONSE rows in 14 days,
// sampled 2026-09-11 — ALL are `{"responseLength":0,"error":"HTTP 520"}`.
// The portal's edge is unreachable, yet every one of those is indistinguishable
// from a parse-level anomaly: ScanResult has no transport-vs-parse distinction,
// and scheduled() re-fires all remaining bursts (2×8 fetches + 30s sleep +
// up to 16 rows/job/tick) against a dead portal. These tests lock in:
// (1) UNKNOWN results carry errorKind TRANSPORT vs PARSE, and
// (2) an all-transport-failed burst is detectable so the caller can back off.

test("scanner: HTTP 520 classifies UNKNOWN with errorKind TRANSPORT (prod 520-storm shape)", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("", { status: 520 })) as any;
    const res = await scanAvailability(44281520, "10/26/2026 12:00:00 AM", "test-cookie");
    assert.strictEqual(res.status, "UNKNOWN");
    assert.strictEqual(res.errorMessage, "HTTP 520");
    assert.strictEqual(res.errorKind, "TRANSPORT");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("scanner: fetch exception classifies UNKNOWN with errorKind TRANSPORT", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error("Network connection reset by peer");
    }) as any;
    const res = await scanAvailability(44281520, "8/26/2026 12:00:00 AM", "test-cookie");
    assert.strictEqual(res.status, "UNKNOWN");
    assert.strictEqual(res.errorKind, "TRANSPORT");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("scanner: HTTP 200 with unexpected structure classifies UNKNOWN with errorKind PARSE", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("<html><body>Welcome to BMEIA Portal</body></html>", { status: 200 })) as any;
    const res = await scanAvailability(44281520, "8/26/2026 12:00:00 AM", "test-cookie");
    assert.strictEqual(res.status, "UNKNOWN");
    assert.strictEqual(res.errorKind, "PARSE");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// --- Burst-backoff predicate: only a TOTAL transport blackout backs off ---

function transportUnknown(): any {
  return { status: "UNKNOWN", hasSlots: false, rawResponseLength: 0, durationMs: 1, errorKind: "TRANSPORT", matchedMonday: "x" };
}

test("isTransportOutage: all-UNKNOWN+TRANSPORT burst → true (back off remaining bursts)", () => {
  assert.strictEqual(isTransportOutage([transportUnknown(), transportUnknown()]), true);
});

test("isTransportOutage: any NO_SLOTS (portal answered) → false (keep scanning)", () => {
  assert.strictEqual(
    isTransportOutage([transportUnknown(), { status: "NO_SLOTS", hasSlots: false, rawResponseLength: 10, durationMs: 1, matchedMonday: "x" }]),
    false
  );
});

test("isTransportOutage: any PARSE unknown (portal answered, markup odd) → false (keep scanning)", () => {
  assert.strictEqual(
    isTransportOutage([transportUnknown(), { ...transportUnknown(), errorKind: "PARSE" }]),
    false
  );
});

test("isTransportOutage: SLOTS present or empty burst → false", () => {
  assert.strictEqual(
    isTransportOutage([transportUnknown(), { status: "SLOTS", hasSlots: true, rawResponseLength: 10, durationMs: 1, matchedMonday: "x" }]),
    false
  );
  assert.strictEqual(isTransportOutage([]), false);
});
