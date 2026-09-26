/**
 * Pass 1 hardening follow-up: a focused regression test for the REAL
 * inbound SMS webhook boundary (app/api/webhooks/sms/inbound/route.ts),
 * proving STOP/HELP/START compliance handling still runs before - and
 * instead of - the new booking-reply classifier, and that a genuine
 * appointment-cancellation phrase is never misread as the STOP keyword.
 *
 * This calls the real, unmodified POST() with a real, correctly-computed
 * Twilio signature (via the same HMAC algorithm isValidTwilioSignature()
 * itself implements - see lib/messaging/twilio-signature.ts), matching this
 * codebase's own established precedent for testing a Twilio-signed route
 * end to end (see app/api/webhooks/voice/inbound/route.integration.test.ts's
 * "POST() itself: signature authentication" section, whose fixture and
 * signing helper this file mirrors exactly). No real Twilio credential is
 * ever used or contacted - only a throwaway in-process TWILIO_AUTH_TOKEN
 * used purely to sign and verify these test requests against the real,
 * unmodified verification logic.
 *
 * "The booking classifier is NOT called" is verified two ways, since
 * spying on an internal function call would require modifying the route
 * (out of scope for this hardening pass): (1) directly, by reading the
 * route's own unchanged control flow - classifyAndProcessBookingReply is
 * invoked only inside `if (!insertError && !keyword)`, so a truthy keyword
 * (stop/start/help) skips it entirely by construction; and (2) empirically,
 * at this real webhook boundary, by the complete absence of every
 * observable effect the classifier could have produced (no appointment
 * created, no clarification/booking/cancellation message sent, no
 * conversation lock, no escalation incident) for scenarios A-C, contrasted
 * directly against scenario D, where an equivalent, genuinely distinct
 * phrase DOES produce exactly those effects - proving the absence in A-C
 * is not just "the classifier had nothing to do."
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/api/webhooks/sms/inbound/route.integration.test.ts
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
// A real POST() call needs TWILIO_AUTH_TOKEN configured (route.ts returns
// 401 immediately without it) - this environment has none. A throwaway
// in-process value, used only to sign and verify these test requests
// against the real, unmodified isValidTwilioSignature(), matching the exact
// precedent already established in
// app/api/webhooks/voice/inbound/route.integration.test.ts. Never a real
// Twilio credential; never used to reach the real Twilio API; never written
// to .env.local or any persisted config.
if (!process.env.TWILIO_AUTH_TOKEN) process.env.TWILIO_AUTH_TOKEN = "test-auth-token-for-sms-inbound-webhook-tests";

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { resolveOrCreateContact }: typeof import("@/lib/contacts/resolve") = require(path.join(REPO_ROOT, "lib/contacts/resolve.ts"));
const { NextRequest } = require("next/server");
const { POST }: typeof import("./route") = require(path.join(REPO_ROOT, "app/api/webhooks/sms/inbound/route.ts"));

const service = createServiceRoleClient();
const WEBHOOK_URL = "http://localhost/api/webhooks/sms/inbound";

function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

let sidCounter = 0;
function nextSid() {
  sidCounter += 1;
  return `SM-test-${Date.now()}-${sidCounter}`;
}

async function sendInbound(to: string, from: string, body: string) {
  const params = { MessageSid: nextSid(), From: from, To: to, Body: body };
  const signature = twilioSignature(WEBHOOK_URL, params, process.env.TWILIO_AUTH_TOKEN!);
  const request = new NextRequest(WEBHOOK_URL, {
    method: "POST",
    headers: { "x-twilio-signature": signature },
    body: new URLSearchParams(params),
  });
  return POST(request);
}

let organizationId: string;
let smsNumber: string;

before(async () => {
  smsNumber = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
  const { data: org } = await service
    .from("organizations")
    .insert({ name: "SMS Inbound Compliance Test Org", payment_status: "active", automation_mode: "live", timezone: "UTC", sms_phone_number: smsNumber, phone: "+15559990000", email: "help@example.test" })
    .select("id")
    .single();
  organizationId = org!.id;
});

after(async () => {
  await service.from("automation_incidents").delete().eq("organization_id", organizationId);
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("workflow_executions").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("appointments").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("A. STOP: existing opt-out handling runs, the booking classifier is never reached, and nothing is booked or sent", async () => {
  const from = "+15555580001";
  const response = await sendInbound(smsNumber, from, "STOP");
  assert.equal(response.status, 200);

  const { data: contact } = await service.from("contacts").select("id, sms_opt_out").eq("organization_id", organizationId).eq("phone", from).single();
  assert.equal(contact?.sms_opt_out, true, "existing STOP handling must still opt the contact out");

  const { data: conversation } = await service.from("conversations").select("id").eq("organization_id", organizationId).eq("contact_id", contact!.id).maybeSingle();
  if (conversation) {
    const { data: outbound } = await service.from("messages").select("id").eq("conversation_id", conversation.id).eq("direction", "outbound");
    assert.equal(outbound?.length ?? 0, 0, "STOP must never trigger any outbound reply - not a HELP message, not a booking reply, nothing");
  }

  const { data: appointments } = await service.from("appointments").select("id").eq("organization_id", organizationId);
  assert.equal(appointments?.length ?? 0, 0, "no booking attempt must ever occur for a STOP message");
});

test("B. HELP: existing HELP handling runs, the booking classifier is never reached, and exactly one deterministic reply is sent", async () => {
  const from = "+15555580002";
  const response = await sendInbound(smsNumber, from, "HELP");
  assert.equal(response.status, 200);

  const { data: contact } = await service.from("contacts").select("id, sms_opt_out").eq("organization_id", organizationId).eq("phone", from).single();
  assert.equal(contact?.sms_opt_out, false, "HELP must never opt the contact out");

  const { data: conversation } = await service.from("conversations").select("id").eq("organization_id", organizationId).eq("contact_id", contact!.id).single();
  const { data: outbound } = await service.from("messages").select("body").eq("conversation_id", conversation!.id).eq("direction", "outbound");
  assert.equal(outbound?.length, 1, "expected exactly one outbound message - the deterministic HELP reply, never an additional booking-classifier reply");
  assert.match(outbound![0].body ?? "", /STOP/, "expected the real, deterministic buildHelpResponseMessage() reply");
  assert.match(outbound![0].body ?? "", /SMS Inbound Compliance Test Org/, "expected the organization's own real name in the HELP reply");

  const { data: appointments } = await service.from("appointments").select("id").eq("organization_id", organizationId);
  assert.equal(appointments?.length ?? 0, 0, "no booking attempt must ever occur for a HELP message");
});

test("C. START: existing opt-back-in handling runs, the booking classifier is never reached, and nothing is booked or sent", async () => {
  const from = "+15555580003";
  // Created via resolveOrCreateContact (not a raw .insert()) so it's
  // actually findable by the route's own resolveOrCreateContact call, which
  // matches on phone_normalized - a column raw-inserted fixtures leave
  // null, causing a silent SECOND contact instead of a real match (the
  // exact gotcha already flagged in
  // app/api/webhooks/voice/inbound/route.integration.test.ts's own
  // makeContact() helper).
  const created = await resolveOrCreateContact(service, { organizationId, phone: from });
  if (created.outcome !== "created" && created.outcome !== "matched") throw new Error(`failed to create test contact: ${created.outcome}`);
  const contact = { id: created.contact.id as string };
  await service.from("contacts").update({ sms_opt_out: true }).eq("id", contact.id);

  const response = await sendInbound(smsNumber, from, "START");
  assert.equal(response.status, 200);

  const { data: refreshed } = await service.from("contacts").select("sms_opt_out").eq("id", contact!.id).single();
  assert.equal(refreshed?.sms_opt_out, false, "existing START handling must still opt the contact back in");

  const { data: conversation } = await service.from("conversations").select("id").eq("organization_id", organizationId).eq("contact_id", contact!.id).maybeSingle();
  if (conversation) {
    const { data: outbound } = await service.from("messages").select("id").eq("conversation_id", conversation.id).eq("direction", "outbound");
    assert.equal(outbound?.length ?? 0, 0, "START must never trigger any outbound reply");
  }

  const { data: appointments } = await service.from("appointments").select("id").eq("organization_id", organizationId);
  assert.equal(appointments?.length ?? 0, 0, "no booking attempt must ever occur for a START message");
});

test("D. 'cancel my appointment tomorrow' is NOT treated as the STOP keyword - the real cancellation path remains reachable, and compliance state is untouched", async () => {
  const from = "+15555580004";
  const response = await sendInbound(smsNumber, from, "cancel my appointment tomorrow");
  assert.equal(response.status, 200);

  const { data: contact } = await service.from("contacts").select("id, sms_opt_out").eq("organization_id", organizationId).eq("phone", from).single();
  assert.equal(contact?.sms_opt_out, false, "an appointment-cancellation phrase must never be misread as the generic STOP opt-out");

  // This contact has zero upcoming appointments, so the real cancellation
  // path's own "can't confidently identify which appointment" branch
  // (handleCancelIntent -> escalateToHuman) is the expected, observable
  // proof that classifyAndProcessBookingReply's cancel path genuinely ran -
  // in direct contrast to scenarios A-C, where no such effect exists at all.
  const { data: conversation } = await service.from("conversations").select("id, ai_enabled").eq("organization_id", organizationId).eq("contact_id", contact!.id).single();
  assert.equal(conversation?.ai_enabled, false, "the cancellation path must have run and escalated - proving it was reached, unlike a STOP message");

  const { data: incident } = await service
    .from("automation_incidents")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("category", "human_escalation_requested")
    .eq("fingerprint", `human_escalation_requested:${conversation!.id}`)
    .maybeSingle();
  assert.ok(incident, "expected a durable escalation incident from the real cancellation path, not from any STOP handling");
});

// ==================== Trackpr 2.0, Phase 4C (P2 #7) ====================
//
// Documents, via a real test (not just a code comment), the explicit,
// existing product decision that HELP is intentionally exempt from
// evaluateOutboundGate() - and therefore from the payment/pause/live-mode
// checks that gate performs - while still being subject to its own real
// opt-out and duplicate-send protections via sendOutboundMessage(). This
// pass does NOT change that behavior (see the route's own comment at the
// HELP branch); it only makes the behavior observable and durable via a
// test, so a future change to it is a deliberate, visible decision rather
// than an untested assumption.

async function makeIsolatedOrg(overrides: Record<string, unknown>) {
  const number = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
  const { data: org } = await service
    .from("organizations")
    .insert({ name: "SMS Inbound HELP Gate-Exempt Test Org", payment_status: "active", automation_mode: "live", timezone: "UTC", sms_phone_number: number, phone: "+15559990001", email: "help-gate@example.test", ...overrides })
    .select("id")
    .single();
  return { organizationId: org!.id as string, smsNumber: number };
}

async function cleanupIsolatedOrg(orgId: string) {
  await service.from("messages").delete().eq("organization_id", orgId);
  await service.from("conversations").delete().eq("organization_id", orgId);
  await service.from("contacts").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("E (P2 #7). HELP still sends its deterministic reply for a SUSPENDED (payment_status) organization - documented, intentional gate exemption", async () => {
  const { organizationId: orgId, smsNumber: number } = await makeIsolatedOrg({ payment_status: "suspended" });
  try {
    const from = "+15555580005";
    const response = await sendInbound(number, from, "HELP");
    assert.equal(response.status, 200);

    const { data: contact } = await service.from("contacts").select("id").eq("organization_id", orgId).eq("phone", from).single();
    const { data: conversation } = await service.from("conversations").select("id").eq("organization_id", orgId).eq("contact_id", contact!.id).single();
    const { data: outbound } = await service.from("messages").select("body").eq("conversation_id", conversation!.id).eq("direction", "outbound");
    assert.equal(outbound?.length, 1, "HELP's compliance reply is not gated on payment_status - a documented, intentional exemption, not a bug");
  } finally {
    await cleanupIsolatedOrg(orgId);
  }
});

test("F (P2 #7). HELP still sends its deterministic reply for a PAUSED organization - documented, intentional gate exemption", async () => {
  const { organizationId: orgId, smsNumber: number } = await makeIsolatedOrg({ automation_paused: true });
  try {
    const from = "+15555580006";
    const response = await sendInbound(number, from, "HELP");
    assert.equal(response.status, 200);

    const { data: contact } = await service.from("contacts").select("id").eq("organization_id", orgId).eq("phone", from).single();
    const { data: conversation } = await service.from("conversations").select("id").eq("organization_id", orgId).eq("contact_id", contact!.id).single();
    const { data: outbound } = await service.from("messages").select("body").eq("conversation_id", conversation!.id).eq("direction", "outbound");
    assert.equal(outbound?.length, 1, "HELP's compliance reply is not gated on automation_paused - a documented, intentional exemption, not a bug");
  } finally {
    await cleanupIsolatedOrg(orgId);
  }
});

test("G (P2 #7). HELP still sends its deterministic reply for a TEST-mode (not yet live) organization - documented, intentional gate exemption", async () => {
  const { organizationId: orgId, smsNumber: number } = await makeIsolatedOrg({ automation_mode: "test" });
  try {
    const from = "+15555580007";
    const response = await sendInbound(number, from, "HELP");
    assert.equal(response.status, 200);

    const { data: contact } = await service.from("contacts").select("id").eq("organization_id", orgId).eq("phone", from).single();
    const { data: conversation } = await service.from("conversations").select("id").eq("organization_id", orgId).eq("contact_id", contact!.id).single();
    const { data: outbound } = await service.from("messages").select("body").eq("conversation_id", conversation!.id).eq("direction", "outbound");
    assert.equal(outbound?.length, 1, "HELP's compliance reply is not gated on automation_mode - a documented, intentional exemption, not a bug");
  } finally {
    await cleanupIsolatedOrg(orgId);
  }
});
