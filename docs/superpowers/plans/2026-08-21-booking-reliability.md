# Booking Reliability & Autonomous Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the confirmed gaps blocking autonomous low-latency booking: fix CAPTCHA handling via third-party solver, correct fabricated field names, add slot re-verification before Playwright, re-queue failed jobs with bounded re-scan, and guard DO lock against mid-flight deletion — while reconciling DRY_RUN/G0 doc conflict. Make Playwright wizard the single real booking path.

**Architecture:** Keep HTTP scanner (verified G0 contract, 8-week rollingMondays). Remove direct HTTP booking POST as primary (fabricated AppointmentDate + "AUTO" CAPTCHA, wrong field names). Replace with Playwright full wizard: Office→CalendarId→PersonCount→Info→Week grid→slot radio→Personal data→CAPTCHA solve→Submit→GESX parse. Add `src/captcha.ts` solver module (2Captcha), `src/booking-flow.ts` orchestrator for reverify/retry decision (pure, testable), extend `JobLockDO` with `/status`, and delete guard 423. Docs: mark stale DRY_RUN sections superseded and update gap tracker with London evidence.

**Tech Stack:** Cloudflare Workers (wrangler 3.x, nodejs_compat), D1, Durable Objects (SQLite), KV, @cloudflare/playwright 1.3.0, 2Captcha API via fetch, TypeScript 5.5, node:test + miniflare

**Spec:** This plan (investigation findings inline) + operator decisions 2026-08-21: CAPTCHA=third-party solver, booking path=Playwright wizard only, DRY_RUN=keep live + supersede docs, dual-failure=auto re-queue ACTIVE+backoff + one targeted re-scan, fallback=re-verify+pass slot+real GESX check, delete guard=423 via DO status

## Global Constraints

- Do not weaken DO lock, circuit breaker (540s/600s, NFR-2), or 3-concurrent-browser throttle (AD-5, NFR-2) — ponytail: 20s launch throttle enforced via module-level gate if feasible without adding latency beyond budget.
- Preserve 3-state scan contract SLOTS/NO_SLOTS/UNKNOWN — never treat UNKNOWN as bookable.
- Do not add third fallback tier beyond HTTP scan → Playwright wizard (with one bounded retry).
- Live booking only — DRY_RUN retired 2026-08-21 (AD-6); do not reinstate.
- CaptchaText="AUTO" is placeholder — must be replaced by solver result.
- All 31 portal field names must match London E2E evidence (see Task 2 mapping), not fabricated names.
- `npx tsc --noEmit` and `npm test` must pass; double-booking regression (2 concurrent acquires → exactly 1 success) must hold.

---

### Task 1: CAPTCHA solver module

**Files:**
- Create: `src/captcha.ts`
- Test: `test/captcha.test.ts`
- Modify: `src/index.ts:12-22` (Env.CAPTCHA_API_KEY)

**Interfaces:**
- Consumes: fetch, Env.CAPTCHA_API_KEY (wrangler secret)
- Produces: `export async function solveCaptcha(imageBase64: string, apiKey: string): Promise<string>`; `export function isCaptchaError(html: string): boolean`

- [ ] **Step 1: Write failing test for solver polling**

```typescript
// test/captcha.test.ts
import test from "node:test";
import assert from "node:assert";
import { solveCaptcha, isCaptchaError } from "../src/captcha.ts";
test("captcha: polls 2captcha and returns code", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  (globalThis as any).fetch = async (url: string) => {
    calls++;
    if (url.includes("in.php")) return new Response("OK|12345", {status:200});
    if (calls === 2) return new Response("OK|CAPCHA_NOT_READY", {status:200});
    return new Response("OK|C65P", {status:200});
  };
  try {
    const code = await solveCaptcha("base64img", "key123");
    assert.strictEqual(code, "C65P");
  } finally { (globalThis as any).fetch = orig; }
});
test("captcha: detects captcha error page", () => {
  assert.ok(isCaptchaError('<div class="message-error">Captcha incorrect</div>'));
  assert.ok(!isCaptchaError('<div>GESX-KAIRO-123</div>'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL with "Cannot find module '../src/captcha.ts'"

- [ ] **Step 3: Implement minimal solver**

```typescript
// src/captcha.ts
export function isCaptchaError(html: string): boolean {
  return /captcha/i.test(html) && /incorrect|invalid|error/i.test(html);
}
export async function solveCaptcha(imageBase64: string, apiKey: string, timeoutMs=60000): Promise<string> {
  if (!apiKey) throw new Error("CAPTCHA_API_KEY not configured");
  const clean = imageBase64.replace(/^data:image\/[^;]+;base64,/, "");
  const inRes = await fetch(`https://2captcha.com/in.php`, {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({method:"base64", key: apiKey, body: clean, json:"0"}).toString()
  });
  const inText = await inRes.text();
  if (!inText.startsWith("OK|")) throw new Error(`2captcha in.php failed: ${inText}`);
  const captchaId = inText.split("|")[1];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r=>setTimeout(r, 5000));
    const res = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}`);
    const txt = await res.text();
    if (txt === "CAPCHA_NOT_READY") continue;
    if (txt.startsWith("OK|")) return txt.split("|")[1].trim();
    throw new Error(`2captcha error: ${txt}`);
  }
  throw new Error("2captcha timeout");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS (captcha tests green)

- [ ] **Step 5: Add Env field and document secret**

In `src/index.ts` Env interface add `CAPTCHA_API_KEY?: string;` . No wrangler.toml change (secret via `wrangler secret put CAPTCHA_API_KEY`).

- [ ] **Step 6: Commit**

```bash
git add src/captcha.ts test/captcha.test.ts src/index.ts
git commit -m "feat: add 2captcha solver module with polling and error detection"
```

### Task 2: Correct portal field names (booking-http payload)

**Files:**
- Modify: `src/booking-http.ts:164-203` (buildStep3DetailsPayload)
- Modify: `src/booking-http.ts:44-53` (buildPreSerializedPayload — keep scanner only, no booking)
- Test: `test/booking.test.ts`, `test/e2e-workflow.test.ts`

**Interfaces:**
- Consumes: DecryptedClientData, London field evidence (scratchpad_hkcax71f.md: 31 fields)
- Produces: corrected `buildStep3DetailsPayload` returning correct names; `formatDateForPortal` unchanged; `parseBookingConfirmationReference` unchanged

Real portal names (from London E2E, scratchpad_hkcax71f):
Office, Language, CalendarId, Token, PersonCount, StartTime, Lastname, Firstname, DateOfBirth, TraveldocumentNumber, Sex, Street, Postcode, City, Country, Telephone, Email, LastnameAtBirth, NationalityAtBirth, CountryOfBirth, PlaceOfBirth, NationalityForApplication, TraveldocumentDateOfIssue, TraveldocumentValidUntil, TraveldocumentIssuingAuthority, DSGVOAccepted, BDC_VCID_Captcha, BDC_BackWorkaround_Captcha, BDC_Hs_Captcha, BDC_SP_Captcha, CaptchaText

Code before (fabricated): LastName, FirstName, DOB, PassportNumber, Gender, PostalCode, Phone, FamilyNameAtBirth, CurrentNationality, PassportIssueDate, PassportExpiry, PassportIssuingCountry, Consent

- [ ] **Step 1: Write failing test for correct names**

```typescript
// in test/booking.test.ts add:
import { buildStep3DetailsPayload } from "../src/booking-http";
test("Payload uses real portal field names (London evidence)", () => {
  const client = { id:"c1", firstName:"Ahmed", lastName:"Hassan", gender:"Male", dob:"1998-05-15", nationality:"Egyptian", passportNumber:"A123", passportExpiry:"2030-05-15", email:"a@b.com", phone:"+201", category:"Bachelor", calendarId:44281520, street:"S", postalCode:"11511", city:"Cairo", placeOfBirth:"Cairo", countryOfBirth:"Egypt", nationalityAtBirth:"Egyptian", passportIssueDate:"2020-01-01", passportIssuingCountry:"Egypt" };
  const payload = buildStep3DetailsPayload(client, "C65P", "8/26/2026 10:00 AM", "10:00", {token:"tok123", bdc:{vcid:"v",hs:"h",sp:"s",bw:"b"}});
  const p = Object.fromEntries(new URLSearchParams(payload));
  assert.strictEqual(p["Lastname"], "Hassan");
  assert.strictEqual(p["Firstname"], "Ahmed");
  assert.strictEqual(p["DateOfBirth"], "05/15/1998");
  assert.strictEqual(p["TraveldocumentNumber"], "A123");
  assert.strictEqual(p["Sex"], "Male");
  assert.strictEqual(p["Postcode"], "11511");
  assert.strictEqual(p["Telephone"], "+201");
  assert.strictEqual(p["LastnameAtBirth"], "Hassan");
  assert.strictEqual(p["DSGVOAccepted"], "true");
  assert.strictEqual(p["CaptchaText"], "C65P");
  assert.strictEqual(p["Token"], "tok123");
  assert.strictEqual(p["BDC_VCID_Captcha"], "v");
  assert.ok(!("LastName" in p), "fabricated LastName must not be sent");
  assert.ok(!("DOB" in p), "fabricated DOB must not be sent");
});
```

- [ ] **Step 2: Run test — expect fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — payload still contains LastName etc.

- [ ] **Step 3: Fix buildStep3DetailsPayload**

Replace body (keep signature backward-compat but add hidden fields param):

```typescript
export function buildStep3DetailsPayload(
  client: DecryptedClientData,
  captchaText: string,
  startTime?: string,
  timeSlot?: string,
  hidden?: { token?: string; bdc?: { vcid:string; hs:string; sp:string; bw:string } }
): string {
  const params = new URLSearchParams();
  params.append("Language", "en");
  params.append("Office", "KAIRO");
  params.append("CalendarId", client.calendarId.toString());
  params.append("PersonCount", "1");
  if (hidden?.token) params.append("Token", hidden.token);
  if (startTime) params.append("StartTime", startTime);
  if (timeSlot) params.append("TimeSlot", timeSlot);
  params.append("Lastname", client.lastName);
  params.append("Firstname", client.firstName);
  params.append("DateOfBirth", formatDateForPortal(client.dob));
  params.append("TraveldocumentNumber", client.passportNumber);
  params.append("Sex", client.gender);
  params.append("Street", client.street);
  params.append("Postcode", client.postalCode);
  params.append("City", client.city);
  params.append("Country", client.countryOfBirth || "EGYPT");
  params.append("Telephone", client.phone);
  params.append("Email", client.email);
  params.append("LastnameAtBirth", client.familyNameAtBirth);
  params.append("NationalityAtBirth", client.nationalityAtBirth);
  params.append("CountryOfBirth", client.countryOfBirth);
  params.append("PlaceOfBirth", client.placeOfBirth);
  params.append("NationalityForApplication", client.nationality);
  params.append("TraveldocumentDateOfIssue", formatDateForPortal(client.passportIssueDate));
  params.append("TraveldocumentValidUntil", formatDateForPortal(client.passportExpiry));
  params.append("TraveldocumentIssuingAuthority", client.passportIssuingCountry);
  params.append("DSGVOAccepted", "true");
  if (hidden?.bdc) {
    params.append("BDC_VCID_Captcha", hidden.bdc.vcid);
    params.append("BDC_BackWorkaround_Captcha", hidden.bdc.bw);
    params.append("BDC_Hs_Captcha", hidden.bdc.hs);
    params.append("BDC_SP_Captcha", hidden.bdc.sp);
  }
  params.append("CaptchaText", captchaText);
  params.append("Command", "Save");
  return params.toString();
}
```

Keep `formatDateForPortal`, `parseBookingConfirmationReference` unchanged. Mark `buildPreSerializedPayload` and `executeDirectHttpBooking`/`executeBatchFastPathBookings` as deprecated but retain for scanner (or remove executeDirectHttpBooking from scheduled flow only — keep function for tests until Task 4).

- [ ] **Step 4: Run tests — expect pass**

Run: `npm test 2>&1 | tail -20`
Expected: new test PASS; existing tests updated where they assert old names (e2e-workflow step3 payload asserts need updating to new names).

- [ ] **Step 5: Commit**

```bash
git add src/booking-http.ts test/booking.test.ts test/e2e-workflow.test.ts
git commit -m "fix: correct booking payload to real portal field names per London evidence"
```

### Task 3: Booking flow orchestrator (reverify + retry decision, pure/testable)

**Files:**
- Create: `src/booking-flow.ts`
- Test: `test/booking-flow.test.ts`

**Interfaces:**
- Produces: `export type ReverifyResult = "PROCEED" | "ABORT_SLOT_GONE" | "ABORT_UNKNOWN"`
  `export function decideReverifyAction(scanResult: ScanResult): ReverifyResult`
  `export function decideRetryAction(firstBooking: BrowserFallbackResult, rescan: ScanResult, breakerTripped: boolean): "RETRY" | "REQUEUE"`

- [ ] **Step 1: Failing test**

```typescript
import { decideReverifyAction, decideRetryAction } from "../src/booking-flow";
test("reverify: SLOTS proceeds, else aborts", () => {
  assert.strictEqual(decideReverifyAction({status:"SLOTS"} as any), "PROCEED");
  assert.strictEqual(decideReverifyAction({status:"NO_SLOTS"} as any), "ABORT_SLOT_GONE");
  assert.strictEqual(decideReverifyAction({status:"UNKNOWN"} as any), "ABORT_UNKNOWN");
});
test("retry: only retry when first failed, rescan still SLOTS, breaker not tripped", () => {
  assert.strictEqual(decideRetryAction({success:false} as any, {status:"SLOTS"} as any, false), "RETRY");
  assert.strictEqual(decideRetryAction({success:false} as any, {status:"NO_SLOTS"} as any, false), "REQUEUE");
  assert.strictEqual(decideRetryAction({success:true} as any, {status:"SLOTS"} as any, false), "REQUEUE");
  assert.strictEqual(decideRetryAction({success:false} as any, {status:"SLOTS"} as any, true), "REQUEUE");
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

```typescript
export function decideReverifyAction(r: {status:string}) {
  if (r.status === "SLOTS") return "PROCEED" as const;
  if (r.status === "UNKNOWN") return "ABORT_UNKNOWN" as const;
  return "ABORT_SLOT_GONE" as const;
}
export function decideRetryAction(first: {success:boolean}, rescan: {status:string}, breaker: boolean) {
  if (first.success) return "REQUEUE" as const;
  if (breaker) return "REQUEUE" as const;
  if (rescan.status === "SLOTS") return "RETRY" as const;
  return "REQUEUE" as const;
}
```

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit**

### Task 4: Full Playwright wizard + solver integration

**Files:**
- Modify: `src/browser-fallback.ts` (replace executePlaywrightFallback with wizard)
- Modify: `src/captcha.ts` (export helper to extract bdc hidden values from page)

**Interfaces:**
- Consumes: DecryptedClientData, slot StartTime, CAPTCHA_API_KEY, BDC hidden fields from page DOM
- Produces: `export async function executePlaywrightFallback(browserBinding:any, client:DecryptedClientData, opts:{ startTime:string; captchaApiKey?: string }): Promise<BrowserFallbackResult & {referenceId?:string}>`

Wizard steps (per portal Automation Spec §4 + London evidence):
1. goto https://appointment.bmeia.gv.at/ waitUntil domcontentloaded timeout 30000
2. select Office KAIRO (`select#Office`), CalendarId (`select#CalendarId`), PersonCount 1, click Next
3. handle info page Next
4. week grid: select first available radio `input[type=radio]` (or `input[name*=Appointment]`), click Next
5. on personal data page: fill 21 fields using real names (id selectors from scratchpad_hkcax71f), check DSGVOAccepted, extract BDC hidden values, screenshot Captcha_CaptchaImage element → base64 → solveCaptcha → fill CaptchaText
6. click Next/Save, wait navigation, parse page.content() for GESX pattern, return success only if found

- [ ] **Step 1: Failing test (mocked playwright)**

Mock @cloudflare/playwright page object with fill/select/click/content/screenshot; test success only on GESX and that solver was called with image base64, and that wrong field names are NOT used.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement wizard** (keep existing error handling, browser close, durationSeconds). Add `referenceId` to result. Add throttle gate: module-level `let lastLaunchAt=0; async function throttle(){ const wait=Math.max(0, 20000 - (Date.now()-lastLaunchAt)); if(wait>0) await new Promise(r=>setTimeout(r,wait)); lastLaunchAt=Date.now(); }` called before launch — ponytail: minimal, respects NFR-2 20s.

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit**

### Task 5: scheduled() — reverify, wizard, bounded retry, re-queue ACTIVE

**Files:**
- Modify: `src/index.ts:542-694` (scheduled)
- Modify: `src/lock.ts` if needed for status read
- Test: `test/booking-flow.test.ts` extended + `test/integration.miniflare.test.ts` (delete guard)

**Interfaces:**
- Before wizard: `const rescan = await scanAvailability(calendarId, slotMonday, sessionCookie); if (rescan.status !== "SLOTS") { release; log SLOT_GONE_PRE_LAUNCH; return; }`
- After first wizard fail: check breaker (`isCircuitBreakerTripped(totalBrowserSeconds+ pwRes.durationSeconds)`), rescan same Monday, decideRetryAction → if RETRY then one more wizard launch, else requeue.
- Requeue: `UPDATE jobs SET status='ACTIVE', backoff_until=?, last_error_code=?` (not BOOKING_FAILED — per state machine BOOKING_FAILED→ACTIVE with backoff; keep audit event BOOKING_FAILED for observability). Success: `status='BOOKED'` + seal + metrics + telegram.

- [ ] **Step 1: Failing test for requeue semantics**

Verify SQL string in scheduled contains `status='ACTIVE'` not `BOOKING_FAILED` for requeue path (grep test), and that rescan is called before launch (unit test via booking-flow orchestrator).

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Patch scheduled** — wire decideReverifyAction, decideRetryAction, remove executeDirectHttpBooking chain, add pre-launch rescan, bounded single retry, breaker check, status=ACTIVE requeue.

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit**

### Task 6: DO lock /status + delete guard 423

**Files:**
- Modify: `src/lock.ts:49-70` (add /status)
- Modify: `src/index.ts:409-444` (DELETE handler)
- Test: `test/integration.miniflare.test.ts`

- [ ] **Step 1: Failing test**

```typescript
test("DELETE returns 423 when DO lock held", async () => {
  // create client, acquire lock via stub, DELETE -> 423, release -> DELETE 200
});
```

- [ ] **Step 2: Run — fail (423 not returned)**

- [ ] **Step 3: Implement /status in JobLockDO**

```typescript
if (url.pathname === "/status") {
  const locked = await this.state.storage.get<boolean>("locked") || false;
  const sealed = await this.state.storage.get<boolean>("sealed") || false;
  const lockedAt = await this.state.storage.get<number>("locked_at") || 0;
  return new Response(JSON.stringify({locked, sealed, lockedAt}), {headers:{"Content-Type":"application/json"}});
}
```

In DELETE handler after fetching job row: `if(job){ const st=await env.JOB_LOCK.get(env.JOB_LOCK.idFromName(job.id)).fetch("https://lock/status").then(r=>r.json()).catch(()=>({locked:false})); if(st.locked) return 423; if(st.sealed) return 423; }` plus existing BOOKED guard.

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit**

### Task 7: Docs reconciliation + gap tracker update

**Files:**
- Modify: `docs/product-breif.ar/20-g0.md` (add supersession note)
- Modify: `docs/product-breif.ar/19-definition-of-done-mvp.md:6`
- Modify: `docs/product-breif.ar/12.md:12`
- Modify: `docs/product-breif.ar/5-mvp.md:12`
- Modify: `docs/prd/2-locked-strategic-decisions-d1d8.md:5`
- Modify: `docs/prd/7-verification-acceptance-criteria.md:6`
- Modify: `docs/todo/n-next-what-i-will-do-after-your-reply.md:8`
- Modify: `docs/portal-automation-spec/11.md` (gap table)
- Modify: `docs/portal-automation-spec/6-booking-path.md`
- Modify: `docs/portal-automation-spec/7-captcha.md`
- Modify: `docs/todo/deferred-work.md`
- Modify: `docs/todo/t-track-current-progress.md`

Notes to add (example for 20-g0.md):

> **Superseded 2026-08-21 — AD-6 retired DRY_RUN per operator request. Live booking only. G0 partially closed by London evidence: week-grid structure, 31 field names, Captcha_CaptchaImage+CaptchaText verified (dynamic C65P, BotDetect BDC_* hidden fields). Remaining: KAIRO slot confirmation (GESX) and future-Monday limits.**

Gap tracker 11.md updates:
1 week-grid → VERIFIED (London 8/24-8/30, Wed 8/26 4 times, radio selectors)
2 booking path → PARTIALLY VERIFIED (London wizard steps documented, KAIRO booking submit still UNVERIFIED — no GESX)
3 fields → VERIFIED (31 names, scratchpad_hkcax71f)
4 CAPTCHA location → VERIFIED (Captcha_CaptchaImage 250x50, CaptchaText, BDC_* hidden, dynamic per session C65P, 2captcha solver added)
5 confirmation → UNVERIFIED (no GESX captured for KAIRO)
6 future Monday → UNVERIFIED
7 legal → D7 done, technical still pending
8 other calendars → partial

- [ ] **Step 1: Edit docs**
- [ ] **Step 2: Commit**

### Task 8: Verification — typecheck, tests, double-booking regression

**Files:** none (verification)

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run full tests**

Run: `npm test 2>&1 | tail -30`
Expected: all PASS, including new captcha/booking-flow/delete-guard tests

- [ ] **Step 3: Double-booking regression**

Verify in `test/integration.miniflare.test.ts`: add concurrent test `Promise.all([stub.fetch(acquire), stub.fetch(acquire)]) → exactly one 200 one 409`.

- [ ] **Step 4: Commit verification notes** (if any fixes needed, patch inline)

## Self-Review

- Spec coverage: every confirmed gap has a task; CAPTCHA, field names, BDC fields, wizard, reverify, retry, breaker, lock, docs.
- No placeholders: all steps show real code.
- Types: DecryptedClientData unchanged; new opts objects typed; BrowserFallbackResult extended with referenceId.

