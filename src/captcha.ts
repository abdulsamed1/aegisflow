/**
 * CAPTCHA solver — Cloudflare Workers AI Vision (open-source Llama 3.2 Vision) primary, tesseract.js fallback.
 * Portal uses Captcha_CaptchaImage (250x50) + CaptchaText + 4 BDC_* hidden fields.
 * Challenge is 4-char alphanumeric, dynamic per session (e.g. C65P).
 *
 * Strategy:
 *   1. Workers AI @cf/meta/llama-3.2-11b-vision-instruct (open-source Meta Vision, free on Cloudflare)
 *   2. Workers AI REST API (CF_API_TOKEN + CF_ACCOUNT_ID) for local tests/dev
 *   3. Tesseract.js local OCR as offline fallback
 */

export function isCaptchaError(html: string): boolean {
  if (!html || typeof html !== "string") return false;
  return /captcha/i.test(html) && /incorrect|invalid|error|wrong|does not match|mismatch/i.test(html);
}

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; // ponytail: 90b not available on Free; verified via /ai/models/search — only 11b + llava exist

/**
 * Clean model output to extract the 4-char code
 */
function cleanModelResponse(rawText: string): string {
  const cleaned = rawText
    .replace(/\*\*Answer:\*\*/i, "")
    .replace(/Answer:/i, "")
    .replace(/The characters (are|shown):?/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();

  // BotDetect can be 4, 5, or 6 characters on BMEIA
  return cleaned.slice(0, 6);
}

/**
 * Solve CAPTCHA using Cloudflare Workers AI binding (production runtime).
 */
async function solveWithWorkersAI(ai: any, imageBytes: Uint8Array): Promise<string> {
  const response = await ai.run(VISION_MODEL, {
    image: Array.from(imageBytes),
    prompt: "Return only the exact alphanumeric characters shown in this distorted CAPTCHA image. There are typically 4 to 6 characters. Output only the characters in uppercase with no spaces, punctuation, or other words.",
    max_tokens: 15,
  });

  const raw = String(response?.response || response?.description || response || "");
  const code = cleanModelResponse(raw);
  if (!code || code.length < 3) {
    throw new Error(`Workers AI low confidence: raw="${raw}" cleaned="${code}"`);
  }
  return code;
}

/**
 * Solve CAPTCHA using Cloudflare Workers AI REST API (for local CLI/tests).
 */
async function solveWithWorkersAIRest(imageBase64: string): Promise<string> {
  const envObj = (globalThis as any).process?.env || {};
  const accountId = envObj.CF_ACCOUNT_ID;
  const apiToken = envObj.CF_API_TOKEN || envObj.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CF_ACCOUNT_ID and CF_API_TOKEN required for local Workers AI");
  }

  // Convert base64 to byte array using standard atob
  const binaryStr = atob(imageBase64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${VISION_MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image: Array.from(bytes),
        prompt: "Return only the exact alphanumeric characters shown in this distorted CAPTCHA image. There are typically 4 to 6 characters. Output only the characters in uppercase with no spaces, punctuation, or other words.",
        max_tokens: 15,
      }),
    }
  );

  const json = await response.json() as any;
  const raw = String(json?.result?.response || json?.result?.description || "");
  const code = cleanModelResponse(raw);
  if (!code || code.length < 3) {
    throw new Error(`Workers AI REST low confidence: raw="${raw}" cleaned="${code}"`);
  }
  return code;
}

// Lightweight in-memory worker reuse for offline fallback
let cachedWorker: any = null;
let workerInit: Promise<any> | null = null;

async function getWorker(): Promise<any> {
  if (cachedWorker) return cachedWorker;
  if (workerInit) return workerInit;
  workerInit = (async () => {
    const { createWorker } = await import("tesseract.js");
    const worker: any = await createWorker("eng", 1, {
      langPath: "https://tessdata.projectnaptha.com/4.0.0",
      logger: () => {},
    });
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      tessedit_pageseg_mode: "7",
      classify_bln_numeric_mode: "1",
    });
    cachedWorker = worker;
    return worker;
  })();
  return workerInit;
}

async function solveWithTesseract(imageBase64: string): Promise<string> {
  const dataUri = `data:image/png;base64,${imageBase64}`;
  const worker = await getWorker();
  const { data } = await worker.recognize(dataUri);
  const raw = String(data.text || "").toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
  const code = raw.slice(0, 4);
  if (!code || code.length < 2) {
    throw new Error(`tesseract low confidence: raw="${data.text}" cleaned="${raw}"`);
  }
  return code;
}

/**
 * Parse raw Whisper transcription of a BotDetect sound challenge into the code.
 * Whisper emits spoken characters with separators ("T, D, R, 5, 8.") and sometimes
 * hallucinates repeats — collapse consecutive duplicates, then accept 4-6 char results.
 */
export function parseAudioTranscription(rawText: string): string {
  const tokens = String(rawText).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  // collapse immediate repeats ("9 4 3 2 3 2" style stutter or double-speak)
  const collapsed: string[] = [];
  for (const t of tokens) {
    if (collapsed[collapsed.length - 1] !== t) collapsed.push(t);
  }
  let code = collapsed.join("");
  if (code.length > 6) code = code.slice(0, 6);
  return code;
}

/**
 * Solve CAPTCHA from the BotDetect SOUND challenge (WAV bytes).
 * Audio is clean isolated speech — far higher first-attempt accuracy than distorted-image OCR.
 * Resolution order: Workers AI binding (whisper) -> REST -> error (caller falls back to image solver).
 */
export async function solveCaptchaAudio(
  wavBytes: Uint8Array,
  ai?: any
): Promise<string> {
  if (!wavBytes || wavBytes.length === 0) throw new Error("Empty CAPTCHA audio");

  async function run(model: string): Promise<string> {
    let raw = "";
    if (ai) {
      const res: any = await ai.run(model, { audio: wavBytes });
      raw = String(res?.text || "");
    } else {
      const envObj = (globalThis as any).process?.env || {};
      const accountId = envObj.CF_ACCOUNT_ID;
      const apiToken = envObj.CF_API_TOKEN || envObj.CLOUDFLARE_API_TOKEN;
      if (!accountId || !apiToken) throw new Error("CF_ACCOUNT_ID and CF_API_TOKEN required for local Workers AI");
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
        { method: "POST", headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "audio/wav" }, body: wavBytes as any }
      );
      const json: any = await response.json();
      raw = String(json?.result?.text || "");
      if (!raw) throw new Error(json?.errors?.[0]?.message || "empty whisper result");
    }
    const code = parseAudioTranscription(raw);
    if (!code || code.length < 3) throw new Error(`whisper low confidence: raw="${raw}"`);
    return code;
  }

  // ponytail: parallel whisper execution when ai binding present — eliminates sequential fallback latency gap
  const t0 = Date.now();
  try {
    if (ai) {
      const [tinySettled, turboSettled] = await Promise.allSettled([
        run("@cf/openai/whisper-tiny-en"),
        run("@cf/openai/whisper-large-v3-turbo")
      ]);
      const tinyCode = tinySettled.status === "fulfilled" ? tinySettled.value : "";
      const turboCode = turboSettled.status === "fulfilled" ? turboSettled.value : "";

      let chosen = "";
      let model = "";
      if (tinyCode.length >= 4 && tinyCode.length <= 5) {
        chosen = tinyCode;
        model = "whisper-tiny-en";
      } else if (turboCode.length >= 4 && turboCode.length <= 5) {
        chosen = turboCode;
        model = "whisper-large-v3-turbo";
      } else if (tinyCode || turboCode) {
        chosen = (tinyCode && turboCode) ? (tinyCode.length > turboCode.length ? turboCode : tinyCode) : (tinyCode || turboCode);
        model = chosen === turboCode ? "whisper-large-v3-turbo" : "whisper-tiny-en";
      }

      if (!chosen || chosen.length < 3) {
        const err = tinySettled.status === "rejected" ? tinySettled.reason?.message : (turboSettled.status === "rejected" ? turboSettled.reason?.message : "transcription failed");
        throw new Error(`Whisper audio transcription failed: ${err}`);
      }
      console.log(`[CAPTCHA Audio] Solved code="${chosen}" via ${model} in ${Date.now() - t0}ms`);
      return chosen;
    }

    const code = await run("@cf/openai/whisper-tiny-en");
    if (code.length >= 4 && code.length <= 5) return code;
    const refined = await run("@cf/openai/whisper-large-v3-turbo");
    if (refined.length >= 4 && refined.length <= 5) return refined;
    return code.length > refined.length ? refined : code;
  } catch (e: any) {
    if (!ai) throw e;
    console.warn(`whisper binding failed (${Date.now() - t0}ms): ${e.message}, falling back`);
    throw e;
  }
}

/**
 * Solve CAPTCHA from base64 image (data URI or raw). Returns 4-char code.
 *
 * Resolution order:
 *   1. Workers AI binding (env.AI) — production Cloudflare Workers runtime
 *   2. Workers AI REST API (CF_API_TOKEN + CF_ACCOUNT_ID) — local testing
 *   3. Tesseract.js local OCR — offline fallback
 */
export async function solveCaptcha(
  imageBase64: string,
  ai?: any,
  _timeoutMs = 60000
): Promise<string> {
  const clean = imageBase64.replace(/^data:image\/[^;]+;base64,/, "").trim();
  if (!clean) throw new Error("Empty CAPTCHA image");

  const binaryStr = atob(clean);
  const imageBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    imageBytes[i] = binaryStr.charCodeAt(i);
  }

  // Strategy 1: Workers AI binding (production runtime)
  if (ai) {
    try {
      return await solveWithWorkersAI(ai, imageBytes);
    } catch (e: any) {
      console.warn(`Workers AI failed: ${e.message}, falling back`);
    }
  }

  // Strategy 2: Workers AI REST API (local testing / dev)
  const envObj = (globalThis as any).process?.env || {};
  if (envObj.CF_API_TOKEN || envObj.CLOUDFLARE_API_TOKEN) {
    try {
      return await solveWithWorkersAIRest(clean);
    } catch (e: any) {
      console.warn(`Workers AI REST failed: ${e.message}, falling back to tesseract`);
    }
  }

  // Strategy 3: Tesseract local OCR (offline fallback)
  return solveWithTesseract(clean);
}

// For tests: allow terminate
export async function terminateCaptchaWorker(): Promise<void> {
  if (cachedWorker) {
    try { await cachedWorker.terminate(); } catch {}
    cachedWorker = null;
    workerInit = null;
  }
}
