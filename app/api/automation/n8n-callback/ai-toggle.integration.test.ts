/**
 * Organization-level AI toggle (ai_settings.ai_enabled - "Allow AI to
 * represent this business") enforced in the n8n callback, before the
 * booking branch and the should_send/gate path. No ai_settings row means
 * disabled (getAiSettings' default). When disabled, the execution still
 * completes (blocked_reason: organization_ai_disabled) - never failed,
 * never left running - and nothing reaches the customer.
 *
 * Runs only against the test Supabase project, with disposable orgs. No real
 * SMS: the Twilio env vars are cleared, so an attempted AI send through
 * POST (which has no provider seam) fails as "not configured" without a
 * network call - the attempted message row is what distinguishes "AI
 * allowed" from "AI blocked" here. The fixed-text check uses the sendSmsFn
 * seam. HELP/STOP/START and n8n dispatch-failure handling are covered by
 * their existing suites (sms/inbound route, appointments-dispatch-failure).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/api/automation/n8n-callback/ai-toggle.integration.test.ts
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

const PRODUCTION_PROJECT_REF = "mywznmxtlgajnczjvbmk";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!SUPABASE_URL || SUPABASE_URL.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error("Refusing to run: ai-toggle.integration.test.ts only runs against the test Supabase project, never production.");
}

delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { findOrCreateOpenConversation }: typeof import("@/lib/conversations/queries") = require(path.join(REPO_ROOT, "lib/conversations/queries.ts"));
const { emitAppointmentLifecycleEventAsService }: typeof import("@/lib/automation/appointments") = require(path.join(REPO_ROOT, "lib/automation/appointments.ts"));
const { NextRequest } = require("next/server");
const { POST }: typeof import("./route") = require(path.join(REPO_ROOT, "app/api/automation/n8n-callback/route.ts"));

const service = createServiceRoleClient();
const SECRET = process.env.N8N_WEBHOOK_SECRET!;
const CALLBACK_URL = "http://localhost/api/automation/n8n-callback";
const VALID_BODY = "Thanks for reaching out! Could you share the property address so we can help?";

function callback(body: unknown) {
  return new NextRequest(CALLBACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trackpr-webhook-secret": SECRET },
    body: JSON.stringify(body),
  });
}

function aiResult(overrides: Record<string, unknown> = {}) {
  return {
    should_send: true,
    response_message: VALID_BODY,
    qualification_status: "qualified",
    missing_information: [],
    urgency: "normal",
    needs_human: false,
    model: "test-model",
    intent: "ai-toggle-test-intent",
    summary: "ai-toggle test summary",
    booking_intent: null,
    usage: null,
    ...overrides,
  };
}

type Org = { id: string; contactId: string };
let enabledOrg: Org;
let disabledRowOrg: Org;
let noRowOrg: Org;
const orgIds: string[] = [];

async function makeOrg(name: string, aiEnabled: boolean | null, phone: string): Promise<Org> {
  const { data: org, error } = await service.from("organizations").insert({ name, payment_status: "active", automation_mode: "live", timezone: "UTC" }).select("id").single();
  if (error) throw error;
  orgIds.push(org!.id);
  if (aiEnabled !== null) {
    const { error: aiError } = await service.from("ai_settings").insert({ organization_id: org!.id, ai_enabled: aiEnabled });
    if (aiError) throw aiError;
  }
  const { data: contact, error: contactError } = await service.from("contacts").insert({ organization_id: org!.id, first_name: "Toggle", last_name: "Test", phone }).select("id").single();
  if (contactError) throw contactError;
  return { id: org!.id, contactId: contact!.id };
}

async function makeExecution(org: Org, contactId = org.contactId) {
  const conversation = await findOrCreateOpenConversation(service, org.id, contactId, "sms");
  if (!conversation) throw new Error("failed to find/create test conversation");
  const { data: event, error: eventError } = await service
    .from("automation_events")
    .insert({ organization_id: org.id, event_type: "customer.message.received", entity_type: "conversation", entity_id: conversation.id, status: "processing", payload: { contact_id: contactId, conversation_id: conversation.id, lead_id: null } })
    .select("id")
    .single();
  if (eventError) throw eventError;
  const { data: execution, error } = await service
    .from("workflow_executions")
    .insert({ organization_id: org.id, automation_event_id: event!.id, workflow_name: "customer_reply_followup", status: "running", attempt: 1 })
    .select("id")
    .single();
  if (error) throw error;
  return { executionId: execution!.id as string, eventId: event!.id as string, conversationId: conversation.id };
}

async function post(org: Org, ids: { executionId: string; eventId: string }, result: Record<string, unknown>) {
  const response = await POST(callback({ execution_id: ids.executionId, event_id: ids.eventId, organization_id: org.id, ai_result: result }));
  return { status: response.status, json: await response.json() };
}

async function execution(id: string) {
  const { data } = await service.from("workflow_executions").select("status, error_message, metadata").eq("id", id).single();
  return data as { status: string; error_message: string | null; metadata: Record<string, unknown> };
}

async function messageCount(executionId: string) {
  const { count } = await service.from("messages").select("id", { count: "exact", head: true }).eq("workflow_execution_id", executionId);
  return count ?? 0;
}

async function incidentCount(organizationId: string, since: string) {
  const { count } = await service.from("automation_incidents").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).gte("created_at", since);
  return count ?? 0;
}

async function assertBlockedByOrganizationAi(org: Org) {
  const since = new Date().toISOString();
  const ids = await makeExecution(org);
  const { status, json } = await post(org, ids, aiResult());

  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, sent: false, blockedReason: "organization_ai_disabled" });

  const row = await execution(ids.executionId);
  assert.equal(row.status, "completed");
  assert.equal(row.error_message, null);
  assert.equal(row.metadata.should_send, false);
  assert.equal(row.metadata.blocked_reason, "organization_ai_disabled");
  assert.equal(row.metadata.intent, "ai-toggle-test-intent");
  assert.equal(row.metadata.summary, "ai-toggle test summary");
  assert.equal(row.metadata.needs_human, false);

  const { data: event } = await service.from("automation_events").select("status").eq("id", ids.eventId).single();
  assert.equal(event!.status, "completed");
  assert.equal(await messageCount(ids.executionId), 0);
  assert.equal(await incidentCount(org.id, since), 0);

  const { count: interactions } = await service.from("ai_interactions").select("id", { count: "exact", head: true }).eq("workflow_execution_id", ids.executionId);
  assert.equal(interactions, 1, "the AI interaction is still recorded");
}

before(async () => {
  enabledOrg = await makeOrg("AI Toggle Test Org (Enabled)", true, "+15555550611");
  disabledRowOrg = await makeOrg("AI Toggle Test Org (Disabled Row)", false, "+15555550612");
  noRowOrg = await makeOrg("AI Toggle Test Org (No Row)", null, "+15555550613");
});

after(async () => {
  for (const id of orgIds) {
    await service.from("messages").delete().eq("organization_id", id);
    await service.from("automation_incidents").delete().eq("organization_id", id);
    await service.from("ai_interactions").delete().eq("organization_id", id);
    await service.from("workflow_executions").delete().eq("organization_id", id);
    await service.from("automation_events").delete().eq("organization_id", id);
    await service.from("appointments").delete().eq("organization_id", id);
    await service.from("conversations").delete().eq("organization_id", id);
    await service.from("contacts").delete().eq("organization_id", id);
    await service.from("ai_settings").delete().eq("organization_id", id);
    await service.from("organizations").delete().eq("id", id);
  }
});

test("1. organization AI enabled + should_send: the existing send path runs (message attempted), never organization_ai_disabled", async () => {
  const ids = await makeExecution(enabledOrg);
  const { status, json } = await post(enabledOrg, ids, aiResult());

  assert.equal(status, 200);
  assert.notEqual(json.blockedReason, "organization_ai_disabled");
  assert.equal(await messageCount(ids.executionId), 1, "the send was attempted through sendOutboundMessage");
  assert.notEqual((await execution(ids.executionId)).metadata?.blocked_reason, "organization_ai_disabled");
});

test("2. organization AI disabled (explicit row): no message, execution completed with blocked_reason organization_ai_disabled, no incident", async () => {
  await assertBlockedByOrganizationAi(disabledRowOrg);
});

test("3. organization AI disabled because no ai_settings row exists: identical behavior", async () => {
  await assertBlockedByOrganizationAi(noRowOrg);
});

test("4. organization AI disabled + booking intents: no appointment is created, cancelled, or rescheduled", async () => {
  const { data: appointment, error } = await service
    .from("appointments")
    .insert({ organization_id: disabledRowOrg.id, contact_id: disabledRowOrg.contactId, title: "Existing visit", start_at: "2027-03-01T15:00:00.000Z", end_at: "2027-03-01T16:00:00.000Z", status: "scheduled" })
    .select("id, start_at, end_at, status")
    .single();
  if (error) throw error;
  const { count: beforeCount } = await service.from("appointments").select("id", { count: "exact", head: true }).eq("organization_id", disabledRowOrg.id);

  const intents = [
    { action: "book", date_range_start: null, date_range_end: null, start_at: "2027-03-02T15:00:00.000Z", end_at: "2027-03-02T16:00:00.000Z", title: "AI booked visit" },
    { action: "cancel", date_range_start: null, date_range_end: null, start_at: null, end_at: null, title: null, appointment_id: appointment!.id },
    { action: "reschedule", date_range_start: null, date_range_end: null, start_at: "2027-03-03T15:00:00.000Z", end_at: "2027-03-03T16:00:00.000Z", title: null, appointment_id: appointment!.id },
  ];
  for (const bookingIntent of intents) {
    const ids = await makeExecution(disabledRowOrg);
    const { json } = await post(disabledRowOrg, ids, aiResult({ should_send: false, response_message: null, booking_intent: bookingIntent }));
    assert.equal(json.blockedReason, "organization_ai_disabled", `booking action ${bookingIntent.action}`);
    assert.equal((await execution(ids.executionId)).status, "completed");
    assert.equal(await messageCount(ids.executionId), 0);
  }

  const { count: afterCount } = await service.from("appointments").select("id", { count: "exact", head: true }).eq("organization_id", disabledRowOrg.id);
  assert.equal(afterCount, beforeCount, "no appointment created");
  const { data: unchanged } = await service.from("appointments").select("start_at, end_at, status").eq("id", appointment!.id).single();
  assert.equal(unchanged!.status, "scheduled", "not cancelled");
  assert.equal(new Date(unchanged!.start_at).toISOString(), new Date(appointment!.start_at).toISOString(), "not rescheduled");
  assert.equal(new Date(unchanged!.end_at).toISOString(), new Date(appointment!.end_at).toISOString(), "not rescheduled");
});

test("5. organization isolation: organization A disabled is blocked while organization B enabled is unaffected", async () => {
  const a = await makeExecution(noRowOrg);
  const b = await makeExecution(enabledOrg);
  const aResult = await post(noRowOrg, a, aiResult());
  const bResult = await post(enabledOrg, b, aiResult());

  assert.equal(aResult.json.blockedReason, "organization_ai_disabled");
  assert.equal(await messageCount(a.executionId), 0);
  assert.notEqual(bResult.json.blockedReason, "organization_ai_disabled");
  assert.equal(await messageCount(b.executionId), 1);
});

test("6. organization AI enabled + conversation AI disabled: the existing conversation_ai_disabled gate denial is unchanged", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: enabledOrg.id, first_name: "Locked", last_name: "Conversation", phone: "+15555550614" }).select("id").single();
  const ids = await makeExecution(enabledOrg, contact!.id);
  await service.from("conversations").update({ ai_enabled: false }).eq("id", ids.conversationId);

  const { status, json } = await post(enabledOrg, ids, aiResult());
  assert.equal(status, 200);
  assert.equal(json.blockedReason, "conversation_ai_disabled");
  const row = await execution(ids.executionId);
  assert.equal(row.status, "completed");
  assert.equal(row.metadata.blocked_reason, "conversation_ai_disabled");
  assert.equal(await messageCount(ids.executionId), 0);
});

test("7. organization AI disabled does not block fixed (non-AI) texts: an appointment cancellation text still sends", async () => {
  const { data: appointment, error } = await service
    .from("appointments")
    .insert({ organization_id: noRowOrg.id, contact_id: noRowOrg.contactId, title: "Cancelled visit", start_at: "2027-04-01T15:00:00.000Z", end_at: "2027-04-01T16:00:00.000Z", status: "cancelled" })
    .select("id")
    .single();
  if (error) throw error;

  const sid = `SMtest${Date.now()}`;
  await emitAppointmentLifecycleEventAsService(service, noRowOrg.id, appointment!.id, "appointment.cancelled", undefined, async () => ({ ok: true, providerMessageId: sid }));

  const { data: message } = await service.from("messages").select("status, provider_message_id").eq("provider_message_id", sid).maybeSingle();
  assert.ok(message, "the cancellation text was sent");
  assert.equal(message!.status, "sent");
});
