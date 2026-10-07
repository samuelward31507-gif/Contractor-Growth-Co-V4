/**
 * Final Batch 4: operational alerts - structured, sanitized, never throwing,
 * email only when asked and configured, deduplicated.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/ops/alert.test.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { reportOpsAlert, resetOpsAlertDedupeForTests, sanitizeOpsContext, OPS_ALERT_EMAIL_WINDOW_MS } from "./alert";

const CONFIGURED = { OPS_ALERT_EMAIL: "ops@example.test", EMAIL_FROM: "alerts@example.test", RESEND_API_KEY: "re_test_placeholder_not_real", VERCEL_ENV: "preview" };
let lines: string[] = [];
let sent: { to: string; subject: string; text: string }[] = [];
let clock = 1_000_000;
const deps = (env: Record<string, string> = CONFIGURED, fail = false) => ({
  env,
  now: () => clock,
  log: (line: string) => void lines.push(line),
  sendEmail: async (email: { to: string; from: string; subject: string; text: string }) => {
    if (fail) return { error: new Error("provider down") };
    sent.push(email);
    return {};
  },
});

beforeEach(() => {
  lines = [];
  sent = [];
  clock = 1_000_000;
  resetOpsAlertDedupeForTests();
});

test("every alert is one structured JSON log line with the searchable marker", async () => {
  const result = await reportOpsAlert({ severity: "warning", source: "automation.health", code: "x_failed", message: "Something failed.", context: { phase: "retry" } }, deps());
  assert.deepEqual(result, { logged: true, emailed: false, emailSkipped: "not_requested" });
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual({ marker: parsed.trackpr_ops_alert, severity: parsed.severity, source: parsed.source, code: parsed.code, environment: parsed.environment, context: parsed.context }, { marker: true, severity: "warning", source: "automation.health", code: "x_failed", environment: "preview", context: { phase: "retry" } });
  assert.equal(sent.length, 0);
});

test("context never carries secrets, credentials, contact details or message content", () => {
  const safe = sanitizeOpsContext({
    organizationId: "org-1",
    count: 3,
    ok: false,
    apiKey: "sk_live_should_never_appear",
    authorization: "Bearer x",
    webhookSecret: "whsec_x",
    phone: "+15550001111",
    customerEmail: "a@b.c",
    body: "customer message text",
    messageContent: "hi",
    "bad key!": "x",
    long: "y".repeat(500),
  });
  assert.deepEqual(Object.keys(safe).sort(), ["count", "long", "ok", "organizationId"]);
  assert.equal((safe.long as string).length, 200);
  assert.ok(!JSON.stringify(safe).includes("sk_live") && !JSON.stringify(safe).includes("+1555"));
});

test("notify without OPS_ALERT_EMAIL (or Resend config) logs only - nothing invented", async () => {
  for (const env of [{}, { OPS_ALERT_EMAIL: "ops@example.test" }, { OPS_ALERT_EMAIL: "ops@example.test", EMAIL_FROM: "a@example.test" }]) {
    const result = await reportOpsAlert({ severity: "critical", source: "s", code: "c", message: "m", notify: true }, deps(env as Record<string, string>));
    assert.deepEqual(result, { logged: true, emailed: false, emailSkipped: "not_configured" });
  }
  assert.equal(sent.length, 0);
  assert.equal(lines.length, 3);
});

test("notify with config emails the operator once, and the same code is deduplicated within the window", async () => {
  const alert = { severity: "critical" as const, source: "automation.scheduler_watchdog", code: "scheduler_degraded", message: "Scheduler degraded.", context: { staleAutomationCount: 2 }, notify: true };
  assert.deepEqual(await reportOpsAlert(alert, deps()), { logged: true, emailed: true });
  assert.equal(sent[0].to, "ops@example.test");
  assert.match(sent[0].subject, /\[Trackpr critical\] scheduler_degraded \(preview\)/);
  assert.match(sent[0].text, /staleAutomationCount: 2/);
  assert.ok(!sent[0].text.includes("re_test_placeholder"), "the API key is never in the email");
  assert.deepEqual(await reportOpsAlert(alert, deps()), { logged: true, emailed: false, emailSkipped: "deduplicated" });
  clock += OPS_ALERT_EMAIL_WINDOW_MS + 1;
  assert.deepEqual(await reportOpsAlert(alert, deps()), { logged: true, emailed: true });
  assert.equal(sent.length, 2);
  assert.equal(lines.length, 3, "every occurrence is still logged");
});

test("an unavailable email provider never throws - the failure is logged and the next attempt may retry", async () => {
  const alert = { severity: "critical" as const, source: "s", code: "c", message: "m", notify: true };
  assert.deepEqual(await reportOpsAlert(alert, deps(CONFIGURED, true)), { logged: true, emailed: false, emailSkipped: "send_failed" });
  assert.equal(JSON.parse(lines[1]).code, "ops_alert_email_failed");
  assert.ok(!lines[1].includes("provider down"), "provider error text is not echoed");
  assert.deepEqual(await reportOpsAlert(alert, deps()), { logged: true, emailed: true }, "a failed send does not start the dedupe window");
});

test("a throwing logger or email client can never break the caller", async () => {
  const result = await reportOpsAlert(
    { severity: "critical", source: "s", code: "c", message: "m", notify: true },
    { env: CONFIGURED, log: () => { throw new Error("log down"); }, sendEmail: async () => { throw new Error("boom"); } },
  );
  assert.equal(result.emailed, false);
});
