import test from "node:test";
import assert from "node:assert";
import worker from "../src/index";
import { executeDirectHttpBooking, DecryptedClientData } from "../src/booking-http";

test("E2E Workflow: Complete Lifecycle Onboarding to Dry-Run Execution", async () => {
  const clientObj: DecryptedClientData = {
    id: "client_e2e_101",
    firstName: "Youssef",
    lastName: "Ibrahim",
    gender: "Male",
    dob: "2000-08-10",
    nationality: "Egyptian",
    passportNumber: "B12345678",
    passportExpiry: "2032-01-01",
    email: "youssef@example.com",
    phone: "+201200000000",
    category: "Bachelor",
    calendarId: 44281520
  };

  // Dry-Run execution prepares the verified payload and halts before any submission
  const bookingResult = await executeDirectHttpBooking(clientObj, "10/5/2026", true);

  assert.strictEqual(bookingResult.success, true, "Dry-Run execution must succeed");
  assert.strictEqual(bookingResult.isDryRun, true, "Must halt in Dry-Run mode");

  // Live execution must fail closed (booking path UNVERIFIED) with no network call to the portal
  const liveResult = await executeDirectHttpBooking(clientObj, "10/5/2026", false);
  assert.strictEqual(liveResult.isDryRun, false);
  assert.strictEqual(liveResult.success, false, "Live booking must be disabled until G0 closes");
  assert.strictEqual(liveResult.requiresPlaywrightFallback, true);
});

test("E2E Workflow: Dashboard HTML serves without fast-path latency hype", async () => {
  const env = {
    DB: {} as any,
    JOB_LOCK: {} as any,
    SESSION_KV: {} as any,
    MYBROWSER: {} as any,
    DRY_RUN: "true"
  };
  const req = new Request("https://opran-booking.local/");
  const res = await worker.fetch(req, env, {} as any);
  const html = await res.text();
  assert.ok(html.includes("أوبيران لأتمتة الحجوزات"));
  assert.ok(html.includes("DRY-RUN"));
  assert.ok(!html.includes("<10ms"), "Dashboard must not advertise unverified latency claims");
});
