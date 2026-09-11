import test from "node:test";
import assert from "node:assert";
import {
  aggregateDailyReport,
  filterRowsByCairoDay,
  formatCairoTimestamp,
  summarizePriorCairoDays,
  ReportRow
} from "../src/daily-report";
import { CANONICAL_CALENDAR_ID } from "../src/pre-submit-gate";
import { SCHEDULER_PICK_QUERY, getCairoDateString, calculateMondayString } from "../src/scheduler";
import { buildPreSerializedPayload, buildStep3DetailsPayload, DecryptedClientData } from "../src/booking-http";
import { executePlaywrightFallback } from "../src/browser-fallback";

const validBachelorClient: DecryptedClientData = {
  id: "client_audit_1",
  firstName: "Mohamed",
  lastName: "Ali",
  familyNameAtBirth: "Ali",
  placeOfBirth: "Cairo",
  countryOfBirth: "Egypt",
  nationalityAtBirth: "Egypt",
  street: "15 Kasr El Nil",
  postalCode: "11511",
  city: "Cairo",
  passportIssueDate: "2021-06-01",
  passportIssuingCountry: "Egypt",
  gender: "Male",
  dob: "1998-03-20",
  nationality: "Egypt",
  passportNumber: "A98765432",
  passportExpiry: "2031-06-01",
  email: "mohamed.ali@example.com",
  phone: "+201234567890",
  category: "Bachelor",
  calendarId: CANONICAL_CALENDAR_ID
};

test("Bachelor-only lock: SCHEDULER_PICK_QUERY explicitly enforces Bachelor category and canonical calendar ID", () => {
  assert.ok(
    SCHEDULER_PICK_QUERY.includes("clients.category = 'Bachelor'"),
    "Query must filter by clients.category = 'Bachelor'"
  );
  assert.ok(
    SCHEDULER_PICK_QUERY.includes(`clients.calendar_id = ${CANONICAL_CALENDAR_ID}`),
    `Query must filter by clients.calendar_id = ${CANONICAL_CALENDAR_ID}`
  );
});

test("Bachelor-only lock: HTTP payload builders reject non-Bachelor or non-canonical calendar IDs", () => {
  assert.throws(
    () => buildPreSerializedPayload({ ...validBachelorClient, category: "Master" as any }),
    /Bachelor category and canonical calendar ID/
  );
  assert.throws(
    () => buildPreSerializedPayload({ ...validBachelorClient, calendarId: 112233 as any }),
    /Bachelor category and canonical calendar ID/
  );
  assert.throws(
    () => buildStep3DetailsPayload({ ...validBachelorClient, category: "PhD" as any }),
    /Bachelor category and canonical calendar ID/
  );
  assert.throws(
    () => buildStep3DetailsPayload({ ...validBachelorClient, calendarId: 99999 as any }),
    /Bachelor category and canonical calendar ID/
  );
});

test("Bachelor-only lock: Playwright wizard pre-flight rejects non-Bachelor or non-canonical calendar IDs", async () => {
  const resCat = await executePlaywrightFallback({}, { ...validBachelorClient, category: "Tourist" as any });
  assert.strictEqual(resCat.success, false);
  assert.ok(resCat.errorMessage?.includes("Only 'Bachelor' category"));

  const resCal = await executePlaywrightFallback({}, { ...validBachelorClient, calendarId: 55555 as any });
  assert.strictEqual(resCal.success, false);
  assert.ok(resCal.errorMessage?.includes("canonical calendar ID"));
});

test("Audit Timeline: Full lifecycle correlation from detection to terminal booking", () => {
  const cairoDay = "2026-09-08";
  const correlationId = "job_1-week_20260920-xyz123";
  const rows: ReportRow[] = [
    {
      job_id: "job_1",
      client_id: "client_1",
      event_type: "APPOINTMENT_FOUND",
      details: JSON.stringify({ week: "9/20/2026", burst: 0 }),
      created_at: "2026-09-08 09:00:00"
    },
    {
      job_id: "job_1",
      client_id: "client_1",
      event_type: "BOOKING_STARTED",
      details: JSON.stringify({ week: "9/20/2026", correlationId, attempt: 1 }),
      created_at: "2026-09-08 09:00:02"
    },
    {
      job_id: "job_1",
      client_id: "client_1",
      event_type: "SUBMITTED",
      details: JSON.stringify({ week: "9/20/2026", correlationId, attempt: 1 }),
      created_at: "2026-09-08 09:00:25"
    },
    {
      job_id: "job_1",
      client_id: "client_1",
      event_type: "BOOKED",
      details: JSON.stringify({ referenceId: "GESX-CAI-2026-9999", week: "9/20/2026", correlationId, attempt: 1 }),
      created_at: "2026-09-08 09:00:28"
    }
  ];

  const report = aggregateDailyReport(rows, cairoDay);
  assert.strictEqual(report.was_open, true);
  assert.strictEqual(report.opportunities_found, 1);
  assert.strictEqual(report.opportunities_booked, 1);
  assert.strictEqual(report.opportunities_missed, 0);
  assert.strictEqual(report.technical_failures, 0);

  // Timeline entries verification
  assert.strictEqual(report.timeline.length, 4);
  assert.strictEqual(report.timeline[0].event_type, "APPOINTMENT_FOUND");
  assert.strictEqual(report.timeline[1].event_type, "BOOKING_STARTED");
  assert.strictEqual(report.timeline[1].attempt, 1);
  assert.strictEqual(report.timeline[1].correlation_id, correlationId);
  assert.strictEqual(report.timeline[2].event_type, "SUBMITTED");
  assert.strictEqual(report.timeline[3].event_type, "BOOKED");
  assert.strictEqual(report.timeline[3].status_badge, "تم الحجز بنجاح ✓");
  assert.ok(report.timeline[3].message.includes("GESX-CAI-2026-9999"));
});

test("Attribution & Single Source of Truth: Distinguish slot-gone vs transient technical failure", () => {
  const cairoDay = "2026-09-08";

  // Case A: Confirmed lost slot (SLOT_GONE)
  const rowsLost: ReportRow[] = [
    {
      job_id: "job_lost",
      client_id: "c_lost",
      event_type: "APPOINTMENT_FOUND",
      details: JSON.stringify({ week: "9/20/2026" }),
      created_at: "2026-09-08 10:00:00"
    },
    {
      job_id: "job_lost",
      client_id: "c_lost",
      event_type: "BOOKING_FAILED",
      details: JSON.stringify({
        week: "9/20/2026",
        error: "No slots available after submission (slot gone)",
        classification: "SLOT_GONE",
        attempt: 1
      }),
      created_at: "2026-09-08 10:00:30"
    }
  ];
  const reportLost = aggregateDailyReport(rowsLost, cairoDay);
  assert.strictEqual(reportLost.opportunities_missed, 1, "SLOT_GONE must increment opportunities_missed");
  assert.strictEqual(reportLost.technical_failures, 0, "SLOT_GONE must not count as technical failure");

  // Case B: Transient technical failure (browser crash / network timeout) — capacity NOT lost
  const rowsTransient: ReportRow[] = [
    {
      job_id: "job_transient",
      client_id: "c_transient",
      event_type: "APPOINTMENT_FOUND",
      details: JSON.stringify({ week: "9/27/2026" }),
      created_at: "2026-09-08 11:00:00"
    },
    {
      job_id: "job_transient",
      client_id: "c_transient",
      event_type: "BOOKING_FAILED",
      details: JSON.stringify({
        week: "9/27/2026",
        error: "Navigation timeout 30000ms exceeded",
        classification: "TRANSIENT_ERROR",
        attempt: 1
      }),
      created_at: "2026-09-08 11:00:35"
    }
  ];
  const reportTransient = aggregateDailyReport(rowsTransient, cairoDay);
  assert.strictEqual(reportTransient.opportunities_missed, 0, "TRANSIENT_ERROR must not increment opportunities_missed");
  assert.strictEqual(reportTransient.technical_failures, 1, "TRANSIENT_ERROR must increment technical_failures");
});

test("Retry Behavior: Attempt 1 failure then attempt 2 BOOKED resolves opportunity as booked, not missed", () => {
  const cairoDay = "2026-09-08";
  const corrId = "job_retry_1-corr";
  const rows: ReportRow[] = [
    {
      job_id: "job_retry_1",
      client_id: "c_retry",
      event_type: "APPOINTMENT_FOUND",
      details: JSON.stringify({ week: "9/20/2026" }),
      created_at: "2026-09-08 12:00:00"
    },
    {
      job_id: "job_retry_1",
      client_id: "c_retry",
      event_type: "BOOKING_STARTED",
      details: JSON.stringify({ week: "9/20/2026", correlationId: corrId, attempt: 1 }),
      created_at: "2026-09-08 12:00:02"
    },
    {
      job_id: "job_retry_1",
      client_id: "c_retry",
      event_type: "BOOKING_RETRY",
      details: JSON.stringify({ error: "Captcha timeout", classification: "TRANSIENT_ERROR", week: "9/20/2026", correlationId: corrId, attempt: 1 }),
      created_at: "2026-09-08 12:00:20"
    },
    {
      job_id: "job_retry_1",
      client_id: "c_retry",
      event_type: "BOOKING_STARTED",
      details: JSON.stringify({ week: "9/20/2026", correlationId: corrId, attempt: 2 }),
      created_at: "2026-09-08 12:00:21"
    },
    {
      job_id: "job_retry_1",
      client_id: "c_retry",
      event_type: "SUBMITTED",
      details: JSON.stringify({ week: "9/20/2026", correlationId: corrId, attempt: 2 }),
      created_at: "2026-09-08 12:00:45"
    },
    {
      job_id: "job_retry_1",
      client_id: "c_retry",
      event_type: "BOOKED",
      details: JSON.stringify({ referenceId: "GESX-CAI-RETRY-OK", week: "9/20/2026", retry: true, correlationId: corrId, attempt: 2 }),
      created_at: "2026-09-08 12:00:48"
    }
  ];

  const report = aggregateDailyReport(rows, cairoDay);
  assert.strictEqual(report.opportunities_found, 1);
  assert.strictEqual(report.opportunities_booked, 1);
  assert.strictEqual(report.opportunities_missed, 0);
  assert.strictEqual(report.technical_failures, 0);

  // Timeline entries check
  const retryEvent = report.timeline.find(t => t.event_type === "BOOKING_RETRY");
  assert.ok(retryEvent, "Timeline must contain BOOKING_RETRY event");
  assert.strictEqual(retryEvent.attempt, 1);

  const bookedEvent = report.timeline.find(t => t.event_type === "BOOKED");
  assert.ok(bookedEvent, "Timeline must contain BOOKED event");
  assert.strictEqual(bookedEvent.attempt, 2);
  assert.ok(bookedEvent.message.includes("بعد محاولة ثانية"));
});

test("Historical Records Tolerance: Legacy rows without correlationId or classification render gracefully", () => {
  const cairoDay = "2026-09-08";
  const legacyRows: ReportRow[] = [
    {
      job_id: "legacy_j1",
      client_id: "legacy_c1",
      event_type: "APPOINTMENT_FOUND",
      details: JSON.stringify({ week: "8/18/2026" }),
      created_at: "2026-09-08 08:30:00"
    },
    {
      job_id: "legacy_j1",
      client_id: "legacy_c1",
      event_type: "BOOKING_FAILED",
      details: JSON.stringify({ week: "8/18/2026", error: "Legacy error without classification" }),
      created_at: "2026-09-08 08:31:00"
    }
  ];

  const report = aggregateDailyReport(legacyRows, cairoDay);
  assert.strictEqual(report.opportunities_found, 1);
  assert.strictEqual(report.opportunities_missed, 1, "Legacy unclassified failure defaults to missed");

  assert.strictEqual(report.timeline.length, 2);
  const failedEntry = report.timeline[1];
  assert.strictEqual(failedEntry.is_historical, true, "Legacy entry must be flagged as historical");
  assert.strictEqual(failedEntry.correlation_id, undefined);
  assert.strictEqual(failedEntry.attempt, undefined);
  assert.ok(failedEntry.status_badge.length > 0);
});

test("Multi-Day Cairo History: Grouping, ordering, and aggregation across midnight boundaries", () => {
  const allRows: ReportRow[] = [
    // Day 1: 2026-09-06
    {
      job_id: "j_d1",
      client_id: "c_d1",
      event_type: "APPOINTMENT_FOUND",
      details: JSON.stringify({ week: "9/15/2026" }),
      created_at: "2026-09-06 10:00:00"
    },
    {
      job_id: "j_d1",
      client_id: "c_d1",
      event_type: "BOOKED",
      details: JSON.stringify({ referenceId: "REF-D1", week: "9/15/2026" }),
      created_at: "2026-09-06 10:02:00"
    },
    // Day 2: 2026-09-07
    {
      job_id: "j_d2",
      client_id: "c_d2",
      event_type: "APPOINTMENT_FOUND",
      details: JSON.stringify({ week: "9/22/2026" }),
      created_at: "2026-09-07 14:00:00"
    },
    {
      job_id: "j_d2",
      client_id: "c_d2",
      event_type: "SLOT_GONE_PRE_LAUNCH",
      details: JSON.stringify({ week: "9/22/2026", classification: "SLOT_GONE" }),
      created_at: "2026-09-07 14:01:00"
    },
    // Day 3: 2026-09-08 (Cairo rollover across UTC boundary: 2026-09-07 22:00 UTC = 2026-09-08 01:00 Cairo)
    {
      job_id: "j_d3",
      client_id: "c_d3",
      event_type: "APPOINTMENT_FOUND",
      details: JSON.stringify({ week: "9/29/2026" }),
      created_at: "2026-09-07 22:00:00"
    }
  ];

  const history = summarizePriorCairoDays(allRows);
  assert.strictEqual(history.length, 3, "Must summarize 3 distinct Cairo days");

  // Sorted descending by date
  assert.strictEqual(history[0].date, "2026-09-08");
  assert.strictEqual(history[0].opportunities_found, 1);
  assert.strictEqual(history[0].was_open, true);

  assert.strictEqual(history[1].date, "2026-09-07");
  assert.strictEqual(history[1].opportunities_missed, 1);

  assert.strictEqual(history[2].date, "2026-09-06");
  assert.strictEqual(history[2].opportunities_booked, 1);
});

test("Slot-Selection Invariant: calculateMondayString reliably maps all 7 days to the identical target Monday", () => {
  const targetMonday = "9/21/2026 12:00:00 AM";
  const daysInWeek = [
    "9/21/2026 09:00:00 AM", // Monday
    "9/22/2026 10:30:00 AM", // Tuesday
    "9/23/2026 11:15:00 AM", // Wednesday
    "9/24/2026 01:00:00 PM", // Thursday
    "9/25/2026 02:00:00 PM", // Friday
    "9/26/2026 03:00:00 PM", // Saturday
    "9/27/2026 09:00:00 AM", // Sunday (Cairo BMEIA slot date)
  ];

  for (const d of daysInWeek) {
    const computedMonday = calculateMondayString(new Date(d));
    assert.strictEqual(
      computedMonday,
      targetMonday,
      `Day ${d} must map to Monday ${targetMonday}, got ${computedMonday}`
    );
  }

  // Days outside the target week must NOT map to targetMonday
  const priorWeekDay = "9/20/2026 09:00:00 AM"; // Prior Sunday -> maps to 9/14
  const nextWeekDay = "9/28/2026 09:00:00 AM";  // Next Monday -> maps to 9/28
  assert.notStrictEqual(calculateMondayString(new Date(priorWeekDay)), targetMonday);
  assert.strictEqual(calculateMondayString(new Date(nextWeekDay)), "9/28/2026 12:00:00 AM");
});

test("Slot-Selection Invariant: Unmatched forward week refuses arbitrary radio fallback and aborts with SLOT_GONE", async () => {
  // Mock browser binding where grid contains radios for a DIFFERENT week (e.g. 10/12/2026).
  // Puppeteer-shaped fakes (ElementHandle.evaluate — no getAttribute/check),
  // injected via the launcher option so no real launch is attempted.
  let checkedRadioValue: string | null = null;
  const mockPage = {
    goto: async () => {},
    waitForSelector: async (sel: string) => {
      if (sel.includes("Office") || sel.includes("CalendarId") || sel.includes("PersonCount")) return {};
      return null;
    },
    select: async () => [],
    waitForNavigation: async () => {},
    evaluate: async () => {},
    content: async () => `<html><body><input type="radio" name="Start" value="10/12/2026 9:00:00 AM"></body></html>`,
    screenshot: async () => Buffer.from("fake-shot"),
    $$: async (sel: string) => {
      if (sel.includes('input[type="radio"]')) {
        return [
          {
            evaluate: async (fn: any, name: string) =>
              typeof fn === "function" && name === "value" ? "10/12/2026 9:00:00 AM" : null,
            click: async () => { checkedRadioValue = "10/12/2026 9:00:00 AM"; }
          }
        ];
      }
      return [];
    },
    $: async () => null,
    close: async () => {}
  };

  const mockBrowser = {
    newPage: async () => mockPage,
    close: async () => {}
  };

  // Target week requested: 9/21/2026 12:00:00 AM, but screen only has 10/12/2026
  const res = await executePlaywrightFallback({}, validBachelorClient, {
    startTime: "9/21/2026 12:00:00 AM",
    launcher: async () => mockBrowser
  });

  assert.strictEqual(res.success, false);
  assert.strictEqual(res.classification, "SLOT_GONE");
  assert.ok(
    res.errorMessage?.includes("Target week slot not found in scheduler grid"),
    `Error must explain target week not found. Got: ${res.errorMessage}`
  );
  assert.strictEqual(
    checkedRadioValue,
    null,
    "CRITICAL: Must NEVER check/select an arbitrary radio from an unrelated week"
  );
});

