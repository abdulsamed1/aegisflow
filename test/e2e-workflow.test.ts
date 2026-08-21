import test from "node:test";
import assert from "node:assert";
import worker from "../src/index";
import { executeDirectHttpBooking, DecryptedClientData } from "../src/booking-http";

test("E2E Workflow: Complete Lifecycle Onboarding to Dry-Run Execution", async () => {
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response("<html>no ref</html>", { status: 200 });
  try {
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
    const bookingResult = await executeDirectHttpBooking(clientObj, "10/5/2026");
    assert.strictEqual(bookingResult.success, false, "Live booking executes via HTTP");
    assert.strictEqual(bookingResult.requiresPlaywrightFallback, true);
  } finally { (globalThis as any).fetch = origFetch; }
});

test("E2E Workflow: Dashboard HTML serves without fast-path latency hype", async () => {
  const env = {
    DB: {} as any,
    JOB_LOCK: {} as any,
    SESSION_KV: {} as any,
    MYBROWSER: {} as any,
  };
  const req = new Request("https://opran-booking.local/");
  const res = await worker.fetch(req, env, {} as any);
  const html = await res.text();
  assert.ok(html.includes("أوبيران لأتمتة الحجوزات"));
  assert.ok(!html.includes("DRY-RUN"), "DRY-RUN badge must be removed from dashboard");
  assert.ok(!html.includes("val-cairo"), "Cairo time card must be removed from dashboard");
  assert.ok(!html.includes("<10ms"), "Dashboard must not advertise unverified latency claims");
});

test("E2E Workflow: Complete Candidate Portal Pipeline & Step 3 Payload Generation", async () => {
  const clientObj: DecryptedClientData = {
    id: "client_e2e_full",
    firstName: "Ahmed",
    lastName: "Hassan",
    gender: "Male",
    dob: "1998-05-15",
    nationality: "Egyptian",
    passportNumber: "A99887766",
    passportExpiry: "2030-05-15",
    email: "ahmed.hassan@example.com",
    phone: "+201000000000",
    category: "Bachelor",
    calendarId: 44281520,
    street: "123 Nile Street",
    postalCode: "11511",
    city: "Cairo",
    placeOfBirth: "Cairo",
    passportIssueDate: "2020-05-15",
    passportIssuer: "Egyptian Passport Authority"
  };

  // 1. Test Date Formatting for BMEIA Portal (MM/DD/YYYY)
  const { formatDateForPortal, buildStep3DetailsPayload, parseBookingConfirmationReference } = await import("../src/booking-http");
  assert.strictEqual(formatDateForPortal("1998-05-15"), "05/15/1998");
  assert.strictEqual(formatDateForPortal("2030-05-15"), "05/15/2030");

  // 2. Build Full 18-Field Step 3 Payload (real portal names per London evidence, C65P is the ground-truth sample)
  const step3PayloadString = buildStep3DetailsPayload(clientObj, "C65P");
  const step3Payload = Object.fromEntries(new URLSearchParams(step3PayloadString));
  assert.strictEqual(step3Payload.Lastname, "Hassan");
  assert.strictEqual(step3Payload.Firstname, "Ahmed");
  assert.strictEqual(step3Payload.DateOfBirth, "05/15/1998");
  assert.strictEqual(step3Payload.TraveldocumentNumber, "A99887766");
  assert.strictEqual(step3Payload.Postcode, "11511");
  assert.strictEqual(step3Payload.City, "Cairo");
  assert.strictEqual(step3Payload.CaptchaText, "C65P");
  assert.strictEqual(step3Payload.DSGVOAccepted, "true");
  assert.ok(!("LastName" in step3Payload), "fabricated name must not be present");
  assert.ok(!("DOB" in step3Payload));


  // 3. Test Booking Reference Extraction from Confirmation Page HTML
  const mockConfirmationHTML = `
    <html>
      <body>
        <div class="confirmation-box">
          <h2>Terminreservierung - Booking Confirmed</h2>
          <p>Ihre Reservierungsnummer: <strong>GESX-KAIRO-20260821-998877</strong></p>
          <p>Name: Ahmed Hassan</p>
          <p>Date: 10/05/2026 10:00 AM</p>
        </div>
      </body>
    </html>
  `;
  const refId = parseBookingConfirmationReference(mockConfirmationHTML);
  assert.strictEqual(refId, "GESX-KAIRO-20260821-998877");
});

