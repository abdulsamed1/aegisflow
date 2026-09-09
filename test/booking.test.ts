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

test("Booking Engine: Batch parallel dispatch live", async () => {
  const origFetch = globalThis.fetch;
  //  mock BMEIA portal to avoid real network in unit test
  (globalThis as any).fetch = async () => new Response("<html>no reference</html>", { status: 200 });
  try {
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
    const results = await executeBatchFastPathBookings(clients, "10/5/2026");
    assert.strictEqual(results.length, 10, "Must return results for all 10 candidates");
    assert.ok(results.every((r) => r.success === false), "Live executions fallback when no ref");
  } finally { (globalThis as any).fetch = origFetch; }
});

test("Booking Engine: Live booking attempts HTTP POST and requests browser fallback on missing ref", async () => {
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response("<html>no reference</html>", { status: 200 });
  try {
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
    const result = await executeDirectHttpBooking(client, "10/5/2026");
    assert.strictEqual(result.requiresPlaywrightFallback, true);
    assert.ok(result.errorMessage?.includes("falling back") || result.errorMessage?.includes("fetch"), "Error must indicate fallback path");
  } finally { (globalThis as any).fetch = origFetch; }
});
