import test from "node:test";
import assert from "node:assert";
import { executePlaywrightFallback, resetThrottleLaunchForTests } from "../src/browser-fallback";
import { calculateMondayString } from "../src/scheduler";

const BACHELOR_CLIENT: any = {
  category: "Bachelor",
  calendarId: 44281520,
  firstName: "Ahmed",
  lastName: "Hassan",
  dob: "2000-01-01",
  passportNumber: "A12345678",
  gender: "Male",
  street: "Tahrir St",
  postalCode: "11511",
  city: "Cairo",
  phone: "+201000000000",
  email: "ahmed@example.com",
  familyNameAtBirth: "Hassan",
  nationalityAtBirth: "Egyptian",
  countryOfBirth: "Egypt",
  placeOfBirth: "Cairo",
  nationality: "Egyptian",
  passportIssueDate: "2020-01-01",
  passportExpiry: "2030-01-01",
  passportIssuingCountry: "Egypt"
};

function fakeRadio(isoValue: string): any {
  return {
    click: async () => null,
    evaluate: async (fn: any) => (typeof fn === "function" ? isoValue : null),
  };
}

test("browser wizard speed: fast-path direct POST lands directly on grid skipping steps 1-4", async () => {
  resetThrottleLaunchForTests();
  const weekMonday = calculateMondayString(new Date("2026-09-16T10:00:00.000Z"));

  let directPostSubmitted = false;
  let officeSelectCalled = false;
  let batchFormFillCalled = false;

  const page = {
    goto: async () => null,
    waitForSelector: async (sel: string) => {
      if (/Office/.test(sel)) {
        officeSelectCalled = true;
        return { click: async () => null };
      }
      if (/Lastname/.test(sel)) return { click: async () => null };
      return null;
    },
    $: async (sel: string) => {
      if (/Lastname/.test(sel)) return { click: async () => null };
      if (/nextButton|Command/.test(sel)) return { click: async () => null };
      return null;
    },
    $$: async (sel: string) => {
      if (/radio/.test(sel)) return [fakeRadio("2026-09-16T10:00:00.000Z")];
      return [];
    },
    evaluate: async (fn: any, args: any) => {
      if (typeof fn === "function") {
        const fnStr = fn.toString();
        if (fnStr.includes("Scheduler") && args?.office === "KAIRO") {
          directPostSubmitted = true;
        }
        if (fnStr.includes("Lastname") && args?.lastName === "Hassan") {
          batchFormFillCalled = true;
        }
      }
      return false;
    },
    setContent: async (html: string) => {
      if (html.includes("Scheduler") && html.includes("KAIRO")) {
        directPostSubmitted = true;
      }
      return null;
    },
    setCookie: async () => null,
    select: async () => [],
    waitForNavigation: async () => null,
    waitForFunction: async () => null,
    content: async () => "<html><input type='radio' value='2026-09-16T10:00:00.000Z' /></html>",
    screenshot: async () => null,
  };

  const fakeBrowser = { newPage: async () => page, close: async () => null };

  const res = await executePlaywrightFallback(
    {},
    BACHELOR_CLIENT,
    { startTime: weekMonday, launcher: async () => fakeBrowser } as any
  );

  assert.strictEqual(directPostSubmitted, true, "Fast-path POST to /HomeWeb/Scheduler must be executed");
  assert.strictEqual(officeSelectCalled, false, "Steps 1-4 should be skipped when fast-path lands on grid");
  assert.strictEqual(batchFormFillCalled, true, "Personal data form must be filled in batch evaluate");
  assert.strictEqual(res.submitted, true);
});

test("browser wizard speed: falls back cleanly to steps 1-4 when fast-path POST does not reach grid", async () => {
  resetThrottleLaunchForTests();
  const weekMonday = calculateMondayString(new Date("2026-09-16T10:00:00.000Z"));

  let officeSelected = false;
  let calSelected = false;
  let personCountSelected = false;
  let radiosReturned = false;

  const page = {
    goto: async () => null,
    waitForSelector: async (sel: string) => {
      if (/Office/.test(sel)) return { click: async () => null };
      if (/CalendarId/.test(sel)) return { click: async () => null };
      if (/PersonCount/.test(sel)) return { click: async () => null };
      if (/Lastname/.test(sel)) return { click: async () => null };
      return null;
    },
    $: async (sel: string) => {
      if (/radio/.test(sel)) return radiosReturned ? { click: async () => null } : null;
      if (/Lastname/.test(sel)) return { click: async () => null };
      if (/nextButton|Command/.test(sel)) return { click: async () => null };
      return null;
    },
    $$: async (sel: string) => {
      if (/radio/.test(sel)) {
        if (!radiosReturned) return []; // initial fast-path check: no radios
        return [fakeRadio("2026-09-16T10:00:00.000Z")];
      }
      return [];
    },
    evaluate: async (fn: any) => {
      if (typeof fn === "function") {
        const fnStr = fn.toString();
        // simulate fast-path POST failing to reach grid
        if (fnStr.includes("Scheduler")) {
          return false;
        }
      }
      return false;
    },
    select: async (sel: string, val: string) => {
      if (/Office/.test(sel)) officeSelected = true;
      if (/CalendarId/.test(sel)) calSelected = true;
      if (/PersonCount/.test(sel)) {
        personCountSelected = true;
        radiosReturned = true; // after step 3 & info, grid becomes available
      }
      return [];
    },
    setContent: async () => null,
    setCookie: async () => null,
    waitForNavigation: async () => null,
    waitForFunction: async () => null,
    content: async () => radiosReturned ? "<html><input type='radio' value='2026-09-16T10:00:00.000Z' /></html>" : "<html>no grid</html>",
    screenshot: async () => null,
  };

  const fakeBrowser = { newPage: async () => page, close: async () => null };

  const res = await executePlaywrightFallback(
    {},
    BACHELOR_CLIENT,
    { startTime: weekMonday, launcher: async () => fakeBrowser } as any
  );

  assert.strictEqual(officeSelected, true, "Must select Office on fallback");
  assert.strictEqual(calSelected, true, "Must select CalendarId on fallback");
  assert.strictEqual(personCountSelected, true, "Must select PersonCount on fallback");
  assert.strictEqual(res.submitted, true);
});

test("parseCookieHeader: guarantees AspxAutoDetectCookieSupport=1 and parses session cookie", async () => {
  const { parseCookieHeader } = await import("../src/browser-fallback");

  // Empty string
  const c1 = parseCookieHeader("");
  assert.strictEqual(c1.length, 1);
  assert.strictEqual(c1[0].name, "AspxAutoDetectCookieSupport");
  assert.strictEqual(c1[0].value, "1");

  // Only session ID
  const c2 = parseCookieHeader("ASP.NET_SessionId=test123xyz");
  assert.strictEqual(c2.length, 2);
  const sess = c2.find((c: any) => c.name === "ASP.NET_SessionId");
  const aspx = c2.find((c: any) => c.name === "AspxAutoDetectCookieSupport");
  assert.strictEqual(sess?.value, "test123xyz");
  assert.strictEqual(aspx?.value, "1");

  // Already contains AspxAutoDetectCookieSupport
  const c3 = parseCookieHeader("AspxAutoDetectCookieSupport=1; ASP.NET_SessionId=sess999");
  assert.strictEqual(c3.length, 2);
});

test("browser wizard: pre-seeds session cookie on page before navigation", async () => {
  resetThrottleLaunchForTests();
  const weekMonday = calculateMondayString(new Date("2026-09-16T10:00:00.000Z"));

  let cookiesSet: any[] = [];
  const page = {
    setCookie: async (c: any) => { cookiesSet.push(c); },
    setContent: async () => null,
    goto: async () => null,
    waitForSelector: async (sel: string) => (/Lastname/.test(sel) ? { click: async () => null } : null),
    $: async (sel: string) => (/Lastname/.test(sel) ? { click: async () => null } : null),
    $$: async (sel: string) => (/radio/.test(sel) ? [fakeRadio("2026-09-16T10:00:00.000Z")] : []),
    evaluate: async () => false,
    select: async () => [],
    waitForNavigation: async () => null,
    waitForFunction: async () => null,
    content: async () => "<html><input type='radio' value='2026-09-16T10:00:00.000Z' /></html>",
    screenshot: async () => null,
  };

  const fakeBrowser = { newPage: async () => page, close: async () => null };

  await executePlaywrightFallback(
    {},
    BACHELOR_CLIENT,
    {
      startTime: weekMonday,
      sessionCookie: "AspxAutoDetectCookieSupport=1; ASP.NET_SessionId=live_cairo_session",
      launcher: async () => fakeBrowser,
    } as any
  );

  assert.ok(cookiesSet.some((c) => c.name === "AspxAutoDetectCookieSupport" && c.value === "1"));
  assert.ok(cookiesSet.some((c) => c.name === "ASP.NET_SessionId" && c.value === "live_cairo_session"));
});

