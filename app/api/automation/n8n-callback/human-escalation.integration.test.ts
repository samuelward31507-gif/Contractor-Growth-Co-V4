/**
 * HANDOFF-01 (pre-launch lead-leak audit): integration tests proving every
 * needs_human lockout in app/api/automation/n8n-callback/route.ts also
 * persists a queryable, resolvable automation_incidents row (category
 * "human_escalation_requested"), additively alongside the existing
 * conversations.ai_enabled lockout and notifyFounder() call - neither of
 * which this feature changes. Calls POST()/handleBookingIntent() directly
 * against a real, disposable Supabase organization, the same established
 * pattern as booking.integration.test.ts/usage.integration.test.ts in this
 * same directory.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/api/automation/n8n-callback/human-escalation.integration.test.ts
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
const { findOrCreateOpenConversation }: typeof import("@/lib/conversations/queries") = require(path.join(REPO_ROOT, "lib/conversations/queries.ts"));
const { NextRequest } = require("next/server");
const { POST, handleBookingIntent }: typeof import("./route") = require(path.join(REPO_ROOT, "app/api/automation/n8n-callback/route.ts"));

function fakeSendSms() {
  return async () => ({ ok: true as const, providerMessageId: `FAKE-${Date.now()}-${Math.random()}` });
}

const service = createServiceRoleClient();
const SECRET = process.env.N8N_WEBHOOK_SECRET!;
const CALLBACK_URL = "http://localhost/api/automation/n8n-callback";

function callback(body: unknown) {
  return new NextRequest(CALLBACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trackpr-webhook-secret": SECRET },
    body: JSON.stringify(body),
  });
}

let organizationId: string;
let otherOrgId: string;
let contactId: string;
let leadId: string;

async function makeExecution(orgId: string, cId: string, lId: string | null) {
  const conversation = await findOrCreateOpenConversation(service, orgId, cId, "sms", lId ?? undefined);
  const { data: event } = await service
    .from("automation_events")
    .insert({
      organization_id: orgId,
      event_type: "customer.message.received",
      entity_type: "conversation",
      entity_id: conversation!.id,
      status: "processing",
      payload: { contact_id: cId, conversation_id: conversation!.id, lead_id: lId },
    })
    .select("id")
    .single();
  const { data: execution } = await service
    .from("workflow_executions")
    .insert({ organization_id: orgId, automation_event_id: event!.id, workflow_name: "customer_reply_followup", status: "running", attempt: 1 })
    .select("id")
    .single();
  return { executionId: execution!.id as string, eventId: event!.id as string, conversationId: conversation!.id as string };
}

function baseAiResult(overrides: Record<string, unknown> = {}) {
  return {
    should_send: false,
    response_message: null,
    qualification_status: "needs_human",
    missing_information: [],
    urgency: "normal",
    needs_human: true,
    model: "test-model",
    intent: "general",
    summary: "The customer is asking for something the AI can't safely handle.",
    booking_intent: null,
    ...overrides,
  };
}

async function findEscalationIncident(orgId: string, conversationId: string) {
  const { data } = await service
    .from("automation_incidents")
    .select("id, status, category, severity, occurrence_count, workflow_execution_id, metadata, description")
    .eq("organization_id", orgId)
    .eq("category", "human_escalation_requested")
    .eq("fingerprint", `human_escalation_requested:${conversationId}`)
    .maybeSingle();
  return data;
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "HANDOFF-01 Test Org", payment_status: "active", automation_mode: "live", timezone: "UTC" }).select("id").single();
  organizationId = org!.id;

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Jane", last_name: "Doe", phone: "+15555550701" }).select("id").single();
  contactId = contact!.id;

  const { data: lead } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contactId, service: "Test", status: "qualified", temperature: "warm" }).select("id").single();
  leadId = lead!.id;

  // Deliberately no booking_settings row - getAvailableBookingSlots/
  // bookAppointment both fail closed to "booking_disabled" with no row,
  // which is exactly the escalating failure reason both booking branches
  // below need to reach their own needs_human lock.
  const { data: other } = await service.from("organizations").insert({ name: "HANDOFF-01 Test Org (Other)", payment_status: "active", automation_mode: "live" }).select("id").single();
  otherOrgId = other!.id;
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("automation_incidents").delete().eq("organization_id", orgId);
    await service.from("ai_interactions").delete().eq("organization_id", orgId);
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("appointments").delete().eq("organization_id", orgId);
    await service.from("leads").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("A1. main qualification needs_human creates a human_escalation_requested incident alongside the existing ai_enabled lockout", async () => {
  const { executionId, eventId, conversationId } = await makeExecution(organizationId, contactId, leadId);

  await POST(callback({ execution_id: executionId, event_id: eventId, organization_id: organizationId, ai_result: baseAiResult() }));

  const { data: conversation } = await service.from("conversations").select("ai_enabled").eq("id", conversationId).single();
  assert.equal(conversation?.ai_enabled, false, "existing ai_enabled lockout must still fire, unchanged");

  const incident = await findEscalationIncident(organizationId, conversationId);
  assert.ok(incident, "expected a persisted human_escalation_requested incident");
  assert.equal(incident?.status, "open");
  assert.equal(incident?.severity, "warning");
  assert.equal(incident?.occurrence_count, 1);
  assert.equal(incident?.workflow_execution_id, executionId);
  const metadata = incident?.metadata as { conversationId?: string; contactId?: string; leadId?: string };
  assert.equal(metadata.conversationId, conversationId);
  assert.equal(metadata.contactId, contactId);
  assert.equal(metadata.leadId, leadId);
});

test("A2. a replayed/duplicate needs_human callback for an already-locked conversation does not create a second open incident", async () => {
  const { conversationId } = await makeExecution(organizationId, contactId, leadId);

  // First lock: a fresh execution against the same conversation.
  const first = await makeExecution(organizationId, contactId, leadId);
  await POST(callback({ execution_id: first.executionId, event_id: first.eventId, organization_id: organizationId, ai_result: baseAiResult() }));

  // Second, different execution but the SAME conversation - the conditional
  // `.eq("ai_enabled", true)` UPDATE is already false, so this must be a
  // pure no-op on both the lockout and the incident.
  const second = await makeExecution(organizationId, contactId, leadId);
  await POST(callback({ execution_id: second.executionId, event_id: second.eventId, organization_id: organizationId, ai_result: baseAiResult() }));

  const { data: incidents } = await service
    .from("automation_incidents")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("category", "human_escalation_requested")
    .eq("fingerprint", `human_escalation_requested:${first.conversationId}`);
  assert.equal(incidents?.length, 1, "a replayed lockout attempt must never create a second incident row");
  void conversationId;
});

test("B. booking check_availability escalation (booking_disabled) creates a human_escalation_requested incident", async () => {
  const { executionId, conversationId } = await makeExecution(organizationId, contactId, leadId);

  const response = await handleBookingIntent(
    service,
    {
      organizationId,
      executionId,
      contactId,
      leadId,
      conversationId,
      bookingIntent: { action: "check_availability", date_range_start: "2027-03-01T00:00:00.000Z", date_range_end: "2027-03-02T00:00:00.000Z", start_at: null, end_at: null, title: "Consult" },
    },
    fakeSendSms(),
  );
  const json = await response.json();
  assert.equal(json.booking.status, "booking_disabled");

  const { data: conversation } = await service.from("conversations").select("ai_enabled").eq("id", conversationId).single();
  assert.equal(conversation?.ai_enabled, false);

  const incident = await findEscalationIncident(organizationId, conversationId);
  assert.ok(incident, "expected a persisted human_escalation_requested incident for the check_availability failure path");
  assert.equal(incident?.status, "open");
});

test("C. booking book-action escalation (booking_disabled) creates a human_escalation_requested incident", async () => {
  const { executionId, conversationId } = await makeExecution(organizationId, contactId, leadId);

  await handleBookingIntent(
    service,
    {
      organizationId,
      executionId,
      contactId,
      leadId,
      conversationId,
      bookingIntent: { action: "book", date_range_start: null, date_range_end: null, start_at: "2027-03-01T09:00:00.000Z", end_at: "2027-03-01T10:00:00.000Z", title: "Consult" },
    },
    fakeSendSms(),
  );

  const { data: conversation } = await service.from("conversations").select("ai_enabled").eq("id", conversationId).single();
  assert.equal(conversation?.ai_enabled, false);

  const incident = await findEscalationIncident(organizationId, conversationId);
  assert.ok(incident, "expected a persisted human_escalation_requested incident for the book failure path");
  assert.equal(incident?.status, "open");
});

test("F. organization isolation: org A's escalation incident is never visible under org B", async () => {
  const { executionId, eventId, conversationId } = await makeExecution(organizationId, contactId, leadId);
  await POST(callback({ execution_id: executionId, event_id: eventId, organization_id: organizationId, ai_result: baseAiResult() }));

  const { data: crossOrgRead } = await service
    .from("automation_incidents")
    .select("id")
    .eq("organization_id", otherOrgId)
    .eq("category", "human_escalation_requested")
    .eq("fingerprint", `human_escalation_requested:${conversationId}`);
  assert.equal(crossOrgRead?.length, 0, "an org A escalation must never be readable scoped under org B");
});

test("G. regression: a non-escalating needs_human=false turn creates no incident and leaves ai_enabled untouched", async () => {
  // Deliberately its own, never-before-touched contact/conversation - every
  // other test in this file shares `contactId`'s single open conversation
  // via findOrCreateOpenConversation, and several of them intentionally
  // lock it, so reusing that same contact here would race this assertion
  // against those tests' own side effects rather than testing this turn in
  // isolation.
  const { data: freshContact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "No", last_name: "Escalation", phone: "+15555550799" }).select("id").single();
  const freshContactId = freshContact!.id as string;
  const { executionId, eventId, conversationId } = await makeExecution(organizationId, freshContactId, null);

  await POST(
    callback({
      execution_id: executionId,
      event_id: eventId,
      organization_id: organizationId,
      ai_result: baseAiResult({ needs_human: false, qualification_status: "qualified", should_send: false }),
    }),
  );

  const { data: conversation } = await service.from("conversations").select("ai_enabled").eq("id", conversationId).single();
  assert.equal(conversation?.ai_enabled, true, "a normal turn must never lock the conversation");

  const incident = await findEscalationIncident(organizationId, conversationId);
  assert.equal(incident, null, "a non-escalating turn must never create an incident");
});
