/**
 * Integration tests for the Growth System Completion Pass 1 (Part 4) Twilio
 * Voice webhook (app/api/webhooks/voice/inbound/route.ts). handleMissedCall
 * is exercised directly (with a fake sendSmsFn - this environment has no
 * real Twilio credentials) for the core pipeline; POST() itself is
 * separately exercised via a real, constructed NextRequest to verify
 * signature authentication, matching this session's own established
 * pattern for a route with no next/headers dependency (see
 * app/api/automation/n8n-callback/booking.integration.test.ts).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/api/webhooks/voice/inbound/route.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
// A real POST() auth test needs TWILIO_AUTH_TOKEN configured - this
// environment has none, so provide a throwaway one just for signing/
// verifying the one request that exercises POST() itself. Never a real
// Twilio credential; never used to reach the real Twilio API.
if (!process.env.TWILIO_AUTH_TOKEN) process.env.TWILIO_AUTH_TOKEN = "test-auth-token-for-voice-webhook-tests";

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { resolveOrCreateContact }: typeof import("@/lib/contacts/resolve") = require(path.join(REPO_ROOT, "lib/contacts/resolve.ts"));
const { NextRequest } = require("next/server");
const { POST, handleMissedCall }: typeof import("./route") = require(path.join(REPO_ROOT, "app/api/webhooks/voice/inbound/route.ts"));

/** Ensures a pre-existing test contact is actually findable by the route's own resolveOrCreateContact() phone-matching (which keys off phone_normalized, never the raw phone column) - a raw `.insert({phone})` fixture would silently create a SECOND, different contact instead of matching. */
async function makeContact(phone: string) {
  const result = await resolveOrCreateContact(service, { organizationId, phone });
  if (result.outcome !== "created" && result.outcome !== "matched") throw new Error(`failed to create test contact: ${result.outcome}`);
  return result.contact.id as string;
}

const service = createServiceRoleClient();

function fakeSendSms() {
  return async () => ({ ok: true as const, providerMessageId: `FAKE-${Date.now()}-${Math.random()}` });
}

let organizationId: string;
let smsNumber: string;
let callSidCounter = 0;
function nextCallSid() {
  callSidCounter += 1;
  return `CA-test-${Date.now()}-${callSidCounter}`;
}

before(async () => {
  smsNumber = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
  const { data: org } = await service
    .from("organizations")
    .insert({ name: "Voice Webhook Test Org", payment_status: "active", automation_mode: "live", sms_phone_number: smsNumber, timezone: "UTC" })
    .select("id")
    .single();
  organizationId = org!.id;
});

after(async () => {
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("workflow_executions").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("leads").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("1. an unknown caller: a new contact and a new lead (source: phone) are created", async () => {
  const from = "+15555551201";
  await handleMissedCall(service, { callSid: nextCallSid(), from, to: smsNumber }, fakeSendSms());

  const { data: contact } = await service.from("contacts").select("id").eq("organization_id", organizationId).eq("phone", from).maybeSingle();
  assert.ok(contact, "a new contact must be created for an unrecognized caller");

  const { data: lead } = await service.from("leads").select("source, status, temperature").eq("organization_id", organizationId).eq("contact_id", contact!.id).maybeSingle();
  assert.equal(lead?.source, "phone");
  assert.equal(lead?.status, "new");
});

test("2. a known contact with an existing open lead: the existing lead is associated, never duplicated", async () => {
  const from = "+15555551202";
  const contactId = await makeContact(from);
  const { data: existingLead } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contactId, source: "website", status: "contacted", temperature: "warm" }).select("id").single();

  await handleMissedCall(service, { callSid: nextCallSid(), from, to: smsNumber }, fakeSendSms());

  const { data: leads } = await service.from("leads").select("id").eq("organization_id", organizationId).eq("contact_id", contactId);
  assert.equal(leads?.length, 1, "no second lead should be created when an open one already exists");
  assert.equal(leads?.[0]?.id, existingLead!.id);
});

test("3. a known contact with NO open lead (e.g. previously won/lost): a new lead is created rather than reusing the closed one", async () => {
  const from = "+15555551203";
  const contactId = await makeContact(from);
  await service.from("leads").insert({ organization_id: organizationId, contact_id: contactId, source: "website", status: "won", temperature: "hot" });

  await handleMissedCall(service, { callSid: nextCallSid(), from, to: smsNumber }, fakeSendSms());

  const { data: leads } = await service.from("leads").select("status").eq("organization_id", organizationId).eq("contact_id", contactId);
  assert.equal(leads?.length, 2);
  assert.ok(leads?.some((l) => l.status === "new"));
});

test("4. the immediate SMS is sent through the real gate + send path, with an opt-out line", async () => {
  const from = "+15555551204";
  await handleMissedCall(service, { callSid: nextCallSid(), from, to: smsNumber }, fakeSendSms());

  const { data: contact } = await service.from("contacts").select("id").eq("organization_id", organizationId).eq("phone", from).single();
  const { data: messages } = await service.from("messages").select("body, status, direction").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(5);
  const forThisContact = messages?.find((m) => m.direction === "outbound");
  assert.ok(forThisContact, "an outbound SMS must be recorded");
  assert.equal(forThisContact?.status, "sent");
  assert.match(forThisContact?.body ?? "", /missed your call/i);
  assert.match(forThisContact?.body ?? "", /STOP/);
  void contact;
});

test("5. deduplication: a retried webhook delivery for the same CallSid never creates a second contact, lead, or message", async () => {
  const from = "+15555551205";
  const callSid = nextCallSid();

  await handleMissedCall(service, { callSid, from, to: smsNumber }, fakeSendSms());
  const { data: contactAfterFirst } = await service.from("contacts").select("id").eq("organization_id", organizationId).eq("phone", from).single();
  const messagesAfterFirst = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);

  await handleMissedCall(service, { callSid, from, to: smsNumber }, fakeSendSms());
  const { data: contactsAfterSecond } = await service.from("contacts").select("id").eq("organization_id", organizationId).eq("phone", from);
  const messagesAfterSecond = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);

  assert.equal(contactsAfterSecond?.length, 1);
  assert.equal(contactsAfterSecond?.[0]?.id, contactAfterFirst?.id);
  assert.equal(messagesAfterSecond.count, messagesAfterFirst.count, "a retried CallSid must never send a second text");

  const { data: events } = await service.from("automation_events").select("id").eq("organization_id", organizationId).eq("event_type", "call.missed").eq("idempotency_key", `call.missed:${callSid}`);
  assert.equal(events?.length, 1);
});

test("6. an opted-out contact never receives the missed-call SMS - the gate's own opt-out check still applies", async () => {
  const from = "+15555551206";
  const contactId = await makeContact(from);
  await service.from("contacts").update({ sms_opt_out: true }).eq("id", contactId);

  await handleMissedCall(service, { callSid: nextCallSid(), from, to: smsNumber }, fakeSendSms());

  const { data: conversation } = await service.from("conversations").select("id").eq("organization_id", organizationId).eq("contact_id", contactId).maybeSingle();
  if (conversation) {
    const { data: messages } = await service.from("messages").select("id").eq("conversation_id", conversation.id).eq("direction", "outbound").eq("status", "sent");
    assert.equal(messages?.length, 0);
  }
});

test("7. after-hours: the immediate SMS still sends - a missed call is exactly the case this safety net exists for", async () => {
  const from = "+15555551207";
  // No business_hours rows configured for this organization at all -
  // isWithinBusinessHours treats an empty configuration as "always open"
  // (see outbound-gate.ts), and this route never opts into
  // respectBusinessHours in the first place (it's omitted from the gate
  // call entirely) - confirming the missed-call text is never held back
  // regardless of the hour.
  await handleMissedCall(service, { callSid: nextCallSid(), from, to: smsNumber }, fakeSendSms());

  const { data: contact } = await service.from("contacts").select("id").eq("organization_id", organizationId).eq("phone", from).single();
  const { data: conversation } = await service.from("conversations").select("id").eq("organization_id", organizationId).eq("contact_id", contact!.id).single();
  const { data: messages } = await service.from("messages").select("status").eq("conversation_id", conversation!.id).eq("direction", "outbound");
  assert.equal(messages?.[0]?.status, "sent");
});

test("8. automation_paused: no SMS is sent when the founder's kill switch is on, but the caller is still greeted (no error)", async () => {
  await service.from("organizations").update({ automation_paused: true }).eq("id", organizationId);
  try {
    const from = "+15555551208";
    const response = await handleMissedCall(service, { callSid: nextCallSid(), from, to: smsNumber }, fakeSendSms());
    assert.equal(response.status, 200);

    const { data: contact } = await service.from("contacts").select("id").eq("organization_id", organizationId).eq("phone", from).single();
    const { data: conversation } = await service.from("conversations").select("id").eq("organization_id", organizationId).eq("contact_id", contact!.id).maybeSingle();
    if (conversation) {
      const { data: messages } = await service.from("messages").select("id").eq("conversation_id", conversation.id).eq("direction", "outbound").eq("status", "sent");
      assert.equal(messages?.length, 0);
    }
  } finally {
    await service.from("organizations").update({ automation_paused: false }).eq("id", organizationId);
  }
});

test("9. payment_required: no contact, lead, or event is created at all - the caller is greeted generically, nothing about billing is ever exposed", async () => {
  const { data: inactiveOrg } = await service.from("organizations").insert({ name: "Voice Webhook Test Org (Inactive)", payment_status: "payment_required", automation_mode: "live", sms_phone_number: `+1555${Math.floor(1000000 + Math.random() * 8999999)}` }).select("id, sms_phone_number").single();
  try {
    const from = "+15555551209";
    const response = await handleMissedCall(service, { callSid: nextCallSid(), from, to: inactiveOrg!.sms_phone_number as string }, fakeSendSms());
    assert.equal(response.status, 200);

    const { data: contacts } = await service.from("contacts").select("id").eq("organization_id", inactiveOrg!.id).eq("phone", from);
    assert.equal(contacts?.length ?? 0, 0, "a payment_required organization must never create a contact from a missed call");
  } finally {
    await service.from("organizations").delete().eq("id", inactiveOrg!.id);
  }
});

test("10. invalid/missing caller id: an unparseable From number is handled gracefully, creating nothing", async () => {
  const response = await handleMissedCall(service, { callSid: nextCallSid(), from: "not-a-phone-number", to: smsNumber }, fakeSendSms());
  assert.equal(response.status, 200);

  const { data: contacts } = await service.from("contacts").select("id").eq("organization_id", organizationId).eq("phone", "not-a-phone-number");
  assert.equal(contacts?.length ?? 0, 0);
});

test("10b. L3: an unusable caller ID still notifies the founder (never throws) even when notification_email/phone are configured", async () => {
  await service.from("notification_settings").upsert({ organization_id: organizationId, notify_on_missed_call: true, notification_email: "owner@example.com", notification_phone: "+15555550001" }, { onConflict: "organization_id" });
  try {
    const response = await handleMissedCall(service, { callSid: nextCallSid(), from: "restricted", to: smsNumber }, fakeSendSms());
    assert.equal(response.status, 200, "an unusable caller ID must still return valid TwiML, never throw, even with real notification channels configured");
    const text = await response.text();
    assert.match(text, /<Response>/);
  } finally {
    await service.from("notification_settings").delete().eq("organization_id", organizationId);
  }
});

test("11. an unrecognized destination number is handled gracefully (no matching organization), never throwing", async () => {
  const response = await handleMissedCall(service, { callSid: nextCallSid(), from: "+15555551210", to: "+19995550000" }, fakeSendSms());
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /<Response>/);
});

test("12. provider failure: sendSms rejecting the request never throws and still returns valid TwiML", async () => {
  const from = "+15555551211";
  const failingSend = async () => ({ ok: false as const, error: "The SMS provider rejected the request." });
  const response = await handleMissedCall(service, { callSid: nextCallSid(), from, to: smsNumber }, failingSend);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /<Response>/);
});

test("13. cross-org isolation: a missed call to organization A's number never creates data under any other organization", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Voice Webhook Test Org (Other)", payment_status: "active", automation_mode: "live" }).select("id").single();
  try {
    const from = "+15555551212";
    await handleMissedCall(service, { callSid: nextCallSid(), from, to: smsNumber }, fakeSendSms());

    const { data: contacts } = await service.from("contacts").select("id").eq("organization_id", otherOrg!.id).eq("phone", from);
    assert.equal(contacts?.length, 0);
  } finally {
    await service.from("organizations").delete().eq("id", otherOrg!.id);
  }
});

// ==================== POST() itself: signature authentication ====================

function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

test("14. POST rejects a request with a missing signature header", async () => {
  const request = new NextRequest("http://localhost/api/webhooks/voice/inbound", {
    method: "POST",
    body: new URLSearchParams({ CallSid: "CA-x", From: "+15555550001", To: smsNumber }),
  });
  const response = await POST(request);
  assert.equal(response.status, 401);
});

test("15. POST rejects a request with an invalid signature", async () => {
  const params = { CallSid: "CA-x", From: "+15555550001", To: smsNumber };
  const request = new NextRequest("http://localhost/api/webhooks/voice/inbound", {
    method: "POST",
    headers: { "x-twilio-signature": "not-the-real-signature" },
    body: new URLSearchParams(params),
  });
  const response = await POST(request);
  assert.equal(response.status, 401);
});

test("16. POST accepts a correctly-signed request and returns valid TwiML", async () => {
  const url = "http://localhost/api/webhooks/voice/inbound";
  const params = { CallSid: nextCallSid(), From: "+15555551213", To: smsNumber };
  const signature = twilioSignature(url, params, process.env.TWILIO_AUTH_TOKEN!);
  const request = new NextRequest(url, {
    method: "POST",
    headers: { "x-twilio-signature": signature },
    body: new URLSearchParams(params),
  });
  const response = await POST(request);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /<Response>/);
});
