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

    // Live booking is disabled until the booking path is verified at first slot capture (G0).
    // Returning success here would be a silent no-op; fail loudly instead.
    return {
      success: false,
      durationSeconds,
      isDryRun: false,
      errorMessage: "Booking path UNVERIFIED (portal-automation-spec section 6): Playwright live booking disabled"
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
