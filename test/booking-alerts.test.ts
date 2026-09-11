import test from "node:test";
import assert from "node:assert";
import {
  buildSlotAlarmMessage,
  buildBookingStepMessage,
  getBookingFailureBackoffUntil,
} from "../src/booking-flow";

// Operator-parallel flow (2026-09-11): the moment the scanner sees SLOTS the
// operator gets a Telegram alarm and applies manually on the portal IN PARALLEL
// while the bot runs the wizard. Every booking step then reports its outcome,
// and a failed booking NEVER parks the job (no backoff) — it retries next tick
// while slots verify. Safety valves stay: single same-tick retry, 20s launch
// throttle, DO lock, reverify gate, 540s circuit breaker.

test("slot alarm: actionable in seconds — week, job, client, portal URL, parallel hint", () => {
  const msg = buildSlotAlarmMessage({ jobId: "job_1", clientName: "Ahmed", week: "9/21/2026 12:00:00 AM" });
  assert.ok(msg.includes("9/21/2026"), "must carry the slot week");
  assert.ok(msg.includes("job_1"), "must carry the job id");
  assert.ok(msg.includes("Ahmed"), "must carry who the slot is for");
  assert.ok(msg.includes("https://appointment.bmeia.gv.at"), "must carry the portal URL to open now");
  assert.ok(/parallel/i.test(msg), "must tell the operator the bot is launching too");
});

test("slot alarm: carries no passport/secrets (alarm speed needs no PII)", () => {
  const msg = buildSlotAlarmMessage({ jobId: "job_1", clientName: "Ahmed", week: "9/21/2026 12:00:00 AM" });
  assert.ok(!msg.includes("A12345678"), "passport numbers must never ride the alarm path");
});

test("step STARTED: attempt number and week", () => {
  const msg = buildBookingStepMessage("STARTED", { jobId: "job_1", week: "9/21/2026 12:00:00 AM", attempt: 1 });
  assert.ok(msg.includes("attempt 1"), `got: ${msg}`);
  assert.ok(msg.includes("9/21/2026"));
});

test("step SUBMITTED: stage and selected slot", () => {
  const msg = buildBookingStepMessage("SUBMITTED", {
    jobId: "job_1", week: "9/21/2026 12:00:00 AM", attempt: 1,
    stage: "SUBMITTED", slot: "9/24/2026 10:00:00 AM",
  });
  assert.ok(msg.includes("9/24/2026 10:00:00 AM"), `slot must be visible, got: ${msg}`);
});

test("step RETRY: classification and error stay visible", () => {
  const msg = buildBookingStepMessage("RETRY", {
    jobId: "job_1", week: "9/21/2026 12:00:00 AM", attempt: 1,
    classification: "TRANSIENT_ERROR", error: "Navigation timeout of 30000 ms exceeded",
  });
  assert.ok(msg.includes("TRANSIENT_ERROR"));
  assert.ok(msg.includes("Navigation timeout"));
});

test("step FAILED: classification, error, and explicit never-parked notice", () => {
  const msg = buildBookingStepMessage("FAILED", {
    jobId: "job_1", week: "9/21/2026 12:00:00 AM", attempt: 2,
    classification: "SLOT_GONE", error: "No slots available after submission (slot gone)", stage: "SLOT_SELECTION",
  });
  assert.ok(msg.includes("SLOT_GONE"));
  assert.ok(/ACTIVE|next tick|retry/i.test(msg), `operator must know the job keeps going, got: ${msg}`);
});

test("step SLOT_GONE: tells the operator to stand down manual effort", () => {
  const msg = buildBookingStepMessage("SLOT_GONE", { jobId: "job_1", week: "9/21/2026 12:00:00 AM", attempt: 1 });
  assert.ok(/gone|no longer|stop/i.test(msg), `got: ${msg}`);
});

test("never-stop policy: booking failure requeues with NO backoff (null), never the 60-min cap", () => {
  // check_count grows ~16-48 per scan tick, so the old getBackoffUntilISO(checkCount)
  // parked every failed job a full hour. Failure must keep the job tick-eligible.
  assert.strictEqual(getBookingFailureBackoffUntil(), null);
});
