import test from "node:test";
import assert from "node:assert";
import worker from "../src/index";

// End-user UX (2026-09-11): the operator's dashboard appears before people who
// don't read logs or technical codes. Best practice is progressive disclosure:
// a plain-Arabic hero answering "what's happening with my request?" first,
// technical ledgers kept below, plus a one-tap simplified view that hides the
// log/failure tiles. No new endpoints, no auth change, DOM IDs preserved.

async function servedHTML(): Promise<{ html: string; js: string }> {
  const env: any = { DB: { prepare: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) }) }, JOB_LOCK: {}, SESSION_KV: {}, MYBROWSER: {}, ENVIRONMENT: "test", ADMIN_API_KEY: "test-admin-key" };
  const res = await worker.fetch(new Request("https://aegisflow.local/", { headers: { Authorization: "Bearer test-admin-key" } }), env, {} as any);
  const html = await res.text();
  const open = html.indexOf("<script>");
  const close = html.indexOf("</script>");
  assert.ok(open >= 0 && close > open, "Dashboard must ship its inline script");
  return { html, js: html.slice(open + "<script>".length, close) };
}

test("End-user hero: plain-Arabic request status answers first, no codes", async () => {
  const { html, js } = await servedHTML();
  assert.ok(html.includes('id="hero-status"'), "hero status element must exist");
  assert.ok(html.includes('id="hero-sub"'), "hero sub-line element must exist");
  assert.ok(html.includes("حالة طلبك"), "hero must be labeled for the end-user");
  assert.ok(js.includes("function renderHero"), "served script must drive the hero from live data");
  for (const s of ["تم حجز موعدك بنجاح", "نقدّم طلبك الآن", "طلبك نشط", "لا يوجد طلب نشط"]) {
    assert.ok(js.includes(s), `hero must speak plainly ("${s}")`);
  }
  // The hero builder reasons over data flags (was_open / BOOKED / breaker),
  // never over raw event codes.
  const heroSrc = js.slice(js.indexOf("function renderHero"), js.indexOf("function renderHero") + 2500);
  assert.ok(!/[A-Z]+_[A-Z_]+/.test(heroSrc), "hero copy must contain zero TECHNICAL_CODE tokens");
});

test("Simplified view: one tap hides the log/failure tiles, choice persists", async () => {
  const { html, js } = await servedHTML();
  assert.ok(html.includes('id="view-toggle"'), "view toggle button must exist");
  assert.ok(html.includes("وضع مبسط"), "toggle must read plain Arabic");
  assert.ok(js.includes("toggleSimpleView"), "served script must implement the toggle");
  assert.ok(js.includes("aegisflow-view"), "choice must persist across reloads");
  assert.ok(html.includes("body.simple-mode .operator-only"), "simple mode must have a hiding rule");
  assert.ok(html.includes('id="audit-card"'), "audit tile keeps its DOM id");
  const auditTag = html.match(/<section[^>]*id="audit-card"[^>]*>/)?.[0] || "";
  assert.ok(auditTag.includes("operator-only"), "audit tile hides in simple mode");
  assert.ok(html.includes('aria-labelledby="health-title"'), "health tile keeps its label");
  const healthTag = html.match(/<section[^>]*aria-labelledby="health-title"[^>]*>/)?.[0] || "";
  assert.ok(healthTag.includes("operator-only"), "health tile hides in simple mode");
});
