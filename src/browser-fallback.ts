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

// ponytail: 20s sequential FIFO queue between browser launches (NFR-2) — module-level gate
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

export async function executePlaywrightFallback(
  browserBinding: any,
  client: DecryptedClientData,
  opts?: { startTime?: string; captchaApiKey?: string; ai?: any }
): Promise<BrowserFallbackResult> {
  const startTime = Date.now();
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

    const playwrightModule = await import("@cloudflare/playwright").catch(() => null);
    const playwright = playwrightModule?.default || playwrightModule;

    if (playwright && typeof playwright.launch === "function") {
      browser = await playwright.launch(browserBinding);
    } else if (browserBinding && typeof browserBinding.launch === "function") {
      browser = await browserBinding.launch();
    } else if (browserBinding && typeof browserBinding.newPage === "function") {
      browser = browserBinding;
    } else {
      throw new Error("Neither @cloudflare/playwright nor compatible browserBinding available");
    }
    const page = await browser.newPage();

    await page.goto("https://appointment.bmeia.gv.at/", { waitUntil: "domcontentloaded", timeout: 30000 });

    // Step 1: Office KAIRO
    const officeSel = await page.waitForSelector('select#Office', { timeout: 15000 }).catch(() => null);
    if (officeSel) {
      await page.selectOption('select#Office', 'KAIRO').catch(() => null);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
        page.click('input[type="submit"], button[type="submit"], input[value="Next"]').catch(() => null),
      ]);
    }

    // Step 2: CalendarId (enforce canonical Bachelor)
    const calSel = await page.waitForSelector('select#CalendarId', { timeout: 15000 }).catch(() => null);
    if (calSel) {
      await page.selectOption('select#CalendarId', String(CANONICAL_CALENDAR_ID)).catch(() => null);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
        page.click('input[type="submit"], button[type="submit"], input[value="Next"]').catch(() => null),
      ]);
    }

    // Step 3: PersonCount = 1
    const pcSel = await page.waitForSelector('select#PersonCount', { timeout: 10000 }).catch(() => null);
    if (pcSel) {
      await page.selectOption('select#PersonCount', '1').catch(() => null);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
        page.click('input[type="submit"], button[type="submit"], input[value="Next"]').catch(() => null),
      ]);
    }

    // Step 4: Info page — just Next
    const nextBtn = await page.$('input[value="Next"], button:has-text("Next")');
    if (nextBtn) {
      const hasGrid = await page.$('input[type="radio"]').then(Boolean);
      if (!hasGrid) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
          nextBtn.click().catch(() => null),
        ]);
      }
    }

    // Step 5: Week grid — if target week (opts.startTime) is specified, ensure the page shows the target week
    if (opts?.startTime) {
      const currentRadios = await page.$$('input[type="radio"]');
      let hasTargetWeekRadio = false;
      for (const r of currentRadios) {
        const val = await r.getAttribute("value").catch(() => "");
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
        await page.evaluate((args: { office: string; calendarId: string; monday: string }) => {
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
          add('Office', args.office);
          add('CalendarId', args.calendarId);
          add('PersonCount', '1');
          add('Monday', args.monday);
          add('Command', 'Next');
          doc.body.appendChild(form);
          form.submit();
        }, { office: 'KAIRO', calendarId: String(CANONICAL_CALENDAR_ID), monday: opts.startTime });
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
      }
    }

    // Select target slot: MUST provably match the requested target opportunity week
    const radios = await page.$$('input[type="radio"]');
    let targetRadio: any = null;

    if (radios.length > 0) {
      if (opts?.startTime) {
        // Strict verification: only accept a radio whose value date belongs to the target week
        for (const r of radios) {
          const val = await r.getAttribute("value").catch(() => "");
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
        selectedSlot = await targetRadio?.getAttribute("value").catch(() => undefined);
        if (targetRadio) stageReached = "SLOT_SELECTION";
      }
    }

    // Critical invariant: If a target week was requested but cannot be proven, NEVER select an arbitrary slot!
    if (opts?.startTime && !targetRadio) {
      const dur = (Date.now() - startTime) / 1000.0;
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
      await targetRadio.check().catch(() => targetRadio.click().catch(() => null));
      const gridNext = await page.$('input[name="Command"][value="Next"], input[value="Next"], button:has-text("Next")');
      if (gridNext) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
          gridNext.click().catch(() => null),
        ]);
      }
    }

    // Wait for personal data form or verify slot status
    const lastNameInput = await page.waitForSelector('input#Lastname, input[name="Lastname"]', { timeout: 15000 }).catch(() => null);
    if (!lastNameInput) {
      const htmlBeforeForm = await page.content().catch(() => "");
      const dur = (Date.now() - startTime) / 1000.0;
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

    // Step 6: Personal data — fill using REAL portal names (London evidence, 31 fields)
    // ponytail: helper to fill if element exists, ignore if not
    const fill = async (sel: string, val: string) => {
      const el = await page.$(sel);
      if (el && val) await page.fill(sel, val).catch(() => null);
    };
    const select = async (sel: string, val: string) => {
      const el = await page.$(sel);
      if (el && val) await page.selectOption(sel, val).catch(() => page.fill(sel, val).catch(() => null));
    };

    await fill('input#Lastname, input[name="Lastname"]', client.lastName);
    await fill('input#Firstname, input[name="Firstname"]', client.firstName);
    await fill('input#DateOfBirth, input[name="DateOfBirth"]', formatDateForPortal(client.dob));
    await fill('input#TraveldocumentNumber, input[name="TraveldocumentNumber"]', client.passportNumber);
    await select('select#Sex, select[name="Sex"]', client.gender);
    await fill('input#Street, input[name="Street"]', client.street);
    await fill('input#Postcode, input[name="Postcode"]', client.postalCode);
    await fill('input#City, input[name="City"]', client.city);
    await select('select#Country, select[name="Country"]', client.countryOfBirth || "Egypt");
    await fill('input#Telephone, input[name="Telephone"]', client.phone);
    await fill('input#Email, input[name="Email"]', client.email);
    await fill('input#LastnameAtBirth, input[name="LastnameAtBirth"]', client.familyNameAtBirth);
    await select('select#NationalityAtBirth, select[name="NationalityAtBirth"]', client.nationalityAtBirth);
    await select('select#CountryOfBirth, select[name="CountryOfBirth"]', client.countryOfBirth);
    await fill('input#PlaceOfBirth, input[name="PlaceOfBirth"]', client.placeOfBirth);
    await select('select#NationalityForApplication, select[name="NationalityForApplication"]', client.nationality);
    await fill('input#TraveldocumentDateOfIssue, input[name="TraveldocumentDateOfIssue"]', formatDateForPortal(client.passportIssueDate));
    await fill('input#TraveldocumentValidUntil, input[name="TraveldocumentValidUntil"]', formatDateForPortal(client.passportExpiry));
    await select('select#TraveldocumentIssuingAuthority, select[name="TraveldocumentIssuingAuthority"]', client.passportIssuingCountry);

    // GDPR consent
    const consent = await page.$('input#DSGVOAccepted, input[name="DSGVOAccepted"]');
    if (consent) await consent.check().catch(() => null);

    // CAPTCHA: Captcha_CaptchaImage + CaptchaText (BDC_* hidden fields are auto-submitted)
    // ponytail: open-source local OCR (tesseract.js) — no API key, no polling, free per D3
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
      // ponytail: BotDetect exposes get=sound on the same handler URL; fetch in page context keeps session cookies
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
      } catch {}

      // Fallback: image screenshot -> vision model -> tesseract
      if (!code) {
        let imgBase64: string | null = null;
        try {
          const buf = await captchaImg.screenshot({ type: "png" }).catch(() => null);
          if (buf) imgBase64 = buf.toString("base64");
        } catch {}
        if (!imgBase64) {
          const full = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
          if (full) imgBase64 = full.toString("base64");
        }
        if (imgBase64) {
          try {
            code = await solveCaptcha(imgBase64, opts?.ai);
          } catch (e: any) {
            const dur = (Date.now() - startTime) / 1000.0;
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
        await fill('input#CaptchaText, input[name="CaptchaText"]', code);
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

    const durationSec = (Date.now() - startTime) / 1000.0;
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
    const isTransient = /timeout|network|ECONNRESET|ECONNREFUSED|socket|Navigation failed/i.test(msg);
    return {
      success: false,
      durationSeconds: (Date.now() - startTime) / 1000.0,
      errorMessage: msg,
      classification: isTransient ? "TRANSIENT_ERROR" : "UNKNOWN",
      stageReached,
      selectedSlot,
      submitted: formSubmitted
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (closeErr) { console.warn("Failed to close browser session cleanly:", closeErr); }
    }
  }
}
