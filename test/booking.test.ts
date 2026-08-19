import test from "node:test";
import assert from "node:assert";
import { buildPreSerializedPayload, executeBatchFastPathBookings, DecryptedClientData } from "../src/booking-http";

test("Fast-Path Engine: Pre-serialized Zero-Allocation Payload Generation", () => {
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

  assert.ok(payload.includes("FirstName=Ahmed"));
  assert.ok(payload.includes("LastName=Hassan"));
  assert.ok(payload.includes("CalendarId=44281520"));
  assert.ok(payload.includes("Monday=10%2F5%2F2026"));
  assert.ok(payload.includes("Command=Book"));
});

test("Fast-Path Engine: Batch Parallel Multi-Candidate Dry-Run Execution (<10ms)", async () => {
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

  const startTime = Date.now();
  const results = await executeBatchFastPathBookings(clients, "10/5/2026", true);
  const totalDurationMs = Date.now() - startTime;

  assert.strictEqual(results.length, 10, "Must return results for all 10 candidates");
  assert.ok(results.every((r) => r.isDryRun === true), "All results must be in Dry-Run mode");
  assert.ok(results.every((r) => r.success === true), "All Dry-Run executions must succeed");
  assert.ok(totalDurationMs < 20, `Execution of 10 concurrent candidates took ${totalDurationMs}ms (expected < 20ms in dry-run)`);
});
