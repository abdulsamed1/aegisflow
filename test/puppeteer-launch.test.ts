import test from "node:test";
import assert from "node:assert";
import { executePlaywrightFallback } from "../src/browser-fallback";
import { calculateMondayString } from "../src/scheduler";

// Regression (prod 2026-09-10/11): EVERY booking attempt crashes inside
// @cloudflare/playwright's launch — playwright-core's _connectOverCDPInternal
// unconditionally calls fs.promises.mkdtemp (chromium.js), which the Workers
// runtime does not implement ("[unenv] fs.mkdtemp is not implemented yet!").
// Verified 2026-09-11: 1.3.6 AND 1.2.0 contain the identical crash site, so no
// version bump fixes it. The launch MUST go through @cloudflare/puppeteer,
// whose Workers path (acquire → connect over binding.fetch + WebSocket) is
// fs-free. These tests lock that in with puppeteer-shaped fakes: no
// @cloudflare/playwright import may be needed for launch to succeed.

const BACHELOR_CLIENT: any = { category: "Bachelor", calendarId: 44281520 };

// Minimal puppeteer-shaped page: every automation primitive the fallback uses.
function fakeRadio(isoValue: string): any {
  return {
    click: async () => null,
    evaluate: async (fn: any) => (typeof fn === "function" ? isoValue : null),
  };
}

function fakePage(handles: { radios?: any[]; lastname?: boolean; submit?: boolean; html?: string }): any {
  return {
    goto: async () => null,
    waitForSelector: async () => (handles.lastname ? { click: async () => null } : null),
    $: async (sel: string) => {
      if (handles.lastname && /Lastname/.test(sel)) return { click: async () => null };
      if (handles.submit && (/nextButton|Command/.test(sel))) return { click: async () => null };
      return null;
    },
    $$: async () => handles.radios || [],
    evaluate: async (fn: any) => (typeof fn === "function" ? false : null),
    select: async () => [],
    waitForNavigation: async () => null,
    waitForFunction: async () => null,
    content: async () => handles.html || "<html></html>",
    screenshot: async () => null,
  };
}

function fakeBrowser(page: any): any {
  return { newPage: async () => page, close: async () => null };
}

test("launch via injected puppeteer-shaped launcher drives the full flow (no @cloudflare/playwright)", async () => {
  const weekMonday = calculateMondayString(new Date("2026-09-16T10:00:00.000Z"));
  const page = fakePage({
    radios: [fakeRadio("2026-09-16T10:00:00.000Z")],
    lastname: true,
    submit: true,
    html: "<html>done</html>",
  });
  const res = await executePlaywrightFallback(
    {},
    BACHELOR_CLIENT,
    { startTime: weekMonday, launcher: async () => fakeBrowser(page) } as any
  );
  assert.strictEqual(res.success, false);
  // Reached form fill + submit with the puppeteer API shape — launch worked,
  // portal just returned no GESX reference.
  assert.strictEqual(res.classification, "SUBMISSION_ERROR");
  assert.strictEqual(res.stageReached, "SUBMITTED");
  assert.strictEqual(res.submitted, true);
});

test("launcher throwing the exact prod mkdtemp string still surfaces LAUNCH_ERROR", async () => {
  const res = await executePlaywrightFallback(
    {},
    BACHELOR_CLIENT,
    {
      launcher: async () => {
        throw new Error("browserType.connectOverCDP: [unenv] fs.mkdtemp is not implemented yet!");
      },
    } as any
  );
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.classification, "LAUNCH_ERROR");
});

test("empty grid with target week → SLOT_GONE (not a launch failure)", async () => {
  const weekMonday = calculateMondayString(new Date("2026-09-16T10:00:00.000Z"));
  const res = await executePlaywrightFallback(
    {},
    BACHELOR_CLIENT,
    { startTime: weekMonday, launcher: async () => fakeBrowser(fakePage({})) } as any
  );
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.classification, "SLOT_GONE");
});
