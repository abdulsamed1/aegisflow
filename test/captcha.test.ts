import test from "node:test";
import assert from "node:assert";
import { solveCaptcha, isCaptchaError } from "../src/captcha";

test("captcha: polls 2captcha and returns code", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  (globalThis as any).fetch = async (url: string) => {
    calls++;
    const u = String(url);
    if (u.includes("in.php")) return new Response("OK|12345", { status: 200 });
    if (calls === 2) return new Response("CAPCHA_NOT_READY", { status: 200 });
    return new Response("OK|C65P", { status: 200 });
  };
  try {
    const code = await solveCaptcha("base64imgcontent", "key123");
    assert.strictEqual(code, "C65P");
  } finally {
    (globalThis as any).fetch = orig;
  }
});

test("captcha: strips data URI prefix", async () => {
  const orig = globalThis.fetch;
  let sentBody = "";
  (globalThis as any).fetch = async (url: string, init: any) => {
    const u = String(url);
    if (u.includes("in.php")) {
      sentBody = init?.body || "";
      return new Response("OK|999", { status: 200 });
    }
    return new Response("OK|ABCD", { status: 200 });
  };
  try {
    await solveCaptcha("data:image/png;base64,abc123", "k");
    assert.ok(sentBody.includes("body=abc123"), "should strip prefix");
    assert.ok(!sentBody.includes("data%3Aimage"), "should not include data URI");
  } finally {
    (globalThis as any).fetch = orig;
  }
});

test("captcha: throws on missing api key", async () => {
  await assert.rejects(() => solveCaptcha("img", ""), /CAPTCHA_API_KEY/);
});

test("captcha: throws on in.php error", async () => {
  const orig = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response("ERROR_WRONG_USER_KEY", { status: 200 });
  try {
    await assert.rejects(() => solveCaptcha("img", "badkey"), /in\.php failed/);
  } finally {
    (globalThis as any).fetch = orig;
  }
});

test("captcha: detects captcha error page", () => {
  assert.ok(isCaptchaError('<div class="message-error">Captcha incorrect</div>'));
  assert.ok(isCaptchaError('CAPTCHA invalid code'));
  assert.ok(!isCaptchaError("<div>GESX-KAIRO-123</div>"));
  assert.ok(!isCaptchaError(""));
});

test("captcha: requires non-empty image", async () => {
  await assert.rejects(() => solveCaptcha("   ", "k"), /Empty CAPTCHA/);
});
