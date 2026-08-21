import { DecryptedClientData, formatDateForPortal, parseBookingConfirmationReference } from "./booking-http";
import { solveCaptcha } from "./captcha";

export interface BrowserFallbackResult {
  success: boolean;
  durationSeconds: number;
  screenshotBase64?: string;
  referenceId?: string;
  errorMessage?: string;
}

// ponytail: 20s throttle between browser launches (NFR-2) — module-level gate
let lastLaunchAt = 0;
async function throttleLaunch(): Promise<void> {
  const wait = Math.max(0, 20000 - (Date.now() - lastLaunchAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLaunchAt = Date.now();
}

export async function executePlaywrightFallback(
  browserBinding: any,
  client: DecryptedClientData,
  opts?: { startTime?: string; captchaApiKey?: string }
): Promise<BrowserFallbackResult> {
  const startTime = Date.now();
  let browser: any = null;

  try {
    if (!browserBinding) {
      throw new Error("Cloudflare MYBROWSER binding not configured.");
    }

    await throttleLaunch();

    const playwrightModule = await import("@cloudflare/playwright");
    const playwright = playwrightModule.default || playwrightModule;

    browser = await playwright.launch(browserBinding);
    const page = await browser.newPage();

    await page.goto("https://appointment.bmeia.gv.at/", { waitUntil: "domcontentloaded", timeout: 30000 });

    // Step 1: Office KAIRO
    const officeSel = await page.$('select#Office');
    if (officeSel) {
      await page.selectOption('select#Office', 'KAIRO').catch(() => null);
      await page.click('input[type="submit"], button[type="submit"], input[value="Next"]').catch(() => null);
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
    }

    // Step 2: CalendarId
    const calSel = await page.$('select#CalendarId');
    if (calSel) {
      await page.selectOption('select#CalendarId', String(client.calendarId)).catch(() => null);
      await page.click('input[type="submit"], button[type="submit"], input[value="Next"]').catch(() => null);
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
    }

    // Step 3: PersonCount = 1
    const pcSel = await page.$('select#PersonCount');
    if (pcSel) {
      await page.selectOption('select#PersonCount', '1').catch(() => null);
      await page.click('input[type="submit"], button[type="submit"], input[value="Next"]').catch(() => null);
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
    }

    // Step 4: Info page — just Next
    // If page contains info text and a Next button, click it
    const nextBtn = await page.$('input[value="Next"], button:has-text("Next")');
    if (nextBtn) {
      const hasGrid = await page.$('input[type="radio"]').then(Boolean);
      if (!hasGrid) {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null),
          nextBtn.click().catch(() => null),
        ]);
      }
    }

    // Step 5: Week grid — select first available radio slot
    // London evidence: radios for 10:00, 10:30 etc. under Wed header
    // If opts.startTime provided, try to match that day/time; else first radio
    let slotSelected = false;
    const radios = await page.$$('input[type="radio"]');
    if (radios.length > 0) {
      // Prefer radio matching startTime if given
      let target = radios[0];
      if (opts?.startTime) {
        // Try to find radio whose label contains the date
        for (const r of radios) {
          const label = await page.evaluate((el: any) => {
            // @ts-ignore — runs in browser context
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            return lbl ? (lbl as any).textContent : "";
          }, r).catch(() => "");
          if (label && opts.startTime && label.includes(opts.startTime.split(" ")[0])) {
            target = r;
            break;
          }
        }
      }
      await target.check().catch(() => target.click().catch(() => null));
      slotSelected = true;
      const gridNext = await page.$('input[value="Next"], button:has-text("Next")');
      if (gridNext) {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null),
          gridNext.click().catch(() => null),
        ]);
      }
    }

    // If no grid/radios, we may already be on personal data or no slots
    // Check for "no appointments available" — abort as failure (slot gone)
    const htmlBeforeForm = await page.content().catch(() => "");
    if (htmlBeforeForm.includes("no appointments available") || htmlBeforeForm.includes("message-error")) {
      const dur = (Date.now() - startTime) / 1000.0;
      const shot = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
      return { success: false, durationSeconds: dur, screenshotBase64: shot ? shot.toString("base64") : undefined, errorMessage: "No slots available on personal data step (slot gone)" };
    }

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
      // Screenshot the captcha image element specifically if possible
      let imgBase64: string | null = null;
      try {
        const buf = await captchaImg.screenshot({ type: "png" }).catch(() => null);
        if (buf) imgBase64 = buf.toString("base64");
      } catch {}
      if (!imgBase64) {
        // Fallback: full page screenshot — solver can still attempt
        const full = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
        if (full) imgBase64 = full.toString("base64");
      }
      if (imgBase64) {
        try {
          const code = await solveCaptcha(imgBase64);
          await fill('input#CaptchaText, input[name="CaptchaText"]', code);
        } catch (e: any) {
          const dur = (Date.now() - startTime) / 1000.0;
          const shot = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
          return { success: false, durationSeconds: dur, screenshotBase64: shot ? shot.toString("base64") : undefined, errorMessage: `CAPTCHA solve failed: ${e.message}` };
        }
      }
    }

    // Submit
    const submitBtn = await page.$('input[value="Next"], input[value="Save"], button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null),
        submitBtn.click().catch(() => null),
      ]);
    }

    const durationSec = (Date.now() - startTime) / 1000.0;
    const content = await page.content().catch(() => "");
    const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
    const screenshotBase64 = screenshotBuffer ? screenshotBuffer.toString("base64") : undefined;

    // Only success if GESX reference found
    const ref = parseBookingConfirmationReference(content);
    if (ref) {
      return { success: true, durationSeconds: durationSec, screenshotBase64, referenceId: ref };
    }

    // Check for captcha error on response
    if (content.toLowerCase().includes("captcha")) {
      return { success: false, durationSeconds: durationSec, screenshotBase64, errorMessage: "CAPTCHA challenge failed or incorrect (no GESX ref)" };
    }

    return { success: false, durationSeconds: durationSec, screenshotBase64, errorMessage: "Booking confirmation reference GESX-... not found after submit" };
  } catch (error: any) {
    return {
      success: false,
      durationSeconds: (Date.now() - startTime) / 1000.0,
      errorMessage: error.message || "Playwright browser session failed",
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (closeErr) { console.warn("Failed to close browser session cleanly:", closeErr); }
    }
  }
}
