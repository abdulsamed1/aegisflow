import { DecryptedClientData } from "./booking-http";

export interface BrowserFallbackResult {
  success: boolean;
  durationSeconds: number;
  isDryRun: boolean;
  screenshotBase64?: string;
  errorMessage?: string;
}

export async function executePlaywrightFallback(
  browserBinding: any,
  client: DecryptedClientData,
  isDryRun: boolean = true
): Promise<BrowserFallbackResult> {
  const startTime = Date.now();
  let browser: any = null;

  try {
    if (!browserBinding) {
      throw new Error("Cloudflare MYBROWSER binding not configured.");
    }

    const playwrightModule = await import("@cloudflare/playwright");
    const playwright = playwrightModule.default || playwrightModule;

    browser = await playwright.launch(browserBinding);
    const page = await browser.newPage();

    await page.goto("https://appointment.bmeia.gv.at/", { waitUntil: "domcontentloaded", timeout: 30000 });

    const durationSeconds = (Date.now() - startTime) / 1000.0;

    if (isDryRun) {
      const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 60 });
      const screenshotBase64 = screenshotBuffer.toString("base64");

      console.log(`[PLAYWRIGHT DRY-RUN] Portal reached and captured in ${durationSeconds.toFixed(2)}s. Halted prior to submit.`);

      return {
        success: true,
        durationSeconds,
        isDryRun: true,
        screenshotBase64
      };
    }

    // Live Playwright Submission
    await page.fill('input[name="LastName"]', client.lastName);
    await page.fill('input[name="FirstName"]', client.firstName);
    await page.fill('input[name="PassportNumber"]', client.passportNumber);
    await page.fill('input[name="Email"]', client.email);
    await page.fill('input[name="Phone"]', client.phone);

    // Check GDPR consent if available
    const consentCheckbox = await page.$('input[name="Consent"]');
    if (consentCheckbox) {
      await consentCheckbox.check();
    }

    // Submit form
    const submitButton = await page.$('button[type="submit"], input[type="submit"]');
    if (submitButton) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
        submitButton.click()
      ]);
    }

    const durationSec = (Date.now() - startTime) / 1000.0;
    const content = await page.content();
    const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
    const screenshotBase64 = screenshotBuffer ? screenshotBuffer.toString("base64") : undefined;

    return {
      success: true,
      durationSeconds: durationSec,
      isDryRun: false,
      screenshotBase64
    };
  } catch (error: any) {
    return {
      success: false,
      durationSeconds: (Date.now() - startTime) / 1000.0,
      isDryRun,
      errorMessage: error.message || "Playwright browser session failed"
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.warn("Failed to close browser session cleanly:", closeErr);
      }
    }
  }
}
