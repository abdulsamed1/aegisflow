import test from "node:test";
import assert from "node:assert";
import { checkPreSubmitGate } from "../src/pre-submit-gate";
import { scanAvailability } from "../src/scanner";
import { buildStep3DetailsPayload, parseBookingConfirmationReference, formatDateForPortal } from "../src/booking-http";
import { isCircuitBreakerTripped, getBackoffUntilISO } from "../src/backoff";
import { decideReverifyAction, decideRetryAction } from "../src/booking-flow";

// --- 1. Pre-Submit Gate Failure Paths & Edge Cases ---

test("Edge Cases: Pre-Submit Gate rejects whitespace-only string fields", () => {
  const whitespaceClient: any = {
    id: "c1",
    firstName: "   ", // whitespace only
    lastName: "Hassan",
    familyNameAtBirth: "Hassan",
    placeOfBirth: "Cairo",
    countryOfBirth: "Egypt",
    nationalityAtBirth: "Egyptian",
    street: "15 Tahrir",
    postalCode: "11511",
    city: "Cairo",
    passportIssueDate: "2018-06-15",
    passportIssuingCountry: "Egypt",
    gender: "Male",
    dob: "1997-03-21",
    nationality: "Egyptian",
    passportNumber: "A12345678",
    passportExpiry: "2030-01-01",
    email: "ahmed@example.com",
    phone: "+201000000000",
    category: "Bachelor",
    calendarId: 44281520
  };

  const gate = checkPreSubmitGate(whitespaceClient);
  assert.strictEqual(gate.ready, false);
  assert.ok(gate.blockers.some(b => b.includes("firstName")), "Whitespace firstName must be caught as missing");
});

test("Edge Cases: Pre-Submit Gate enforces strict date format (YYYY-MM-DD)", () => {
  const badDateFormats = [
    "03-21-1997",
    "1997/03/21",
    "97-03-21",
    "2030-1-1",
    "2030-13-40",
    "invalid-date"
  ];

  for (const dateStr of badDateFormats) {
    const badClient: any = {
      id: "c1",
      firstName: "Ahmed",
      lastName: "Hassan",
      familyNameAtBirth: "Hassan",
      placeOfBirth: "Cairo",
      countryOfBirth: "Egypt",
      nationalityAtBirth: "Egyptian",
      street: "15 Tahrir",
      postalCode: "11511",
      city: "Cairo",
      passportIssueDate: "2018-06-15",
      passportIssuingCountry: "Egypt",
      gender: "Male",
      dob: dateStr, // Bad format
      nationality: "Egyptian",
      passportNumber: "A12345678",
      passportExpiry: "2030-01-01",
      email: "ahmed@example.com",
      phone: "+201000000000",
      category: "Bachelor",
      calendarId: 44281520
    };

    const gate = checkPreSubmitGate(badClient);
    assert.strictEqual(gate.ready, false, `Date format "${dateStr}" must be rejected by pre-submit gate`);
    assert.ok(gate.blockers.some(b => b.includes("dob")));
  }
});

test("Edge Cases: Pre-Submit Gate enforces case-sensitive Enum bounds", () => {
  const invalidEnums = [
    { gender: "male", category: "Bachelor" },      // lowercase gender
    { gender: "Male", category: "bachelor" },      // lowercase category
    { gender: "Other", category: "Bachelor" },     // non-supported gender
    { gender: "Male", category: "PhD" }            // non-supported category
  ];

  for (const { gender, category } of invalidEnums) {
    const badClient: any = {
      id: "c1",
      firstName: "Ahmed",
      lastName: "Hassan",
      familyNameAtBirth: "Hassan",
      placeOfBirth: "Cairo",
      countryOfBirth: "Egypt",
      nationalityAtBirth: "Egyptian",
      street: "15 Tahrir",
      postalCode: "11511",
      city: "Cairo",
      passportIssueDate: "2018-06-15",
      passportIssuingCountry: "Egypt",
      gender,
      dob: "1997-03-21",
      nationality: "Egyptian",
      passportNumber: "A12345678",
      passportExpiry: "2030-01-01",
      email: "ahmed@example.com",
      phone: "+201000000000",
      category,
      calendarId: 44281520
    };

    const gate = checkPreSubmitGate(badClient);
    assert.strictEqual(gate.ready, false, `Gender "${gender}" & Category "${category}" combination must be rejected`);
  }
});

// --- 2. Availability Scanner Edge & Failure Cases ---

test("Scanner Failures: Handles HTTP 403 / Cloudflare Block", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response("<html><head><title>Access Denied</title></head><body>Cloudflare Security Check</body></html>", {
        status: 403,
        statusText: "Forbidden"
      });
    }) as any;

    const res = await scanAvailability(44281520, "8/26/2026 12:00:00 AM", "test-cookie");
    assert.strictEqual(res.status, "UNKNOWN");
    assert.strictEqual(res.hasSlots, false);
    assert.ok(res.errorMessage?.includes("403"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Scanner Failures: Handles HTTP 503 Maintenance Page", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response("<html><body>Maintenance Mode</body></html>", { status: 503 });
    }) as any;

    const res = await scanAvailability(44281520, "8/26/2026 12:00:00 AM", "test-cookie");
    assert.strictEqual(res.status, "UNKNOWN");
    assert.strictEqual(res.hasSlots, false);
    assert.ok(res.errorMessage?.includes("503"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Scanner Failures: Handles Network Timeout / Exception", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error("Network connection reset by peer");
    }) as any;

    const res = await scanAvailability(44281520, "8/26/2026 12:00:00 AM", "test-cookie");
    assert.strictEqual(res.status, "UNKNOWN");
    assert.strictEqual(res.hasSlots, false);
    assert.strictEqual(res.errorMessage, "Network connection reset by peer");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Scanner Contract: Rejects HTML missing standard scheduler table as UNKNOWN", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response("<html><body>Welcome to BMEIA Portal</body></html>", { status: 200 });
    }) as any;

    const res = await scanAvailability(44281520, "8/26/2026 12:00:00 AM", "test-cookie");
    assert.strictEqual(res.status, "UNKNOWN");
    assert.strictEqual(res.hasSlots, false);
    assert.strictEqual(res.errorMessage, "Unexpected response structure");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// --- 3. Unicode, Encoding & Date Helper Edge Cases ---

test("Unicode Encoding: Handles Arabic & Hyphenated Special Characters in PII", () => {
  const clientWithArabic: any = {
    id: "c1",
    firstName: "محمد",
    lastName: "السيد",
    familyNameAtBirth: "السيد",
    placeOfBirth: "القاهرة",
    countryOfBirth: "Egypt",
    nationalityAtBirth: "Egyptian",
    street: "15 شارع التحرير",
    postalCode: "11511",
    city: "القاهرة",
    passportIssueDate: "2018-06-15",
    passportIssuingCountry: "Egypt",
    gender: "Male",
    dob: "1997-03-21",
    nationality: "Egyptian",
    passportNumber: "A12345678",
    passportExpiry: "2030-01-01",
    email: "mohamed@example.com",
    phone: "+201000000000",
    category: "Bachelor",
    calendarId: 44281520
  };

  const payload = buildStep3DetailsPayload(clientWithArabic, "C65P");
  const params = new URLSearchParams(payload);

  assert.strictEqual(params.get("Firstname"), "محمد");
  assert.strictEqual(params.get("Lastname"), "السيد");
  assert.strictEqual(params.get("Street"), "15 شارع التحرير");
  assert.strictEqual(params.get("City"), "القاهرة");
});

test("Date Formatter: Handles YYYY-MM-DD, YYYY/MM/DD and already formatted MM/DD/YYYY", () => {
  assert.strictEqual(formatDateForPortal("1997-03-21"), "03/21/1997");
  assert.strictEqual(formatDateForPortal("1997/03/21"), "03/21/1997");
  assert.strictEqual(formatDateForPortal("03/21/1997"), "03/21/1997");
  assert.strictEqual(formatDateForPortal("3/5/1997"), "3/5/1997");
  assert.strictEqual(formatDateForPortal("   2030-12-31  "), "12/31/2030");
  assert.strictEqual(formatDateForPortal(""), "");
});

// --- 4. Reference Parser Failure Paths & Arabic Support ---

test("Reference Parser: Parses Arabic prefixed booking confirmation text", () => {
  const htmlArabic = `
    <html>
      <body>
        <h2>تم الحجز بنجاح</h2>
        <p>رقم الحجز: GESX-KAIRO-887766</p>
      </body>
    </html>
  `;
  assert.strictEqual(parseBookingConfirmationReference(htmlArabic), "GESX-KAIRO-887766");
});

test("Reference Parser: Handles lowercase and alternative reference formats", () => {
  assert.strictEqual(parseBookingConfirmationReference("<div>Booking reference: gesx-vienna-9900</div>"), "GESX-VIENNA-9900");
  assert.strictEqual(parseBookingConfirmationReference("Reference ID: GESX-123456"), "GESX-123456");
  assert.strictEqual(parseBookingConfirmationReference("GESX-KAIRO"), "GESX-KAIRO");
});

test("Reference Parser: Returns null on failed/incomplete confirmation pages", () => {
  assert.strictEqual(parseBookingConfirmationReference("<html><body>An error occurred during processing</body></html>"), null);
  assert.strictEqual(parseBookingConfirmationReference("GESX"), null);
  assert.strictEqual(parseBookingConfirmationReference(""), null);
  assert.strictEqual(parseBookingConfirmationReference(null as any), null);
});

// --- 5. Circuit Breaker Boundary & Backoff Calculations ---

test("Circuit Breaker: Boundary check exactly at 540.0s threshold", () => {
  assert.strictEqual(isCircuitBreakerTripped(539.99), false);
  assert.strictEqual(isCircuitBreakerTripped(540.0), true);
  assert.strictEqual(isCircuitBreakerTripped(540.01), true);
});

test("Backoff Manager: Computes future exponential ISO timestamp", () => {
  const now = new Date();
  const backoffISO = getBackoffUntilISO(2); // checkCount = 2 -> 2^2 * 60s = 240s
  const backoffDate = new Date(backoffISO);

  const diffSec = (backoffDate.getTime() - now.getTime()) / 1000;
  assert.ok(diffSec >= 235 && diffSec <= 245, `Backoff duration should be ~240s, got ${diffSec}s`);
});
