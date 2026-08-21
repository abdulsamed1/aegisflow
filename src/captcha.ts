/**
 * CAPTCHA solver — 2Captcha integration for BotDetect.
 * Portal uses Captcha_CaptchaImage (250x50) + CaptchaText + 4 BDC_* hidden fields.
 * Challenge is 4-char alphanumeric, dynamic per session (e.g. C65P).
 * ponytail: minimal fetch polling, no SDK dependency
 */

export function isCaptchaError(html: string): boolean {
  if (!html || typeof html !== "string") return false;
  return /captcha/i.test(html) && /incorrect|invalid|error|wrong/i.test(html);
}

export async function solveCaptcha(
  imageBase64: string,
  apiKey: string,
  timeoutMs = 60000
): Promise<string> {
  if (!apiKey) throw new Error("CAPTCHA_API_KEY not configured");
  const clean = imageBase64.replace(/^data:image\/[^;]+;base64,/, "").trim();
  if (!clean) throw new Error("Empty CAPTCHA image");

  const inRes = await fetch("https://2captcha.com/in.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ method: "base64", key: apiKey, body: clean, json: "0" }).toString(),
  });
  const inText = (await inRes.text()).trim();
  if (!inText.startsWith("OK|")) throw new Error(`2captcha in.php failed: ${inText}`);
  const captchaId = inText.split("|")[1];
  if (!captchaId) throw new Error(`2captcha missing id: ${inText}`);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`https://2captcha.com/res.php?key=${encodeURIComponent(apiKey)}&action=get&id=${encodeURIComponent(captchaId)}`);
    const txt = (await res.text()).trim();
    if (txt === "CAPCHA_NOT_READY") continue;
    if (txt.startsWith("OK|")) return txt.split("|")[1].trim();
    throw new Error(`2captcha error: ${txt}`);
  }
  throw new Error("2captcha timeout");
}
