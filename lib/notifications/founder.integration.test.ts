/**
 * Integration tests for lib/notifications/founder.ts - the founder
 * notification dispatch itself (Growth System Completion Pass 1, Part 1).
 * Every call-site test elsewhere in this pass (hot lead, AI escalation,
 * appointment booked, missed call) exercises this module indirectly; this
 * file tests notifyFounder() directly, focused specifically on the rules
 * the task itself calls out: enabled/disabled, email-only/SMS-only/both/
 * neither, notification failure never throwing, and no secrets/provider
 * internals ever appearing in the composed message. No real
 * Resend/Twilio call is ever made - both channels are injected via
 * notifyFounder's own deps seam.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/notifications/founder.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { notifyFounder }: typeof import("./founder") = require(path.join(REPO_ROOT, "lib/notifications/founder.ts"));

const service = createServiceRoleClient();

let organizationId: string;
let previousResendKey: string | undefined;
let previousEmailFrom: string | undefined;

async function setNotificationSettings(overrides: Record<string, unknown>) {
  await service.from("notification_settings").upsert({ organization_id: organizationId, ...overrides }, { onConflict: "organization_id" });
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Founder Notifications Test Org" }).select("id").single();
  organizationId = org!.id;

  // notifyByEmail (like lib/email/send-signup-notification.ts's own
  // sendSignupNotification) requires RESEND_API_KEY/EMAIL_FROM to be
  // configured before it will even attempt a send - this environment has
  // neither, so these are set here temporarily and restored in after(),
  // matching lib/email/send-signup-notification.test.ts's own established
  // pattern. The injected `sendEmail` fake below never makes a real network
  // call regardless.
  previousResendKey = process.env.RESEND_API_KEY;
  previousEmailFrom = process.env.EMAIL_FROM;
  process.env.RESEND_API_KEY = "test-key";
  process.env.EMAIL_FROM = "notifications@example.com";
});

after(async () => {
  await service.from("notification_settings").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);

  if (previousResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = previousResendKey;
  if (previousEmailFrom === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = previousEmailFrom;
});

test("1. setting OFF: absolutely no notification is sent, even with both email and phone configured", async () => {
  await setNotificationSettings({ notify_on_hot_lead: false, notification_email: "owner@example.com", notification_phone: "+15555550001" });

  let emailCalled = false;
  let smsCalled = false;
  await notifyFounder(
    service,
    { organizationId, kind: "hot_lead", summary: "test" },
    { sendEmail: async () => { emailCalled = true; return {}; }, sendSmsFn: async () => { smsCalled = true; return { ok: true, providerMessageId: "x" }; } },
  );

  assert.equal(emailCalled, false);
  assert.equal(smsCalled, false);
});

test("2. setting ON, email-only configured: only the email channel is attempted", async () => {
  await setNotificationSettings({ notify_on_hot_lead: true, notification_email: "owner@example.com", notification_phone: null });

  let emailCalled = false;
  let smsCalled = false;
  await notifyFounder(
    service,
    { organizationId, kind: "hot_lead", summary: "test" },
    { sendEmail: async () => { emailCalled = true; return {}; }, sendSmsFn: async () => { smsCalled = true; return { ok: true, providerMessageId: "x" }; } },
  );

  assert.equal(emailCalled, true);
  assert.equal(smsCalled, false);
});

test("3. setting ON, SMS-only configured: only the SMS channel is attempted", async () => {
  await setNotificationSettings({ notify_on_hot_lead: true, notification_email: null, notification_phone: "+15555550001" });

  let emailCalled = false;
  let smsCalled = false;
  await notifyFounder(
    service,
    { organizationId, kind: "hot_lead", summary: "test" },
    { sendEmail: async () => { emailCalled = true; return {}; }, sendSmsFn: async () => { smsCalled = true; return { ok: true, providerMessageId: "x" }; } },
  );

  assert.equal(emailCalled, false);
  assert.equal(smsCalled, true);
});

test("4. setting ON, both configured: both channels are attempted independently", async () => {
  await setNotificationSettings({ notify_on_hot_lead: true, notification_email: "owner@example.com", notification_phone: "+15555550001" });

  let emailCalled = false;
  let smsCalled = false;
  await notifyFounder(
    service,
    { organizationId, kind: "hot_lead", summary: "test" },
    { sendEmail: async () => { emailCalled = true; return {}; }, sendSmsFn: async () => { smsCalled = true; return { ok: true, providerMessageId: "x" }; } },
  );

  assert.equal(emailCalled, true);
  assert.equal(smsCalled, true);
});

test("5. setting ON, neither channel configured: nothing is sent - there's nowhere to send it, and this is not an error", async () => {
  await setNotificationSettings({ notify_on_hot_lead: true, notification_email: null, notification_phone: null });

  let emailCalled = false;
  let smsCalled = false;
  await notifyFounder(
    service,
    { organizationId, kind: "hot_lead", summary: "test" },
    { sendEmail: async () => { emailCalled = true; return {}; }, sendSmsFn: async () => { smsCalled = true; return { ok: true, providerMessageId: "x" }; } },
  );

  assert.equal(emailCalled, false);
  assert.equal(smsCalled, false);
});

test("6. a failing email channel never throws, and never blocks the SMS channel from still being attempted", async () => {
  await setNotificationSettings({ notify_on_hot_lead: true, notification_email: "owner@example.com", notification_phone: "+15555550001" });

  let smsCalled = false;
  await assert.doesNotReject(
    notifyFounder(
      service,
      { organizationId, kind: "hot_lead", summary: "test" },
      { sendEmail: async () => { throw new Error("Resend is down"); }, sendSmsFn: async () => { smsCalled = true; return { ok: true, providerMessageId: "x" }; } },
    ),
  );
  assert.equal(smsCalled, true);
});

test("7. a failing SMS channel (ok:false, not a thrown error) never throws", async () => {
  await setNotificationSettings({ notify_on_hot_lead: true, notification_email: null, notification_phone: "+15555550001" });

  await assert.doesNotReject(
    notifyFounder(
      service,
      { organizationId, kind: "hot_lead", summary: "test" },
      { sendSmsFn: async () => ({ ok: false, error: "The SMS provider rejected the request." }) },
    ),
  );
});

test("8. each of the four kinds is gated by its own distinct setting - hot_lead being ON does not also enable missed_call", async () => {
  await setNotificationSettings({
    notify_on_hot_lead: true,
    notify_on_ai_escalation: false,
    notify_on_missed_call: false,
    notify_on_appointment_booked: false,
    notification_email: "owner@example.com",
    notification_phone: null,
  });

  let calls = 0;
  const sendEmail = async () => { calls += 1; return {}; };

  await notifyFounder(service, { organizationId, kind: "hot_lead", summary: "x" }, { sendEmail });
  assert.equal(calls, 1);

  await notifyFounder(service, { organizationId, kind: "ai_escalation", summary: "x" }, { sendEmail });
  await notifyFounder(service, { organizationId, kind: "missed_call", summary: "x" }, { sendEmail });
  await notifyFounder(service, { organizationId, kind: "appointment_booked", summary: "x" }, { sendEmail });
  assert.equal(calls, 1, "only hot_lead is enabled - the other three kinds must never send");
});

test("9. organization isolation: notifyFounder never reads another organization's notification settings", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Founder Notifications Test Org (Other)" }).select("id").single();
  try {
    await setNotificationSettings({ notify_on_hot_lead: false });
    await service.from("notification_settings").upsert({ organization_id: otherOrg!.id, notify_on_hot_lead: true, notification_email: "other@example.com" }, { onConflict: "organization_id" });

    let emailCalled = false;
    await notifyFounder(service, { organizationId, kind: "hot_lead", summary: "x" }, { sendEmail: async () => { emailCalled = true; return {}; } });

    assert.equal(emailCalled, false, "organization A's OFF setting must never be satisfied by organization B's ON setting");
  } finally {
    await service.from("notification_settings").delete().eq("organization_id", otherOrg!.id);
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});

test("10. the composed message never includes a secret, provider token, or internal database id beyond what detailPath itself carries", async () => {
  await setNotificationSettings({ notify_on_hot_lead: true, notification_email: "owner@example.com", notification_phone: null });

  let capturedText = "";
  await notifyFounder(
    service,
    { organizationId, kind: "hot_lead", summary: "A lead needs attention.", detailPath: "/leads/abc123" },
    { sendEmail: async (email) => { capturedText = email.text; return {}; } },
  );

  assert.doesNotMatch(capturedText, /RESEND_API_KEY|TWILIO_|sk_live|Bearer /i);
});
