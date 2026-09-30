/**
 * Pass 6: sendOutboundMessage records the provider's result on its message
 * row even when the caller is a signed-in user session. `messages` has no
 * RLS UPDATE policy, so before the fix a session caller's post-send update
 * matched zero rows and left the message `queued` (confirmed in Production:
 * five estimate follow-up Retry messages from 2026-09-28).
 *
 * Runs only against the test Supabase project, with disposable orgs/users.
 * No real SMS is ever sent: every direct send uses the sendSmsFn seam, and
 * the Twilio env vars are cleared so the one path without that seam
 * (retryEstimateWorkflow) fails as "not configured" without a network call.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/messaging/outbound-session-status.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
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
  throw new Error("Refusing to run: outbound-session-status.integration.test.ts only runs against the test Supabase project, never production.");
}

delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const require = createRequire(import.meta.url);
const { sendOutboundMessage, recordProviderOutcome }: typeof import("./outbound") = require("./outbound.ts");
const { retryWorkflowExecution }: typeof import("../automation/retry") = require("../automation/retry.ts");

const options = { auth: { autoRefreshToken: false, persistSession: false } };
const service = createSupabaseClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
const anon = createSupabaseClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, options);

const VALID_PHONE = "+15555550199"; // NANPA-reserved fictional-use number, never a real subscriber.
const VALID_BODY = "Just checking in on the estimate we sent over.";

const failingSend = async () => ({ ok: false as const, error: "The SMS provider rejected the request." });
const fakeSend = (sid: string) => async () => ({ ok: true as const, providerMessageId: sid });

let orgId: string;
let otherOrgId: string;
let userId: string;
let contactId: string;
let conversationId: string;
let otherContactId: string;
let session: SupabaseClient;

async function makeExecution(organizationId: string, workflowName = "lead_created_followup") {
  const { data: event, error: eventError } = await service
    .from("automation_events")
    .insert({ organization_id: organizationId, event_type: "lead.created", entity_type: "lead", entity_id: null, payload: {}, status: "processing" })
    .select("id")
    .single();
  if (eventError) throw eventError;
  const { data: execution, error } = await service
    .from("workflow_executions")
    .insert({ organization_id: organizationId, automation_event_id: event!.id, workflow_name: workflowName, status: "running", attempt: 1 })
    .select("id")
    .single();
  if (error) throw error;
  return execution!.id as string;
}

async function readMessage(id: string) {
  const { data } = await service.from("messages").select("id, status, status_reason, provider_message_id, organization_id").eq("id", id).single();
  return data!;
}

async function insertMessage(status: "queued" | "sent" | "failed") {
  const { data, error } = await service
    .from("messages")
    .insert({ organization_id: orgId, conversation_id: conversationId, direction: "outbound", sender_type: "ai", body: VALID_BODY, status })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

before(async () => {
  const { data: org, error: orgError } = await service
    .from("organizations")
    .insert({ name: "Outbound Session Status Test Org", automation_mode: "live", payment_status: "active" })
    .select("id")
    .single();
  if (orgError) throw orgError;
  orgId = org!.id;

  const { data: other, error: otherError } = await service
    .from("organizations")
    .insert({ name: "Outbound Session Status Test Org (Other)", automation_mode: "live", payment_status: "active" })
    .select("id")
    .single();
  if (otherError) throw otherError;
  otherOrgId = other!.id;

  const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, first_name: "Session", last_name: "Send", phone: VALID_PHONE }).select("id").single();
  contactId = contact!.id;
  const { data: conversation } = await service.from("conversations").insert({ organization_id: orgId, contact_id: contactId, channel: "sms", status: "open" }).select("id").single();
  conversationId = conversation!.id;
  const { data: otherContact } = await service.from("contacts").insert({ organization_id: otherOrgId, first_name: "Other", last_name: "Org", phone: VALID_PHONE }).select("id").single();
  otherContactId = otherContact!.id;

  const email = `outbound-session-status-${Date.now()}@example.com`;
  const password = "a-real-test-password-123";
  const { data: user, error: userError } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw userError;
  userId = user.user!.id;
  const { error: memberError } = await service.from("organization_members").insert({ organization_id: orgId, user_id: userId, role: "owner" });
  if (memberError) throw memberError;

  const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  if (signInError || !signIn.session) throw signInError ?? new Error("no session");
  session = createSupabaseClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    ...options,
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  });
});

after(async () => {
  await service.from("organizations").delete().eq("id", orgId);
  await service.from("organizations").delete().eq("id", otherOrgId);
  if (userId) await service.auth.admin.deleteUser(userId);
});

test("1. signed-in session + provider failure: message ends failed with the failure reason, never left queued", async () => {
  const executionId = await makeExecution(orgId);
  const result = await sendOutboundMessage(session, { organizationId: orgId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: executionId, sendSmsFn: failingSend });

  assert.equal(result.ok, false);
  assert.ok(result.messageId);
  const message = await readMessage(result.messageId!);
  assert.equal(message.status, "failed");
  assert.equal(message.status_reason, "The SMS provider rejected the request.");
  assert.equal(message.provider_message_id, null);
});

test("2. signed-in session + provider success: message ends sent with provider_message_id, never left queued", async () => {
  const executionId = await makeExecution(orgId);
  const sid = `SMtest${randomUUID().replace(/-/g, "")}`;
  const result = await sendOutboundMessage(session, { organizationId: orgId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: executionId, sendSmsFn: fakeSend(sid) });

  assert.equal(result.ok, true);
  const message = await readMessage(result.messageId!);
  assert.equal(message.status, "sent");
  assert.equal(message.provider_message_id, sid);
});

test("3. service-role caller: failure and success behave exactly as before", async () => {
  const failedExecution = await makeExecution(orgId);
  const failed = await sendOutboundMessage(service, { organizationId: orgId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: failedExecution, sendSmsFn: failingSend });
  assert.equal(failed.ok, false);
  const failedMessage = await readMessage(failed.messageId!);
  assert.equal(failedMessage.status, "failed");
  assert.equal(failedMessage.status_reason, "The SMS provider rejected the request.");

  const sentExecution = await makeExecution(orgId);
  const sid = `SMtest${randomUUID().replace(/-/g, "")}`;
  const sent = await sendOutboundMessage(service, { organizationId: orgId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: sentExecution, sendSmsFn: fakeSend(sid) });
  assert.equal(sent.ok, true);
  const sentMessage = await readMessage(sent.messageId!);
  assert.equal(sentMessage.status, "sent");
  assert.equal(sentMessage.provider_message_id, sid);
});

test("4a. narrow update: a queued row in the matching organization transitions", async () => {
  const id = await insertMessage("queued");
  assert.equal(await recordProviderOutcome(id, orgId, { status: "failed", status_reason: "reason" }), true);
  assert.equal((await readMessage(id)).status, "failed");
});

test("4b. narrow update: a mismatched organization id changes nothing", async () => {
  const id = await insertMessage("queued");
  assert.equal(await recordProviderOutcome(id, otherOrgId, { status: "failed", status_reason: "reason" }), false);
  const message = await readMessage(id);
  assert.equal(message.status, "queued");
  assert.equal(message.status_reason, null);
});

test("4c. narrow update: rows already sent or failed are never rewritten", async () => {
  const sentId = await insertMessage("sent");
  assert.equal(await recordProviderOutcome(sentId, orgId, { status: "failed", status_reason: "should not apply" }), false);
  assert.equal((await readMessage(sentId)).status, "sent");

  const failedId = await insertMessage("failed");
  assert.equal(await recordProviderOutcome(failedId, orgId, { status: "sent", provider_message_id: `SMtest${randomUUID().replace(/-/g, "")}` }), false);
  const failedMessage = await readMessage(failedId);
  assert.equal(failedMessage.status, "failed");
  assert.equal(failedMessage.provider_message_id, null);
});

test("4d. narrow update: only the targeted row changes, never its neighbors", async () => {
  const target = await insertMessage("queued");
  const neighbor = await insertMessage("queued");
  assert.equal(await recordProviderOutcome(target, orgId, { status: "failed", status_reason: "reason" }), true);
  assert.equal((await readMessage(neighbor)).status, "queued");
});

test("5a. permissions unchanged: a signed-in user still cannot directly UPDATE messages (zero rows, row untouched)", async () => {
  const id = await insertMessage("queued");
  const { data, error } = await session.from("messages").update({ status: "failed", status_reason: "direct user update" }).eq("id", id).select("id");
  assert.equal(error, null);
  assert.deepEqual(data, []);
  const message = await readMessage(id);
  assert.equal(message.status, "queued");
  assert.equal(message.status_reason, null);
});

test("5b. organization isolation unchanged: a signed-in user cannot send to another organization's contact, and no row is written there", async () => {
  const { count: before } = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", otherOrgId);
  const result = await sendOutboundMessage(session, { organizationId: otherOrgId, contactId: otherContactId, channel: "sms", body: VALID_BODY, senderType: "user", sendSmsFn: async () => {
    throw new Error("provider must never be called for another organization's contact");
  } });
  assert.equal(result.ok, false);
  assert.equal(result.messageId, null);
  const { count: afterCount } = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", otherOrgId);
  assert.equal(afterCount, before);
});

test("6. end-to-end estimate Retry under a signed-in session with a provider failure: execution failed AND its message failed, not queued", async () => {
  const { data: estimate, error: estimateError } = await service
    .from("estimates")
    .insert({ organization_id: orgId, contact_id: contactId, title: "Retry regression estimate", amount: 8500, status: "sent", sent_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() })
    .select("id")
    .single();
  if (estimateError) throw estimateError;

  const { data: event, error: eventError } = await service
    .from("automation_events")
    .insert({ organization_id: orgId, event_type: "estimate.followup", entity_type: "estimate", entity_id: estimate!.id, payload: { estimate_id: estimate!.id, contact_id: contactId, lead_id: null, occurrence: 1 }, status: "failed" })
    .select("id")
    .single();
  if (eventError) throw eventError;
  const { data: original, error: originalError } = await service
    .from("workflow_executions")
    .insert({ organization_id: orgId, automation_event_id: event!.id, workflow_name: "estimate_followup", status: "failed", attempt: 1, error_message: "The SMS provider rejected the request.", completed_at: new Date().toISOString() })
    .select("id")
    .single();
  if (originalError) throw originalError;

  const retry = await retryWorkflowExecution(session, orgId, original!.id);
  assert.equal(retry.ok, true, JSON.stringify(retry));

  const { data: retryExecution } = await service
    .from("workflow_executions")
    .select("id, status, attempt, trigger_source, error_message")
    .eq("automation_event_id", event!.id)
    .eq("attempt", 2)
    .single();
  assert.equal(retryExecution!.status, "failed");
  assert.equal(retryExecution!.trigger_source, "retry");

  const { data: messages } = await service.from("messages").select("id, status, status_reason").eq("workflow_execution_id", retryExecution!.id);
  assert.equal(messages!.length, 1);
  assert.equal(messages![0].status, "failed");
  assert.equal(messages![0].status_reason, retryExecution!.error_message);
});

test("7. duplicate-send protection: after a successful signed-in send, a second attempt for the same execution resolves to the existing sent message", async () => {
  const executionId = await makeExecution(orgId);
  const sid = `SMtest${randomUUID().replace(/-/g, "")}`;
  const first = await sendOutboundMessage(session, { organizationId: orgId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: executionId, sendSmsFn: fakeSend(sid) });
  assert.equal(first.ok, true);

  const second = await sendOutboundMessage(session, { organizationId: orgId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: executionId, sendSmsFn: async () => {
    throw new Error("provider must never be called twice for the same execution");
  } });
  assert.equal(second.ok, true);
  assert.equal(second.messageId, first.messageId);
  if (second.ok) assert.equal(second.providerMessageId, sid);
});
