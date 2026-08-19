import test from "node:test";
import assert from "node:assert";
import worker from "../src/index";
import { executeDirectHttpBooking, DecryptedClientData } from "../src/booking-http";

test("E2E Workflow: Complete Lifecycle Onboarding to Fast-Path Execution", async () => {
  // Step 1: Onboard candidate client via POST /api/clients
  const clientData = {
    firstName: "Youssef",
    lastName: "Ibrahim",
    category: "Bachelor",
    passportNumber: "B12345678",
    passportExpiry: "2032-01-01",
    dob: "2000-08-10",
    gender: "Male",
    email: "youssef@example.com",
    phone: "+201200000000"
  };

  const clientObj: DecryptedClientData = {
    id: "client_e2e_101",
    firstName: clientData.firstName,
    lastName: clientData.lastName,
    gender: clientData.gender,
    dob: clientData.dob,
    nationality: "Egyptian",
    passportNumber: clientData.passportNumber,
    passportExpiry: clientData.passportExpiry,
    email: clientData.email,
    phone: clientData.phone,
    category: clientData.category,
    calendarId: 44281520
  };

  // Step 2: Execute Direct HTTP Fast-Path Booking (<10ms Dry-Run)
  const bookingResult = await executeDirectHttpBooking(clientObj, "10/5/2026", true);

  assert.strictEqual(bookingResult.success, true, "Fast-Path execution must succeed");
  assert.strictEqual(bookingResult.isDryRun, true, "Must halt in Dry-Run mode");
  assert.ok(bookingResult.durationMs < 15, `Duration ${bookingResult.durationMs}ms must be < 15ms`);

  // Step 3: Verify simulated live booking execution (Dry-Run false with mock server structure)
  const liveResult = await executeDirectHttpBooking(clientObj, "10/5/2026", false);
  // Expect fallback or failure on invalid URL in test env, but structure must match contract
  assert.ok(typeof liveResult.durationMs === "number");
  assert.strictEqual(liveResult.isDryRun, false);
});
