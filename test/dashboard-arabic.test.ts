import test from "node:test";
import assert from "node:assert";
import worker from "../src/index";

// Operator reads Arabic — the dashboard's static HTML already is, but the
// live log surfaces rendered raw English event codes (audit filter dropdown,
// audit table pills, health table pills). The served inline script must carry
// an Arabic label map covering every known event type, with raw-code fallback.

const KNOWN_EVENTS = [
  "NO_APPOINTMENT", "APPOINTMENT_FOUND", "RULE_MISMATCH", "UNKNOWN_RESPONSE",
  "BOOKING_STARTED", "BOOKING_RETRY", "SUBMITTED", "BOOKED", "BOOKING_FAILED",
  "SLOT_GONE_PRE_LAUNCH", "PRE_SUBMIT_BLOCKED", "TEMPORARY_ERROR",
  "PORTAL_ERROR", "BUDGET_WARNING", "NOTIFY_SENT", "CLIENT_DELETED",
];

const AR = /[\u0600-\u06FF]/;

async function servedScript(): Promise<string> {
  const env: any = { DB: { prepare: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) }) }, JOB_LOCK: {}, SESSION_KV: {}, MYBROWSER: {}, ENVIRONMENT: "test", ADMIN_API_KEY: "test-admin-key" };
  const res = await worker.fetch(new Request("https://aegisflow.local/", { headers: { Authorization: "Bearer test-admin-key" } }), env, {} as any);
  const html = await res.text();
  const open = html.indexOf("<script>");
  const close = html.indexOf("</script>");
  assert.ok(open >= 0 && close > open, "Dashboard must ship its inline script");
  return html.slice(open + "<script>".length, close);
}

test("Dashboard i18n: inline script maps every known event type to an Arabic label", async () => {
  const js = await servedScript();
  const m = js.match(/EVENT_AR\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(m, "served script must define an EVENT_AR label map");
  for (const ev of KNOWN_EVENTS) {
    const entry = new RegExp(ev + "\\s*:\\s*\"([^\"]+)\"").exec(m[1]);
    assert.ok(entry, `EVENT_AR must cover ${ev}`);
    assert.ok(AR.test(entry[1]), `label for ${ev} must read Arabic, got: ${entry[1]}`);
  }
});

test("Dashboard i18n: audit filter options + table pills render labels, never raw codes", async () => {
  const js = await servedScript();
  // Option text and both pill renderers must go through the label map…
  assert.ok(js.includes("eventLabel(t)"), "audit filter options must use eventLabel()");
  const pillUses = (js.match(/eventLabel\((r|f)\.event_type\)/g) || []).length;
  assert.ok(pillUses >= 2, `audit + health pills must use eventLabel(), found ${pillUses} uses`);
  // …and the old raw-code option text must be gone.
  assert.ok(!js.includes('">" + t + "</option>"'), "raw event code must no longer be the option text");
});
