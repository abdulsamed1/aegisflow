import test from "node:test";
import assert from "node:assert";
import { isCaptchaError, terminateCaptchaWorker, solveCaptcha } from "../src/captcha";

// --- 1. Edge-Case Tests for isCaptchaError Detection ---

test("captcha edge cases: detects all error variations of captcha HTML", () => {
  // Positive matches (should return true)
  assert.ok(isCaptchaError('<div class="message-error">Captcha incorrect</div>'));
  assert.ok(isCaptchaError('<span class="error">The CAPTCHA code entered is invalid</span>'));
  assert.ok(isCaptchaError('CAPTCHA verification failed: wrong text entered'));
  assert.ok(isCaptchaError('<p>Captcha error: please try again</p>'));
  assert.ok(isCaptchaError('CAPTCHA INCORRECT CODE'));
  assert.ok(isCaptchaError('captcha WRONG code'));

  // Negative matches (should return false)
  assert.ok(!isCaptchaError("<div>GESX-KAIRO-123456</div>"), "Confirmation page should not trigger captcha error");
  assert.ok(!isCaptchaError('<input id="CaptchaText" />'), "Form field with Captcha label should not trigger error");
  assert.ok(!isCaptchaError('<a title="BotDetect CAPTCHA ASP.NET Form Validation"></a>'), "Help link should not trigger error");
  assert.ok(!isCaptchaError('<div class="message-error">Internal Server Error 500</div>'), "Non-captcha error should return false");
  assert.ok(!isCaptchaError(""), "Empty string should return false");
  assert.ok(!isCaptchaError(null as any), "Null input should return false");
  assert.ok(!isCaptchaError(undefined as any), "Undefined input should return false");
  assert.ok(!isCaptchaError(12345 as any), "Non-string input should return false");
});

// --- 2. Edge-Case Tests for Image Data Cleaning & Base64 Prefix Stripping ---

test("captcha edge cases: rejects empty, null, or whitespace-only base64 inputs", async () => {
  await assert.rejects(() => solveCaptcha(""), /Empty CAPTCHA image/);
  await assert.rejects(() => solveCaptcha("   "), /Empty CAPTCHA image/);
  await assert.rejects(() => solveCaptcha("\t\n"), /Empty CAPTCHA image/);
  await assert.rejects(() => solveCaptcha("data:image/png;base64,"), /Empty CAPTCHA image/);
  await assert.rejects(() => solveCaptcha("data:image/png;base64,   "), /Empty CAPTCHA image/);
  await assert.rejects(() => solveCaptcha("data:image/jpeg;base64,  \n "), /Empty CAPTCHA image/);
  await assert.rejects(() => solveCaptcha("data:image/webp;base64,"), /Empty CAPTCHA image/);
});

// --- 3. Function Signature & Backward Compatibility ---

test("captcha: function signature accepts optional apiKey and timeout without throwing parameter errors", async () => {
  assert.strictEqual(solveCaptcha.length >= 1, true, "solveCaptcha must accept image without apiKey");
  
  // Accepts optional params before throwing empty check
  await assert.rejects(() => solveCaptcha("", "legacy-key-123", 30000), /Empty CAPTCHA image/);
});

// --- 4. Worker Lifecycle & Cleanup ---

test("captcha: worker termination is idempotent and does not throw when called repeatedly", async () => {
  await terminateCaptchaWorker();
  await terminateCaptchaWorker();
  await terminateCaptchaWorker();
  assert.ok(true, "Repeated worker termination completed safely");
});

// --- Audio channel (BotDetect get=sound -> whisper) ---

test("captcha audio: parseAudioTranscription strips separators and collapses stutters", async () => {
  const { parseAudioTranscription } = await import("../src/captcha");
  assert.strictEqual(parseAudioTranscription("T, D, R, 5, 8."), "TDR58");
  assert.strictEqual(parseAudioTranscription("9, 4, 3, 2, 3, 2, 1,"), "943232"); // capped at 6; solver retries with larger model on bad length
  assert.strictEqual(parseAudioTranscription("B. B. 4. J."), "B4J"); // consecutive dup collapse
  assert.strictEqual(parseAudioTranscription(""), "");
});

test("captcha audio: solveCaptchaAudio rejects empty input without calling AI", async () => {
  const { solveCaptchaAudio } = await import("../src/captcha");
  let called = false;
  await assert.rejects(
    () => solveCaptchaAudio(new Uint8Array(0), { run: async () => { called = true; return {}; } }),
    /Empty CAPTCHA audio/
  );
  assert.strictEqual(called, false);
});
