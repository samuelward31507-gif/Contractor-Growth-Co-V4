/**
 * Outbound SMS destination: contacts.phone is stored as typed (often a bare
 * 10-digit US number), while contacts.phone_normalized holds the E.164 form
 * every contact writer keeps in sync. sendOutboundMessage and the outbound
 * gate now use phone_normalized when present, falling back to phone for rows
 * that predate it - so a contact typed as "5555550199" is reachable, while a
 * genuinely invalid number is still rejected exactly as before.
 *
 * Runs only against the test Supabase project, with a disposable org. No
 * real SMS: the sendSmsFn seam captures the destination, and the Twilio env
 * vars are cleared.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/messaging/outbound-normalized-phone.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
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

const PRODUCTION_PROJECT_REF = "mywznmxtlgajnczjvbmk";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!SUPABASE_URL || SUPABASE_URL.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error("Refusing to run: outbound-normalized-phone.integration.test.ts only runs against the test Supabase project, never production.");
}

delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const require = createRequire(import.meta.url);
const { sendOutboundMessage }: typeof import("./outbound") = require("./outbound.ts");
const { evaluateOutboundGate }: typeof import("../automation/outbound-gate") = require("../automation/outbound-gate.ts");

const service = createSupabaseClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

const VALID_BODY = "Thanks for reaching out! Could you share the property address so we can help?";
let organizationId: string;

async function makeContact(phone: string | null, phoneNormalized: string | null) {
  const { data: contact, error } = await service
    .from("contacts")
    .insert({ organization_id: organizationId, first_name: "Phone", last_name: "Shape", phone, phone_normalized: phoneNormalized })
    .select("id")
    .single();
  if (error) throw error;
  const { data: conversation, error: conversationError } = await service
    .from("conversations")
    .insert({ organization_id: organizationId, contact_id: contact!.id, channel: "sms", status: "open" })
    .select("id")
    .single();
  if (conversationError) throw conversationError;
  return { contactId: contact!.id as string, conversationId: conversation!.id as string };
}

async function makeExecution() {
  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: organizationId, event_type: "lead.created", entity_type: "lead", entity_id: null, payload: {}, status: "processing" })
    .select("id")
    .single();
  const { data: execution } = await service
    .from("workflow_executions")
    .insert({ organization_id: organizationId, automation_event_id: event!.id, workflow_name: "lead_created_followup", status: "running", attempt: 1 })
    .select("id")
    .single();
  return execution!.id as string;
}

function capturingSend() {
  const calls: string[] = [];
  const fn = async (input: { to: string }) => {
    calls.push(input.to);
    return { ok: true as const, providerMessageId: `SMtest${Date.now()}${calls.length}` };
  };
  return { calls, fn };
}

async function gate(ids: { contactId: string; conversationId: string }) {
  return evaluateOutboundGate(service, {
    organizationId,
    executionId: await makeExecution(),
    contactId: ids.contactId,
    conversationId: ids.conversationId,
    leadId: null,
    aiResult: { should_send: true, response_message: VALID_BODY, needs_human: false },
  });
}

before(async () => {
  const { data: org, error } = await service
    .from("organizations")
    .insert({ name: "Outbound Normalized Phone Test Org", automation_mode: "live", payment_status: "active" })
    .select("id")
    .single();
  if (error) throw error;
  organizationId = org!.id;
});

after(async () => {
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("workflow_executions").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("1. contact stored as 10 digits with a valid E.164 phone_normalized: the gate allows it and the send seam receives the E.164 number", async () => {
  const ids = await makeContact("5555550199", "+15555550199");

  const gateResult = await gate(ids);
  assert.equal(gateResult.allowed, true, JSON.stringify(gateResult));

  const send = capturingSend();
  const result = await sendOutboundMessage(service, { organizationId, contactId: ids.contactId, conversationId: ids.conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", sendSmsFn: send.fn });
  assert.equal(result.ok, true);
  assert.deepEqual(send.calls, ["+15555550199"]);
});

test("2. genuinely invalid number (no phone_normalized): the gate still denies invalid_destination", async () => {
  const ids = await makeContact("12345", null);

  const gateResult = await gate(ids);
  assert.deepEqual(gateResult, { allowed: false, reason: "invalid_destination", detail: undefined });
});

test("3. invalid 10-digit-looking legacy row with no phone_normalized is unchanged: the gate denies it and sendOutboundMessage passes the stored value through as before", async () => {
  const ids = await makeContact("5551234567", null);

  const gateResult = await gate(ids);
  assert.equal(gateResult.allowed, false);
  if (!gateResult.allowed) assert.equal(gateResult.reason, "invalid_destination");

  const send = capturingSend();
  await sendOutboundMessage(service, { organizationId, contactId: ids.contactId, conversationId: ids.conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", sendSmsFn: send.fn });
  assert.deepEqual(send.calls, ["5551234567"], "no normalization is invented for rows without phone_normalized");
});

test("4. existing E.164 phone with no phone_normalized (legacy/seeded row): still allowed and sent to the stored E.164 number", async () => {
  const ids = await makeContact("+15555550198", null);

  const gateResult = await gate(ids);
  assert.equal(gateResult.allowed, true, JSON.stringify(gateResult));

  const send = capturingSend();
  const result = await sendOutboundMessage(service, { organizationId, contactId: ids.contactId, conversationId: ids.conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", sendSmsFn: send.fn });
  assert.equal(result.ok, true);
  assert.deepEqual(send.calls, ["+15555550198"]);
});

test("5. existing E.164 phone with matching phone_normalized: unchanged", async () => {
  const ids = await makeContact("+15555550197", "+15555550197");

  const gateResult = await gate(ids);
  assert.equal(gateResult.allowed, true, JSON.stringify(gateResult));

  const send = capturingSend();
  const result = await sendOutboundMessage(service, { organizationId, contactId: ids.contactId, conversationId: ids.conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", sendSmsFn: send.fn });
  assert.equal(result.ok, true);
  assert.deepEqual(send.calls, ["+15555550197"]);
});

test("6. no phone at all: the existing 'no phone number on file' error is unchanged", async () => {
  const ids = await makeContact(null, null);

  const send = capturingSend();
  const result = await sendOutboundMessage(service, { organizationId, contactId: ids.contactId, conversationId: ids.conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", sendSmsFn: send.fn });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "The contact has no phone number on file.");
  assert.deepEqual(send.calls, []);
});
