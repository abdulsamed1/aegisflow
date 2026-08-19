import test from "node:test";
import assert from "node:assert";
import { buildPreSerializedPayload, executeBatchFastPathBookings, executeDirectHttpBooking, DecryptedClientData } from "../src/booking-http";

test("Booking Engine: Payload contains only G0-verified discovery fields", () => {
  const client: DecryptedClientData = {
    id: "client_101",
    firstName: "Ahmed",
    lastName: "Hassan",
    gender: "Male",
    dob: "1995-05-15",
    nationality: "Egyptian",
    passportNumber: "A12345678",
    passportExpiry: "2030-05-15",
    email: "ahmed@example.com",
    phone: "+201000000000",
    category: "Bachelor",
    calendarId: 44281520
  };

  const mondayStr = "10/5/2026";
  const payload = buildPreSerializedPayload(client, mondayStr);

  assert.ok(payload.includes("CalendarId=44281520"));
  assert.ok(payload.includes("Monday=10%2F5%2F2026"));
  assert.ok(payload.includes("Command=Next"), "Discovery uses Command=Next (verified G0 contract)");
  assert.ok(payload.includes("Office=KAIRO"));
  assert.ok(!payload.includes("Command=Book"), "Unverified booking command must not be fabricated");
  assert.ok(!payload.includes("FirstName="), "Unverified booking fields must not be fabricated");
});

test("Booking Engine: Batch parallel dispatch stays Dry-Run only", async () => {
  const clients: DecryptedClientData[] = Array.from({ length: 10 }, (_, i) => ({
    id: `client_${i + 1}`,
    firstName: `Candidate${i + 1}`,
    lastName: "Test",
    gender: "Male",
    dob: "1998-01-01",
    nationality: "Egyptian",
    passportNumber: `A0000000${i}`,
    passportExpiry: "2030-01-01",
    email: `candidate${i + 1}@example.com`,
    phone: "+201000000000",
    category: "Bachelor",
    calendarId: 44281520
  }));

  const results = await executeBatchFastPathBookings(clients, "10/5/2026", true);

  assert.strictEqual(results.length, 10, "Must return results for all 10 candidates");
  assert.ok(results.every((r) => r.isDryRun === true), "All results must be in Dry-Run mode");
  assert.ok(results.every((r) => r.success === true), "All Dry-Run executions must succeed");
});

test("Booking Engine: Live booking is disabled until G0 closes (no fabricated success)", async () => {
  const client: DecryptedClientData = {
    id: "client_live_1",
    firstName: "Test",
    lastName: "User",
    gender: "Male",
    dob: "1998-01-01",
    nationality: "Egyptian",
    passportNumber: "A11111111",
    passportExpiry: "2030-01-01",
    email: "test@example.com",
    phone: "+201000000000",
    category: "Bachelor",
    calendarId: 44281520
  };

  const result = await executeDirectHttpBooking(client, "10/5/2026", false);

  assert.strictEqual(result.isDryRun, false);
  assert.strictEqual(result.success, false, "Live booking must fail closed while path is UNVERIFIED");
  assert.strictEqual(result.requiresPlaywrightFallback, true);
  assert.ok(result.errorMessage?.includes("UNVERIFIED"), "Error must state the G0 verification gap");
});
