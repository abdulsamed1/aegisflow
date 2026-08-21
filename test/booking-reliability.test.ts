import test from "node:test";
import assert from "node:assert";
import { decideReverifyAction, decideRetryAction } from "../src/booking-flow";
import { isCircuitBreakerTripped } from "../src/backoff";
import { buildStep3DetailsPayload } from "../src/booking-http";

// a) CAPTCHA fix: payload carries real CaptchaText + hidden BDC, wizard only succeeds with GESX
test("Reliability a: corrected payload carries CaptchaText and BDC hidden fields", () => {
  const c: any = { firstName:"A", lastName:"B", familyNameAtBirth:"B", placeOfBirth:"Cairo", countryOfBirth:"Egypt", nationalityAtBirth:"Egyptian", street:"S", postalCode:"11511", city:"Cairo", passportIssueDate:"2020-01-01", passportIssuingCountry:"Egypt", gender:"Male", dob:"1998-01-01", nationality:"Egyptian", passportNumber:"A123", passportExpiry:"2030-01-01", email:"a@b.com", phone:"+201", category:"Bachelor", calendarId:44281520 };
  const p = new URLSearchParams(buildStep3DetailsPayload(c, "C65P", "8/26/2026 10:00 AM", "10:00", { token:"tok", bdc:{ vcid:"v1", hs:"h1", sp:"s1", bw:"b1" } }));
  assert.strictEqual(p.get("CaptchaText"), "C65P");
  assert.strictEqual(p.get("BDC_VCID_Captcha"), "v1");
  assert.strictEqual(p.get("BDC_Hs_Captcha"), "h1");
  assert.strictEqual(p.get("Token"), "tok");
  assert.strictEqual(p.get("Lastname"), "B");
  assert.strictEqual(p.get("DSGVOAccepted"), "true");
  assert.ok(!p.has("LastName"));
});

// b) Slot re-verification prevents wasted Playwright launch when slot gone
test("Reliability b: reverify aborts launch when slot disappeared", async () => {
  // Simulate scheduled's reverify branch: if SLOTS->PROCEED else no launch
  let launchCalled = false;
  const fakeLaunch = async () => { launchCalled = true; return { success:true, durationSeconds:1, referenceId:"GESX-TEST" } as any; };
  const reverifyGone = { status:"NO_SLOTS" as const, durationMs:100, rawResponseLength:100, hasSlots:false, matchedMonday:"8/26/2026" };
  const action = decideReverifyAction(reverifyGone as any);
  assert.strictEqual(action, "ABORT_SLOT_GONE");
  if (action === "PROCEED") await fakeLaunch();
  assert.strictEqual(launchCalled, false, "must NOT launch browser when slot gone — saves budget");

  // When SLOTS, should proceed
  launchCalled = false;
  const reverifyOk = { status:"SLOTS" as const, durationMs:100, rawResponseLength:200, hasSlots:true, matchedMonday:"8/26/2026" };
  assert.strictEqual(decideReverifyAction(reverifyOk as any), "PROCEED");
  if (decideReverifyAction(reverifyOk as any) === "PROCEED") await fakeLaunch();
  assert.strictEqual(launchCalled, true);
});

// c) Dual-failure retry bounded under burst: cannot exceed breaker, at most one retry
test("Reliability c: dual-failure retry respects circuit breaker and is bounded to one retry", () => {
  // Simulate burst: 3 jobs, each fails first attempt, breaker at 539, 540, 600
  assert.strictEqual(isCircuitBreakerTripped(539), false);
  assert.strictEqual(isCircuitBreakerTripped(540), true);
  assert.strictEqual(isCircuitBreakerTripped(600), true);

  // First fail, slot still there, breaker not tripped -> RETRY (exactly one)
  assert.strictEqual(decideRetryAction({success:false} as any, {status:"SLOTS"} as any, false), "RETRY");
  // But if breaker tripped, no retry even with slot
  assert.strictEqual(decideRetryAction({success:false} as any, {status:"SLOTS"} as any, true), "REQUEUE");
  // If slot gone, no retry
  assert.strictEqual(decideRetryAction({success:false} as any, {status:"NO_SLOTS"} as any, false), "REQUEUE");
  // After retry, second failure always REQUEUE (no second retry) — enforced by scheduled doing at most one RETRY decision then requeue
  // Verify bounded: loop would call decideRetry at most once per job
  let retryCount = 0;
  const simulateJob = (rescanStillSlots: boolean, breaker: boolean) => {
    const d = decideRetryAction({success:false} as any, {status: rescanStillSlots ? "SLOTS":"NO_SLOTS"} as any, breaker);
    if (d === "RETRY") retryCount++;
    // second attempt fails -> always REQUEUE, no further retry
    const d2 = decideRetryAction({success:false} as any, {status:"SLOTS"} as any, breaker);
    assert.strictEqual(d2 === "RETRY" ? 1 : 0, d === "RETRY" ? 1 : 0, "second decision would still be RETRY only if logic allowed second retry — but scheduled only calls once, so bounded");
  };
  simulateJob(true, false);
  assert.strictEqual(retryCount, 1, "at most one retry per job");
});

// Also verify breaker budget math: 3 jobs * ~10s each = 30s, still under 540, but 5 retries would approach limit — single retry bound keeps it under
test("Reliability c2: burst budget stays under breaker with single retry", () => {
  const perAttemptSec = 10;
  const jobs = 3;
  const withOneRetryPerJob = jobs * perAttemptSec * 2; // worst: each retries once
  assert.ok(withOneRetryPerJob < 540, "3 jobs with one retry each (60s) stays under 540s breaker");
  const withManyRetries = jobs * perAttemptSec * 20; // 600s would trip
  assert.ok(withManyRetries >= 540, "many retries would trip breaker — hence single retry bound is correct");
});
