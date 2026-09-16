import { DecryptedClientData, formatDateForPortal, parseBookingConfirmationReference } from "./booking-http";
import { solveCaptcha, solveCaptchaAudio } from "./captcha";
import { CANONICAL_CALENDAR_ID } from "./pre-submit-gate";
import { calculateMondayString } from "./scheduler";

export type FailureClassification =
  | "SLOT_GONE"
  | "VALIDATION_ERROR"
  | "PORTAL_ERROR"
  | "TRANSIENT_ERROR"
  | "SUBMISSION_ERROR"
  | "CAPTCHA_ERROR"
  | "LAUNCH_ERROR"
  | "UNKNOWN";

export interface BrowserFallbackResult {
  success: boolean;
  durationSeconds: number;
  screenshotBase64?: string;
  referenceId?: string;
  selectedSlot?: string;
  stageReached?: "INIT" | "SLOT_SELECTION" | "FORM_FILL" | "CAPTCHA" | "SUBMITTED" | "CONFIRMED";
  errorMessage?: string;
  classification?: FailureClassification;
  submitted?: boolean;
}

//  20s sequential FIFO queue between browser launches (NFR-2) — module-level gate
let lastLaunchAt = 0;
let launchGate: Promise<void> = Promise.resolve();

export async function throttleLaunch(): Promise<void> {
  const currentGate = launchGate;
  let releaseGate: () => void;
  launchGate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  try {
    await currentGate;
    const wait = Math.max(0, 20000 - (Date.now() - lastLaunchAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastLaunchAt = Date.now();
  } finally {
    releaseGate!();
  }
}

export function resetThrottleLaunchForTests(timestamp = 0): void {
  lastLaunchAt = timestamp;
  launchGate = Promise.resolve();
}

//  LAUNCH_ERROR = Cloudflare-platform/dependency-level launch failure that a
// same-tick retry cannot plausibly recover from (prod 2026-09-06/08/10:
// every mkdtemp crash retried into a deterministic 429, burning ~20s of
// daily budget per pair). Pure helper so the rule is unit-testable.
export function classifyLaunchError(msg: string): FailureClassification {
  if (/fs\.mkdtemp|not implemented yet|Unable to create new browser|Rate limit exceeded|browserType\.|connectOverCDP|MYBROWSER binding not configured|Neither @cloudflare\/playwright|Neither @cloudflare\/puppeteer/i.test(msg)) {
    return "LAUNCH_ERROR";
  }
  if (/timeout|network|ECONNRESET|ECONNREFUSED|socket|Navigation failed/i.test(msg)) {
    return "TRANSIENT_ERROR";
  }
  return "UNKNOWN";
}

export interface BrowserFallbackOptions {
  startTime?: string;
  captchaApiKey?: string;
  ai?: any;
  //  injected launcher (tests): defaults to the @cloudflare/puppeteer path.
  launcher?: (binding: any) => Promise<any>;
}

//  Launch MUST go through @cloudflare/puppeteer (prod 2026-09-10/11:
// @cloudflare/playwright 1.2.0–1.3.6 always crashes in Workers —
// playwright-core's _connectOverCDPInternal unconditionally calls
// fs.promises.mkdtemp, which the runtime does not implement — while
// puppeteer's Workers path (acquire → connect over binding.fetch +
// WebSocket) is fs-free). Pure wrapper so the rule is unit-testable.
export async function launchBrowser(
  browserBinding: any,
  launcher?: (binding: any) => Promise<any>
): Promise<any> {
  if (launcher) return await launcher(browserBinding);
  const puppeteerModule = await import("@cloudflare/puppeteer").catch(() => null);
  const puppeteer = (puppeteerModule as any)?.default || puppeteerModule;
  if (puppeteer && typeof puppeteer.launch === "function") {
    return await puppeteer.launch(browserBinding);
  }
  if (browserBinding && typeof browserBinding.launch === "function") {
    return await browserBinding.launch();
  }
  if (browserBinding && typeof browserBinding.newPage === "function") {
    return browserBinding;
  }
  throw new Error("Neither @cloudflare/puppeteer nor compatible browserBinding available");
}

// Next-control helpers: CSS :has-text() is Playwright-only, so the portal's
// Next button (input[value=Next] or a submit button reading "Next") is found
// by DOM query inside page context instead.
// Submit-control click for the Office/Calendar/PersonCount steps (Playwright's
// page.click(selector) does not exist in puppeteer — click in page context).
async function clickSubmitControl(page: any): Promise<void> {
  await page.evaluate(() => {
    // @ts-ignore — browser context evaluation provides DOM document
    const doc = (globalThis as any).document;
    const el = doc.querySelector(
      'input[type="submit"], button[type="submit"], input[value="Next"]'
    ) as any;
    if (el) el.click();
  }).catch(() => null);
}

async function hasNextControl(page: any): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      // @ts-ignore — browser context evaluation provides DOM document
      const doc = (globalThis as any).document;
      if (doc.querySelector('input[name="Command"][value="Next"], input[value="Next"]')) return true;
      return Array.from(doc.querySelectorAll("button, input[type=submit]")).some(
        (x: any) => /next/i.test(x.textContent || x.value || "")
      );
    });
  } catch { return false; }
}

async function clickNextControl(page: any): Promise<void> {
  await page.evaluate(() => {
    // @ts-ignore — browser context evaluation provides DOM document
    const doc = (globalThis as any).document;
    const input = doc.querySelector('input[name="Command"][value="Next"], input[value="Next"]') as any;
    if (input) { input.click(); return; }
    const btn = Array.from(doc.querySelectorAll("button, input[type=submit]")).find(
      (x: any) => /next/i.test(x.textContent || x.value || "")
    ) as any;
    if (btn) btn.click();
  }).catch(() => null);
}

async function setInputValue(page: any, sel: string, val: string): Promise<void> {
  if (!val) return;
  await page.evaluate((args: { sel: string; val: string }) => {
    // @ts-ignore — browser context evaluation provides DOM document
    const doc = (globalThis as any).document;
    const target = doc.querySelector(args.sel) as any;
    if (!target) return;
    target.focus?.();
    target.value = args.val;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }, { sel, val }).catch(() => null);
}

/** POST a hidden form to /HomeWeb/Scheduler — used by OPT-1 fast-path and Step 5 week nav */
async function submitSchedulerForm(
  page: any,
  args: { office: string; calendarId: string; monday: string }
): Promise<void> {
  await page.evaluate((a: { office: string; calendarId: string; monday: string }) => {
    // @ts-ignore — browser context evaluation provides DOM document
    const doc = (globalThis as any).document;
    const form = doc.createElement('form');
    form.method = 'POST';
    form.action = '/HomeWeb/Scheduler';
    const add = (name: string, val: string) => {
      const input = doc.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = val;
      form.appendChild(input);
    };
    add('Language', 'en');
    add('Office', a.office);
    add('CalendarId', a.calendarId);
    add('PersonCount', '1');
    add('Monday', a.monday);
    add('Command', 'Next');
    doc.body.appendChild(form);
    form.submit();
  }, args);
}

async function getAttr(handle: any, name: string): Promise<string> {
  try {
    // ElementHandle.evaluate(fn, arg) exists in both Playwright and puppeteer
    return (await handle.evaluate((el: any, n: string) => el.getAttribute(n), name)) || "";
  } catch { return ""; }
}

export async function executePlaywrightFallback(
  browserBinding: any,
  client: DecryptedClientData,
  opts?: BrowserFallbackOptions
): Promise<BrowserFallbackResult> {
  const startTime = Date.now();
  // Billing clock: durationSeconds must exclude the mandatory 20s launch-
  // spacing wait inside throttleLaunch() (NFR-2 gate) — only real browser/
  // portal work counts against the daily budget (prod 2026-09-06/08/10: crashed
  // pairs billed ~20s doing zero browser work). workStartTime stays equal to
  // startTime until the throttle releases, so the pre-throttle "not configured"
  // throw below keeps its accurate near-zero measurement via the same variable.
  let workStartTime = startTime;
  let browser: any = null;
  let formSubmitted = false;
  let selectedSlot: string | undefined;
  let stageReached: BrowserFallbackResult["stageReached"] = "INIT";

  // Pre-flight check: Bachelor-only lock before any browser launch or throttling
  if (client.category !== "Bachelor" || client.calendarId !== CANONICAL_CALENDAR_ID) {
    return {
      success: false,
      durationSeconds: 0,
      errorMessage: `Pre-flight rejection: Only 'Bachelor' category and canonical calendar ID (${CANONICAL_CALENDAR_ID}) permitted. Got category="${client.category}", calendarId=${client.calendarId}`,
      classification: "VALIDATION_ERROR",
      stageReached: "INIT"
    };
  }

  try {
    if (!browserBinding) {
      throw new Error("Cloudflare MYBROWSER binding not configured.");
    }

    await throttleLaunch();
    workStartTime = Date.now();

    browser = await launchBrowser(browserBinding, opts?.launcher);
    const page = await browser.newPage();

    // Step tag (prod 2026-09-13: bounded 15s initial navigation. Tag the step so the audit row says
    // it. Original text stays verbatim so classifyLaunchError still sees
    // "timeout" → TRANSIENT_ERROR).
    try {
      await page.goto("https://appointment.bmeia.gv.at/", { waitUntil: "domcontentloaded", timeout: 15000 });
    } catch (gotoErr: any) {
      throw new Error("portal-home goto (initial navigation, 15s): " + (gotoErr?.message || gotoErr));
    }

    // Fast-path direct scheduler navigation (OPT-1):
    // The BMEIA WebForms portal accepts a direct POST to /HomeWeb/Scheduler with
    // Office=KAIRO, CalendarId, PersonCount=1, and target Monday to land directly
    // on the week grid, skipping steps 1 to 4 (saving ~8-12 seconds of sequential page loads).
    const targetMonday = opts?.startTime || calculateMondayString();
    let landedOnGrid = false;

    try {
      await submitSchedulerForm(page, { office: 'KAIRO', calendarId: String(CANONICAL_CALENDAR_ID), monday: targetMonday });

      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);

      const radios = await page.$$('input[type="radio"]').catch(() => []);
      const content = await page.content().catch(() => "");
      if (radios.length > 0 || content.includes("no appointments available")) {
        landedOnGrid = true;
      }
    } catch {
      landedOnGrid = false;
    }

    if (!landedOnGrid) {
      // Step 1: Office KAIRO
      const officeSel = await page.waitForSelector('select#Office', { timeout: 15000 }).catch(() => null);
      if (officeSel) {
        await page.select('select#Office', 'KAIRO').catch(() => null);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
          clickSubmitControl(page),
        ]);
      }

      // Step 2: CalendarId (enforce canonical Bachelor)
      const calSel = await page.waitForSelector('select#CalendarId', { timeout: 15000 }).catch(() => null);
      if (calSel) {
        await page.select('select#CalendarId', String(CANONICAL_CALENDAR_ID)).catch(() => null);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
          clickSubmitControl(page),
        ]);
      }

      // Step 3: PersonCount = 1
      const pcSel = await page.waitForSelector('select#PersonCount', { timeout: 10000 }).catch(() => null);
      if (pcSel) {
        await page.select('select#PersonCount', '1').catch(() => null);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
          clickSubmitControl(page),
        ]);
      }

      // Step 4: Info page — just Next
      if (await hasNextControl(page)) {
        const hasGrid = await page.$('input[type="radio"]').then(Boolean).catch(() => false);
        if (!hasGrid) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
            clickNextControl(page),
          ]);
        }
      }
    }

    // Step 5: Week grid — if target week (opts.startTime) is specified, ensure the page shows the target week
    if (opts?.startTime) {
      const currentRadios = await page.$$('input[type="radio"]');
      let hasTargetWeekRadio = false;
      for (const r of currentRadios) {
        const val = await getAttr(r, "value");
        if (val) {
          const slotDate = new Date(val);
          if (!Number.isNaN(slotDate.getTime()) && calculateMondayString(slotDate) === opts.startTime) {
            hasTargetWeekRadio = true;
            break;
          }
        }
      }

      // If the target week is not already displayed, navigate to it via POST inside the page context
      if (!hasTargetWeekRadio) {
        await submitSchedulerForm(page, { office: 'KAIRO', calendarId: String(CANONICAL_CALENDAR_ID), monday: opts.startTime });
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      }
    }

    // Select target slot: MUST provably match the requested target opportunity week
    const radios = await page.$$('input[type="radio"]');
    let targetRadio: any = null;

    if (radios.length > 0) {
      if (opts?.startTime) {
        // Strict verification: only accept a radio whose value date belongs to the target week
        for (const r of radios) {
          const val = await getAttr(r, "value");
          if (val) {
            const slotDate = new Date(val);
            if (!Number.isNaN(slotDate.getTime()) && calculateMondayString(slotDate) === opts.startTime) {
              targetRadio = r;
              selectedSlot = val;
              stageReached = "SLOT_SELECTION";
              break;
            }
          }
        }
      } else {
        // No specific week targeted (general dry-run / unit tests)
        targetRadio = radios[0];
        selectedSlot = await getAttr(targetRadio, "value") || undefined;
        if (targetRadio) stageReached = "SLOT_SELECTION";
      }
    }

    // Critical invariant: If a target week was requested but cannot be proven, NEVER select an arbitrary slot!
    if (opts?.startTime && !targetRadio) {
      const dur = (Date.now() - workStartTime) / 1000.0;
      const shot = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
      return {
        success: false,
        durationSeconds: dur,
        screenshotBase64: shot ? shot.toString("base64") : undefined,
        errorMessage: `Target week slot not found in scheduler grid for week ${opts.startTime} (slot gone or week mismatch)`,
        classification: "SLOT_GONE",
        stageReached: "SLOT_SELECTION",
        submitted: formSubmitted
      };
    }

    if (targetRadio) {
      await targetRadio.click().catch(() => null);
      if (await hasNextControl(page)) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
          clickNextControl(page),
        ]);
      }
    }

    // Wait for personal data form or verify slot status
    const lastNameInput = await page.waitForSelector('input#Lastname, input[name="Lastname"]', { timeout: 15000 }).catch(() => null);
    if (!lastNameInput) {
      const htmlBeforeForm = await page.content().catch(() => "");
      const dur = (Date.now() - workStartTime) / 1000.0;
      const shot = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
      if (htmlBeforeForm.includes("no appointments available")) {
        return {
          success: false,
          durationSeconds: dur,
          screenshotBase64: shot ? shot.toString("base64") : undefined,
          errorMessage: "No slots available on scheduler step (slot gone)",
          classification: "SLOT_GONE",
          stageReached: "SLOT_SELECTION",
          selectedSlot,
          submitted: formSubmitted
        };
      }
      return {
        success: false,
        durationSeconds: dur,
        screenshotBase64: shot ? shot.toString("base64") : undefined,
        errorMessage: "Failed to navigate to personal data form after slot selection",
        classification: "PORTAL_ERROR",
        stageReached: "SLOT_SELECTION",
        selectedSlot,
        submitted: formSubmitted
      };
    }

    stageReached = "FORM_FILL";

    // Step 6: Personal data — batch filled in a single page.evaluate() call (OPT-3)
    // Eliminates ~19 individual asynchronous CDP round-trips over the remote WebSocket.
    await page.evaluate((formData: Record<string, string>) => {
      // @ts-ignore — browser context evaluation provides DOM document
      const doc = (globalThis as any).document;
      const setVal = (sel: string, val: string) => {
        if (!val) return;
        const el = doc.querySelector(sel) as any;
        if (!el) return;
        el.focus?.();
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const setSelect = (sel: string, val: string) => {
        if (!val) return;
        const el = doc.querySelector(sel) as any;
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      setVal('input#Lastname, input[name="Lastname"]', formData.lastName);
      setVal('input#Firstname, input[name="Firstname"]', formData.firstName);
      setVal('input#DateOfBirth, input[name="DateOfBirth"]', formData.dob);
      setVal('input#TraveldocumentNumber, input[name="TraveldocumentNumber"]', formData.passportNumber);
      setSelect('select#Sex, select[name="Sex"]', formData.gender);
      setVal('input#Street, input[name="Street"]', formData.street);
      setVal('input#Postcode, input[name="Postcode"]', formData.postalCode);
      setVal('input#City, input[name="City"]', formData.city);
      setSelect('select#Country, select[name="Country"]', formData.countryOfBirth || "Egypt");
      setVal('input#Telephone, input[name="Telephone"]', formData.phone);
      setVal('input#Email, input[name="Email"]', formData.email);
      setVal('input#LastnameAtBirth, input[name="LastnameAtBirth"]', formData.familyNameAtBirth);
      setSelect('select#NationalityAtBirth, select[name="NationalityAtBirth"]', formData.nationalityAtBirth);
      setSelect('select#CountryOfBirth, select[name="CountryOfBirth"]', formData.countryOfBirth);
      setVal('input#PlaceOfBirth, input[name="PlaceOfBirth"]', formData.placeOfBirth);
      setSelect('select#NationalityForApplication, select[name="NationalityForApplication"]', formData.nationality);
      setVal('input#TraveldocumentDateOfIssue, input[name="TraveldocumentDateOfIssue"]', formData.passportIssueDate);
      setVal('input#TraveldocumentValidUntil, input[name="TraveldocumentValidUntil"]', formData.passportExpiry);
      setSelect('select#TraveldocumentIssuingAuthority, select[name="TraveldocumentIssuingAuthority"]', formData.passportIssuingCountry);

      const consent = doc.querySelector('input#DSGVOAccepted, input[name="DSGVOAccepted"]') as any;
      if (consent && !consent.checked) {
        consent.click();
      }
    }, {
      lastName: client.lastName,
      firstName: client.firstName,
      dob: formatDateForPortal(client.dob),
      passportNumber: client.passportNumber,
      gender: client.gender,
      street: client.street,
      postalCode: client.postalCode,
      city: client.city,
      countryOfBirth: client.countryOfBirth || "Egypt",
      phone: client.phone,
      email: client.email,
      familyNameAtBirth: client.familyNameAtBirth,
      nationalityAtBirth: client.nationalityAtBirth,
      placeOfBirth: client.placeOfBirth,
      nationality: client.nationality,
      passportIssueDate: formatDateForPortal(client.passportIssueDate),
      passportExpiry: formatDateForPortal(client.passportExpiry),
      passportIssuingCountry: client.passportIssuingCountry
    }).catch(() => null);

    // CAPTCHA: Captcha_CaptchaImage + CaptchaText (BDC_* hidden fields are auto-submitted)
    //  open-source local OCR (tesseract.js) — no API key, no polling, free per D3
    const captchaImg = await page.$('#Captcha_CaptchaImage, img[id*="Captcha"]');
    if (captchaImg) {
      // @ts-ignore — runs in browser context, document available there
      await page.waitForFunction(() => {
        // @ts-ignore
        const img = document.querySelector('#Captcha_CaptchaImage') as HTMLImageElement;
        return img && img.complete && img.naturalWidth > 0;
      }).catch(() => null);

      let code: string | null = null;

      // Primary: SOUND channel — clean isolated speech beats distorted-image OCR on first attempts.
      //  BotDetect exposes get=sound on the same handler URL; fetch in page context keeps session cookies
      try {
        const imgSrc = await captchaImg.evaluate((el: any) => (el as any).src);
        if (imgSrc && /BotDetect/i.test(imgSrc)) {
          const soundUrl = imgSrc.replace(/get=\w+/, 'get=sound');
          const wavB64 = await page.evaluate(async (u: string) => {
            // @ts-ignore — browser context fetch, credentials/HTMLImageElement not in workers lib
            const r = await fetch(u, { credentials: 'include' });
            const buf = await r.arrayBuffer();
            let bin = '';
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(bin);
          }, soundUrl).catch(() => null);
          if (wavB64) {
            const bytes = new Uint8Array(atob(wavB64).length);
            const bin2 = atob(wavB64);
            for (let i = 0; i < bin2.length; i++) bytes[i] = bin2.charCodeAt(i);
            code = await solveCaptchaAudio(bytes, opts?.ai).catch(() => null);
          }
        }
      } catch { }

      // Fallback: image screenshot -> vision model -> tesseract
      if (!code) {
        let imgBase64: string | null = null;
        try {
          const buf = await captchaImg.screenshot({ type: "png" }).catch(() => null);
          if (buf) imgBase64 = buf.toString("base64");
        } catch { }
        if (!imgBase64) {
          const full = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
          if (full) imgBase64 = full.toString("base64");
        }
        if (imgBase64) {
          try {
            code = await solveCaptcha(imgBase64, opts?.ai);
          } catch (e: any) {
            const dur = (Date.now() - workStartTime) / 1000.0;
            const shot = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
            return {
              success: false,
              durationSeconds: dur,
              screenshotBase64: shot ? shot.toString("base64") : undefined,
              errorMessage: `CAPTCHA solve failed: ${e.message}`,
              classification: "CAPTCHA_ERROR",
              stageReached: "CAPTCHA",
              selectedSlot,
              submitted: formSubmitted
            };
          }
        }
      }
      if (code) {
        await setInputValue(page, 'input#CaptchaText, input[name="CaptchaText"]', code);
        // Verify captcha value was actually set (setInputValue silently swallows element-not-found)
        const filled = await page.evaluate(() => {
          // @ts-ignore — browser context evaluation provides DOM document
          const el = (globalThis as any).document.querySelector('input#CaptchaText, input[name="CaptchaText"]');
          return el?.value || "";
        }).catch(() => "");
        if (!filled) console.warn("[CAPTCHA] CaptchaText field not found or value not set — captcha submission may fail");
      }
    }

    // Submit Step 6 form
    const submitBtn = await page.$('input#nextButton, input[name="Command"][value="Next"], input[name="Command"][value="Save"], input[value="Save"], button[type="submit"]');
    if (submitBtn) {
      formSubmitted = true;
      stageReached = "SUBMITTED";
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
        submitBtn.click().catch(() => null),
      ]);
    }

    // Step 7 confirmation screen (if Save/Confirm button exists)
    const confirmBtn = await page.$('input[value="Save"], input[value="Confirm"], input[name="Command"][value="Save"], input[name="Command"][value="Confirm"]');
    if (confirmBtn) {
      formSubmitted = true;
      stageReached = "SUBMITTED";
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
        confirmBtn.click().catch(() => null),
      ]);
    }

    const durationSec = (Date.now() - workStartTime) / 1000.0;
    const content = await page.content().catch(() => "");
    const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
    const screenshotBase64 = screenshotBuffer ? screenshotBuffer.toString("base64") : undefined;

    // Only success if GESX reference found
    const ref = parseBookingConfirmationReference(content);
    if (ref) {
      return {
        success: true,
        durationSeconds: durationSec,
        screenshotBase64,
        referenceId: ref,
        selectedSlot,
        stageReached: "CONFIRMED",
        submitted: formSubmitted
      };
    }

    // Check for captcha error on response
    if (content.toLowerCase().includes("captcha") && /incorrect|invalid|error|wrong|does not match|mismatch/i.test(content)) {
      return {
        success: false,
        durationSeconds: durationSec,
        screenshotBase64,
        errorMessage: "CAPTCHA challenge failed or incorrect (no GESX ref)",
        classification: "CAPTCHA_ERROR",
        stageReached: "CAPTCHA",
        selectedSlot,
        submitted: formSubmitted
      };
    }

    if (content.includes("no appointments available")) {
      return {
        success: false,
        durationSeconds: durationSec,
        screenshotBase64,
        errorMessage: "No slots available after submission (slot gone)",
        classification: "SLOT_GONE",
        stageReached,
        selectedSlot,
        submitted: formSubmitted
      };
    }

    const errMatch = content.match(/<p class="message-error"[^>]*>([\s\S]*?)<\/p>/i);
    if (errMatch && !errMatch[1].includes("Please choose an appointment")) {
      const errText = errMatch[1].replace(/<[^>]+>/g, "").trim();
      return {
        success: false,
        durationSeconds: durationSec,
        screenshotBase64,
        errorMessage: `Portal error: ${errText}`,
        classification: "PORTAL_ERROR",
        stageReached,
        selectedSlot,
        submitted: formSubmitted
      };
    }

    return {
      success: false,
      durationSeconds: durationSec,
      screenshotBase64,
      errorMessage: "Booking confirmation reference GESX-... not found after submit",
      classification: "SUBMISSION_ERROR",
      stageReached,
      selectedSlot,
      submitted: formSubmitted
    };
  } catch (error: any) {
    const msg = error?.message || "Playwright browser session failed";
    return {
      success: false,
      durationSeconds: (Date.now() - workStartTime) / 1000.0,
      errorMessage: msg,
      classification: classifyLaunchError(msg),
      stageReached,
      selectedSlot,
      submitted: formSubmitted
    };
  } finally {
    //  launch-crash cleanup limit (prod 2026-09-10): `browser` is only
    // assigned AFTER launchBrowser() resolves, so an exception thrown
    // before that (e.g. fs.mkdtemp inside connectOverCDP) leaves `browser`
    // null here — yet the remote side may ALREADY have allocated a session,
    // because launch() calls acquire() (HTTP /v1/acquire) BEFORE the local
    // crash site. There is no sessionId/handle to close without `browser`,
    // and blindly closing all sessions could kill other jobs' browsers, so
    // explicit release is structurally impossible from this path. Compensating
    // protection instead: such failures classify as LAUNCH_ERROR, which
    // decideRetryAction() never same-tick retries — the orphaned session
    // expires via Cloudflare's idle timeout and no second acquire lands
    // inside the 20s new-instance window. throttleLaunch()'s slot is
    // intentionally still consumed: the remote acquire likely happened.
    if (browser) {
      try { await browser.close(); } catch (closeErr) { console.warn("Failed to close browser session cleanly:", closeErr); }
    }
  }
}
