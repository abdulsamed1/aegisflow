/**
 * CAPTCHA solver — open-source local OCR (tesseract.js) for BotDetect.
 * Portal uses Captcha_CaptchaImage (250x50) + CaptchaText + 4 BDC_* hidden fields.
 * Challenge is 4-char alphanumeric, dynamic per session (e.g. C65P).
 * Replaces paid 2Captcha (CAPTCHA_API_KEY) — D3 "free first" — with local Apache 2.0 OCR.
 * ponytail: tesseract.js is the standard open-source fit; no polling, no external API, 1-2s solve.
 */

export function isCaptchaError(html: string): boolean {
  if (!html || typeof html !== "string") return false;
  return /captcha/i.test(html) && /incorrect|invalid|error|wrong/i.test(html);
}

// Lightweight in-memory worker reuse — ponytail: one worker per isolate
let cachedWorker: any = null;
let workerInit: Promise<any> | null = null;

async function getWorker(): Promise<any> {
  if (cachedWorker) return cachedWorker;
  if (workerInit) return workerInit;
  // dynamic import keeps tesseract.js out of cold-start when not used (e.g., GET /api/status)
  workerInit = (async () => {
    const { createWorker } = await import("tesseract.js");
    // PSM 8 = single word (4-char code), whitelist alphanumeric only
    const worker: any = await createWorker("eng", 1, {
      // Use CDN for lang data to avoid bundling 2MB traineddata
      langPath: "https://tessdata.projectnaptha.com/4.0.0",
      // Reduce overhead: cache in memory, no logger
      logger: undefined,
    });
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      tessedit_pageseg_mode: "8", // single word
      // BotDetect is uppercase alphanumeric, no lowercase
      classify_bln_numeric_mode: "1",
    });
    cachedWorker = worker;
    return worker;
  })();
  return workerInit;
}

/**
 * Solve CAPTCHA from base64 image (data URI or raw). Returns 4-char code.
 * apiKey param kept for backward compat but ignored — open-source path needs no key.
 * Workers AI alternative: if env.AI is passed via global, could use llava; tesseract is preferred offline.
 */
export async function solveCaptcha(
  imageBase64: string,
  _apiKey?: string,
  _timeoutMs = 60000
): Promise<string> {
  const clean = imageBase64.replace(/^data:image\/[^;]+;base64,/, "").trim();
  if (!clean) throw new Error("Empty CAPTCHA image");

  // Build data URI for tesseract.js (it accepts Buffer, data URI, or base64)
  const dataUri = `data:image/png;base64,${clean}`;

  const worker = await getWorker();
  const { data } = await worker.recognize(dataUri);
  // Clean: keep only A-Z0-9, uppercase, trim, take first 4-6 chars
  const raw = String(data.text || "").toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
  // BotDetect is 4-char; take 4, fallback to raw if longer
  const code = raw.slice(0, 4);
  if (!code || code.length < 3) throw new Error(`tesseract low confidence: raw="${data.text}" cleaned="${raw}"`);
  return code;
}

// For tests: allow terminate
export async function terminateCaptchaWorker(): Promise<void> {
  if (cachedWorker) {
    try { await cachedWorker.terminate(); } catch {}
    cachedWorker = null;
    workerInit = null;
  }
}
