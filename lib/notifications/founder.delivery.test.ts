/**
 * Phase 3G-1: notifyFounder's delivery result and SMS-only option (used by
 * the weekly owner digest), the owner's setting, and log redaction - against
 * a fake settings read and an injected SMS sender. Offline: no network, no
 * database, no local environment file, no real Twilio or Resend call.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/notifications/founder.delivery.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { notifyFounder }: typeof import("./founder") = require(path.join(process.cwd(), "lib/notifications/founder.ts"));

const PHONE = "+15555550100";

function fakeService(settings: Record<string, unknown> | null) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq"]) builder[name] = () => builder;
      builder.maybeSingle = async () => ({ data: table === "notification_settings" ? settings : { name: "Acme Roofing" }, error: null });
      return builder;
    },
  } as unknown as SupabaseClient;
}

const DIGEST = { organizationId: "org-1", kind: "owner_digest" as const, summary: "4 open opportunities worth $12,500.", detailPath: "/today", smsOnly: true };

async function captureLogs<T>(run: () => Promise<T>) {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    return { result: await run(), logged };
  } finally {
    console.error = original;
  }
}

test("successful owner SMS: delivered, one SMS to the owner's number with the 'Weekly summary' label, no email attempted under smsOnly", async () => {
  const sent: { to: string; body: string }[] = [];
  let emails = 0;
  const result = await notifyFounder(fakeService({ notify_on_owner_digest: true, notification_phone: PHONE, notification_email: "owner@example.test" }), DIGEST, {
    sendSmsFn: async (input) => (sent.push(input), { ok: true, providerMessageId: "SM1" }),
    sendEmail: async () => (emails++, {}),
  });
  assert.deepEqual(result, { outcome: "delivered", sms: true, email: false });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, PHONE);
  assert.match(sent[0].body, /^Weekly summary \(Acme Roofing\): 4 open opportunities worth \$12,500\./);
  assert.equal(emails, 0);
});

test("failed owner SMS: outcome failed, and the log carries only the provider error code - never the provider message or the number", async () => {
  const { result, logged } = await captureLogs(() =>
    notifyFounder(fakeService({ notify_on_owner_digest: true, notification_phone: PHONE }), DIGEST, {
      sendSmsFn: async () => ({ ok: false, error: `The 'To' number ${PHONE} is not a valid phone number.`, providerErrorCode: "21211" }),
    }),
  );
  assert.deepEqual(result, { outcome: "failed" });
  const text = JSON.stringify(logged);
  assert.ok(text.includes("21211"));
  assert.ok(!text.includes(PHONE) && !text.includes("not a valid phone number"), "no number, no provider message");
});

test("a thrown SMS error is failed and logs only the error's name", async () => {
  const { result, logged } = await captureLogs(() =>
    notifyFounder(fakeService({ notify_on_owner_digest: true, notification_phone: PHONE }), DIGEST, {
      sendSmsFn: async () => {
        throw new TypeError(`fetch failed for ${PHONE}`);
      },
    }),
  );
  assert.deepEqual(result, { outcome: "failed" });
  assert.ok(!JSON.stringify(logged).includes(PHONE));
});

test("setting off: nothing is sent (disabled); no phone under smsOnly: nothing is sent (no_recipient), even with an email on file", async () => {
  let sends = 0;
  const sendSmsFn = async () => (sends++, { ok: true as const, providerMessageId: "SM1" });
  assert.deepEqual(await notifyFounder(fakeService({ notify_on_owner_digest: false, notification_phone: PHONE }), DIGEST, { sendSmsFn }), { outcome: "disabled" });
  assert.deepEqual(await notifyFounder(fakeService({ notify_on_owner_digest: true, notification_phone: null, notification_email: "owner@example.test" }), DIGEST, { sendSmsFn }), { outcome: "no_recipient" });
  assert.equal(sends, 0);
});

test("no settings row: the defaults apply (digest on) but there is no recipient, so nothing is sent", async () => {
  let sends = 0;
  const result = await notifyFounder(fakeService(null), DIGEST, { sendSmsFn: async () => (sends++, { ok: true as const, providerMessageId: "SM1" }) });
  assert.deepEqual([result, sends], [{ outcome: "no_recipient" }, 0]);
});

test("a row from before the notify_on_owner_digest column exists still reads (digest defaults on) - the settings read never fails as a whole", async () => {
  const sent: string[] = [];
  const legacyRow = { notification_phone: PHONE, notification_email: null, notify_on_hot_lead: true, notify_on_automation_degraded: true };
  const result = await notifyFounder(fakeService(legacyRow), DIGEST, { sendSmsFn: async (input) => (sent.push(input.to), { ok: true, providerMessageId: "SM1" }) });
  assert.deepEqual([result.outcome, sent], ["delivered", [PHONE]]);
});

test("existing kinds keep both channels when smsOnly is not set", async () => {
  let emails = 0;
  const previous = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };
  process.env.RESEND_API_KEY = "dummy-not-a-key";
  process.env.EMAIL_FROM = "alerts@example.test";
  try {
    const result = await notifyFounder(
      fakeService({ notify_on_hot_lead: true, notification_phone: PHONE, notification_email: "owner@example.test" }),
      { organizationId: "org-1", kind: "hot_lead", summary: "A lead was marked hot." },
      { sendSmsFn: async () => ({ ok: true, providerMessageId: "SM1" }), sendEmail: async () => (emails++, {}) },
    );
    assert.deepEqual([result, emails], [{ outcome: "delivered", sms: true, email: true }, 1]);
  } finally {
    for (const [key, value] of [["RESEND_API_KEY", previous.key], ["EMAIL_FROM", previous.from]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
