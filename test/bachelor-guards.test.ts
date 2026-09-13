import test from "node:test";
import assert from "node:assert";
import { executePlaywrightFallback } from "../src/browser-fallback";
import {
  buildPreSerializedPayload,
  buildStep3DetailsPayload,
  executeDirectHttpBooking,
} from "../src/booking-http";
import { checkPreSubmitGate, CANONICAL_CALENDAR_ID } from "../src/pre-submit-gate";
import { SCHEDULER_PICK_QUERY } from "../src/scheduler";

// Bachelor/Master guard hardening (prod 2026-09-13 review): a Master/PhD-
// categorized client must never reach a LIVE booking action — browser launch,
// HTTP submission, or payload construction — not merely render the wrong
// dashboard label. Each test below pins one live action with a guard that a
// regression would have to remove to let the action through.

function baseClient(): any {
  return {
    id: "c_guard",
    firstName: "Guard",
    lastName: "Case",
    familyNameAtBirth: "Case",
    placeOfBirth: "Cairo",
    countryOfBirth: "Egypt",
    nationalityAtBirth: "Egyptian",
    street: "1 Test St",
    postalCode: "11511",
    city: "Cairo",
    passportIssueDate: "2020-01-01",
    passportIssuingCountry: "Egypt",
    gender: "Male",
    dob: "1998-01-01",
    nationality: "Egyptian",
    passportNumber: "A00000001",
    passportExpiry: "2030-01-01",
    email: "guard@example.com",
    phone: "+201000000000",
    category: "Bachelor",
    calendarId: CANONICAL_CALENDAR_ID,
  };
}

// Every non-Bachelor category value the system can ever observe: the D1 CHECK
// allows Master_PhD, and legacy/foreign rows may carry other spellings.
const NON_BACHELOR = ["Master_PhD", "Master", "PhD"];

for (const category of NON_BACHELOR) {
  test(`guard: ${category} client never triggers a browser launch`, async () => {
    let launcherCalls = 0;
    const res = await executePlaywrightFallback(
      {},
      { ...baseClient(), category } as any,
      {
        launcher: async () => {
          launcherCalls++;
          throw new Error("launcher must never be reached");
        },
      } as any
    );
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.classification, "VALIDATION_ERROR");
    assert.strictEqual(launcherCalls, 0, `${category} must not reach launchBrowser`);
  });

  test(`guard: ${category} client never reaches HTTP submission (even with a pre-serialized body)`, async () => {
    // preSerializedBody historically bypassed buildStep3DetailsPayload's guard
    // (executeDirectHttpBooking used it verbatim) — the live POST must stay
    // unreachable for non-Bachelor either way.
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      fetchCalls++;
      return new Response("<html>no ref</html>", { status: 200 });
    };
    try {
      await assert.rejects(
        executeDirectHttpBooking(
          { ...baseClient(), category, preSerializedBody: "Monday=x&Command=Next" } as any,
          "9/7/2026 12:00:00 AM"
        ),
        /Bachelor category and canonical calendar ID/
      );
      await assert.rejects(
        executeDirectHttpBooking({ ...baseClient(), category } as any, "9/7/2026 12:00:00 AM"),
        /Bachelor category and canonical calendar ID/
      );
      assert.strictEqual(fetchCalls, 0, `${category} must not reach the portal POST`);
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  test(`guard: ${category} client cannot build any booking payload`, () => {
    assert.throws(
      () => buildPreSerializedPayload({ ...baseClient(), category } as any, "9/7/2026 12:00:00 AM"),
      /Bachelor category and canonical calendar ID/
    );
    assert.throws(
      () => buildStep3DetailsPayload({ ...baseClient(), category } as any, "ABCDE"),
      /Bachelor category and canonical calendar ID/
    );
  });

  test(`guard: ${category} client fails the pre-submit gate`, () => {
    const gate = checkPreSubmitGate({ ...baseClient(), category } as any);
    assert.strictEqual(gate.ready, false);
    assert.ok(gate.blockers.some((b) => b.includes("Bachelor")), "gate must name the category blocker");
  });
}

test("guard: non-canonical calendarId never triggers a browser launch", async () => {
  let launcherCalls = 0;
  const res = await executePlaywrightFallback(
    {},
    { ...baseClient(), calendarId: 99999 } as any,
    {
      launcher: async () => {
        launcherCalls++;
        throw new Error("launcher must never be reached");
      },
    } as any
  );
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.classification, "VALIDATION_ERROR");
  assert.strictEqual(launcherCalls, 0, "wrong calendar must not reach launchBrowser");
});

test("guard: scheduler pick query admits only Bachelor + canonical calendar", () => {
  assert.ok(
    SCHEDULER_PICK_QUERY.includes("clients.category = 'Bachelor'"),
    "pick query must filter category"
  );
  assert.ok(
    SCHEDULER_PICK_QUERY.includes(`clients.calendar_id = ${CANONICAL_CALENDAR_ID}`),
    "pick query must filter calendar"
  );
});

test("guard: Bachelor control still passes every gate (no over-blocking)", async () => {
  assert.strictEqual(checkPreSubmitGate(baseClient()).ready, true);
  assert.doesNotThrow(() =>
    buildPreSerializedPayload(baseClient(), "9/7/2026 12:00:00 AM")
  );
  assert.doesNotThrow(() => buildStep3DetailsPayload(baseClient(), "ABCDE"));
  let fetchCalls = 0;
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    fetchCalls++;
    return new Response("<html>no ref</html>", { status: 200 });
  };
  try {
    const res = await executeDirectHttpBooking(baseClient(), "9/7/2026 12:00:00 AM");
    assert.strictEqual(fetchCalls, 1, "Bachelor must still reach the portal POST");
    assert.strictEqual(res.requiresPlaywrightFallback, true);
  } finally {
    (globalThis as any).fetch = origFetch;
  }
});
