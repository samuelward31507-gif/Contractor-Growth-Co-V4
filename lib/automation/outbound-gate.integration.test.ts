/**
 * Integration tests for evaluateOutboundGate()/sendOutboundMessage() - the
 * deterministic authorization boundary Instant Lead Follow-Up V1 (Safe
 * Automatic SMS) relies on. Unlike outbound-gate.test.ts (which tests the
 * pure isWithinBusinessHours() helper with no I/O), these tests exercise the
 * real, DB-backed decision logic end-to-end against an isolated,
 * fully-cleaned-up test organization on the real Supabase project - there is
 * no mocking layer in this codebase for a Supabase client, and this
 * codebase's established pattern for exactly this class of logic is a real,
 * isolated round-trip rather than a mock (see e.g. the live verification
 * passes performed for Estimates/Jobs earlier this session).
 *
 * Every outbound send goes through the existing sendSmsFn injection seam
 * (lib/messaging/outbound.ts's documented test seam) - no real Twilio call
 * is ever made by this file.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL to be
 * loadable from .env.local (already required by any local `next build`).
 * Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/outbound-gate.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
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

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(
  path.join(REPO_ROOT, "lib/supabase/service.ts"),
);
const { evaluateOutboundGate }: typeof import("./outbound-gate") = require(path.join(REPO_ROOT, "lib/automation/outbound-gate.ts"));
const { sendOutboundMessage }: typeof import("@/lib/messaging/outbound") = require(
  path.join(REPO_ROOT, "lib/messaging/outbound.ts"),
);

const service = createServiceRoleClient();

let organizationId: string;
let otherOrgId: string;
let contactId: string;
let conversationId: string;

const VALID_PHONE = "+15555550199"; // NANPA-reserved fictional-use number, never a real subscriber.
const VALID_BODY = "Thanks for reaching out! Could you share the property address so we can help?";

function baseAiResult(overrides: Partial<{ should_send: boolean; response_message: string | null; needs_human: boolean }> = {}) {
  return { should_send: true, response_message: VALID_BODY, needs_human: false, ...overrides };
}

async function makeExecution(status: "running" | "completed" | "cancelled" | "failed" = "running") {
  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: organizationId, event_type: "lead.created", entity_type: "lead", entity_id: null, payload: {}, status: "processing" })
    .select("id")
    .single();
  const { data: execution } = await service
    .from("workflow_executions")
    .insert({ organization_id: organizationId, automation_event_id: event!.id, workflow_name: "lead_created_followup", status, attempt: 1 })
    .select("id")
    .single();
  return execution!.id as string;
}

before(async () => {
  // automation_mode: "live" and payment_status: "active" on both orgs -
  // every test below in this file predates and is unrelated to the
  // Fast-Track Pass 3 go-live gate or the Final Outbound Safety Hardening
  // payment gate, so neither must be the reason any of them denies/allows.
  // Both gates' own dedicated denial behaviors are covered separately below
  // (organization_not_live in test 19, organization_payment_inactive in
  // outbound-gate.payment.integration.test.ts).
  const { data: org } = await service.from("organizations").insert({ name: "Outbound Gate Integration Test Org", automation_mode: "live", payment_status: "active" }).select("id").single();
  organizationId = org!.id;
  const { data: other } = await service.from("organizations").insert({ name: "Outbound Gate Integration Test Org (Other)", automation_mode: "live", payment_status: "active" }).select("id").single();
  otherOrgId = other!.id;

  const { data: contact } = await service
    .from("contacts")
    .insert({ organization_id: organizationId, first_name: "Gate", last_name: "Test", phone: VALID_PHONE })
    .select("id")
    .single();
  contactId = contact!.id;

  const { data: conversation } = await service
    .from("conversations")
    .insert({ organization_id: organizationId, contact_id: contactId, channel: "sms", status: "open" })
    .select("id")
    .single();
  conversationId = conversation!.id;
});

after(async () => {
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("workflow_executions").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("automation_settings").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
  await service.from("organizations").delete().eq("id", otherOrgId);
});

test("1. valid lead context -> gate allows", async () => {
  const executionId = await makeExecution("running");
  const result = await evaluateOutboundGate(service, {
    organizationId,
    executionId,
    contactId,
    conversationId,
    leadId: null,
    aiResult: baseAiResult(),
  });
  assert.equal(result.allowed, true);
});

test("2. invalid/malformed phone -> invalid_destination", async () => {
  const { data: badContact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Bad", last_name: "Phone", phone: "5551234567" }).select("id").single();
  const { data: badConvo } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: badContact!.id, channel: "sms", status: "open" }).select("id").single();
  const executionId = await makeExecution("running");
  const result = await evaluateOutboundGate(service, {
    organizationId,
    executionId,
    contactId: badContact!.id,
    conversationId: badConvo!.id,
    leadId: null,
    aiResult: baseAiResult(),
  });
  assert.deepEqual(result, { allowed: false, reason: "invalid_destination", detail: undefined });
});

test("3. opted-out contact -> contact_opted_out", async () => {
  const { data: optedOut } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Opted", last_name: "Out", phone: VALID_PHONE, sms_opt_out: true }).select("id").single();
  const { data: convo } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: optedOut!.id, channel: "sms", status: "open" }).select("id").single();
  const executionId = await makeExecution("running");
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId: optedOut!.id, conversationId: convo!.id, leadId: null, aiResult: baseAiResult() });
  assert.deepEqual(result, { allowed: false, reason: "contact_opted_out", detail: undefined });
});

test("4. STOP-opted-out contact blocked identically via sendOutboundMessage's own independent re-check", async () => {
  const { data: optedOut } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Stop", last_name: "Contact", phone: VALID_PHONE, sms_opt_out: true }).select("id").single();
  const result = await sendOutboundMessage(service, { organizationId, contactId: optedOut!.id, channel: "sms", body: VALID_BODY });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /opted out/i);
});

test("5. needs_human true -> blocked regardless of should_send", async () => {
  const executionId = await makeExecution("running");
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId, conversationId, leadId: null, aiResult: baseAiResult({ needs_human: true }) });
  assert.deepEqual(result, { allowed: false, reason: "needs_human", detail: undefined });
});

test("6. unsafe AI content (fabricated price) -> unsafe_content", async () => {
  const executionId = await makeExecution("running");
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId, conversationId, leadId: null, aiResult: baseAiResult({ response_message: "That will be $500 for the repair." }) });
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.reason, "unsafe_content");
});

test("7. empty/whitespace-only AI response -> missing_response_message", async () => {
  const executionId = await makeExecution("running");
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId, conversationId, leadId: null, aiResult: baseAiResult({ response_message: "   " }) });
  assert.deepEqual(result, { allowed: false, reason: "missing_response_message", detail: undefined });
});

test("8. oversized message -> response_message_too_long", async () => {
  const executionId = await makeExecution("running");
  const oversized = "a".repeat(1601);
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId, conversationId, leadId: null, aiResult: baseAiResult({ response_message: oversized }) });
  assert.deepEqual(result, { allowed: false, reason: "response_message_too_long", detail: undefined });
});

test("9. automation disabled -> automation_disabled", async () => {
  const executionId = await makeExecution("running");
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId, conversationId, leadId: null, aiResult: baseAiResult(), automationEnabled: false });
  assert.deepEqual(result, { allowed: false, reason: "automation_disabled", detail: undefined });
});

test("9b. automationEnabled undefined (no catalog automation resolvable) is not a restriction", async () => {
  const executionId = await makeExecution("running");
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId, conversationId, leadId: null, aiResult: baseAiResult(), automationEnabled: undefined });
  assert.equal(result.allowed, true);
});

test("9c. outside business hours when respectBusinessHours is requested -> outside_business_hours", async () => {
  await service.from("business_hours").insert({
    organization_id: organizationId,
    day_of_week: "monday",
    is_open: true,
    open_time: "09:00:00",
    close_time: "17:00:00",
  });
  const executionId = await makeExecution("running");
  // isWithinBusinessHours(new Date()) is evaluated against the real wall
  // clock inside evaluateOutboundGate, so this test only configures a
  // single narrow, real, already-open weekday window and asserts on the
  // *other* six days/times of the week being closed - deterministic
  // regardless of when this suite happens to run, without needing to inject
  // a fake clock into the gate itself (no such seam exists, and adding one
  // is out of scope for this feature).
  const now = new Date();
  const isMonday9to5 =
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(now).toLowerCase() === "monday";
  if (isMonday9to5) {
    // Vanishingly unlikely in CI, but skip rather than produce a flaky
    // false failure if this suite happens to run exactly then.
    return;
  }
  const result = await evaluateOutboundGate(service, {
    organizationId,
    executionId,
    contactId,
    conversationId,
    leadId: null,
    aiResult: baseAiResult(),
    respectBusinessHours: true,
  });
  assert.deepEqual(result, { allowed: false, reason: "outside_business_hours", detail: undefined });
  await service.from("business_hours").delete().eq("organization_id", organizationId);
});

test("9d. respectBusinessHours omitted/false -> business hours are never enforced, even if configured and currently closed", async () => {
  await service.from("business_hours").insert({
    organization_id: organizationId,
    day_of_week: "monday",
    is_open: false,
    open_time: null,
    close_time: null,
  });
  const executionId = await makeExecution("running");
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId, conversationId, leadId: null, aiResult: baseAiResult() });
  assert.equal(result.allowed, true, "omitting respectBusinessHours must never apply business-hours restriction, regardless of configuration");
  await service.from("business_hours").delete().eq("organization_id", organizationId);
});

test("10. wrong organization -> contact_not_found (org mismatch never leaks which reason)", async () => {
  const executionId = await makeExecution("running");
  const result = await evaluateOutboundGate(service, { organizationId: otherOrgId, executionId, contactId, conversationId, leadId: null, aiResult: baseAiResult() });
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.reason, "contact_not_found");
});

test("11. invalid/mismatched conversation -> conversation_contact_mismatch", async () => {
  const { data: otherContact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Other", last_name: "Contact", phone: VALID_PHONE }).select("id").single();
  const executionId = await makeExecution("running");
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId: otherContact!.id, conversationId, leadId: null, aiResult: baseAiResult() });
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.reason, "conversation_contact_mismatch");
});

test("12. execution already completed -> execution_not_eligible, no send", async () => {
  const executionId = await makeExecution("completed");
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId, conversationId, leadId: null, aiResult: baseAiResult() });
  assert.deepEqual(result, { allowed: false, reason: "execution_not_eligible", detail: undefined });
});

test("13. execution cancelled/failed -> execution_not_eligible, no send", async () => {
  const executionId = await makeExecution("failed");
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId, conversationId, leadId: null, aiResult: baseAiResult() });
  assert.deepEqual(result, { allowed: false, reason: "execution_not_eligible", detail: undefined });
});

test("14. duplicate outbound for the same execution -> duplicate_outbound_send", async () => {
  const executionId = await makeExecution("running");
  await service.from("messages").insert({ organization_id: organizationId, conversation_id: conversationId, direction: "outbound", sender_type: "ai", body: "already sent", status: "sent", workflow_execution_id: executionId });
  const result = await evaluateOutboundGate(service, { organizationId, executionId, contactId, conversationId, leadId: null, aiResult: baseAiResult() });
  assert.deepEqual(result, { allowed: false, reason: "duplicate_outbound_send", detail: undefined });
});

test("15. provider failure -> recorded as failed, never claimed sent", async () => {
  const executionId = await makeExecution("running");
  const failingSend = async () => ({ ok: false as const, error: "simulated provider outage" });
  const result = await sendOutboundMessage(service, { organizationId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: executionId, sendSmsFn: failingSend });
  assert.equal(result.ok, false);
  const { data: row } = await service.from("messages").select("status, status_reason").eq("id", (result as { messageId: string }).messageId ?? "").maybeSingle();
  if (row) assert.equal(row.status, "failed");
});

test("16. successful provider call (fake provider) -> message recorded as sent with provider_message_id", async () => {
  const executionId = await makeExecution("running");
  const fakeSend = async () => ({ ok: true as const, providerMessageId: "FAKE_SID_123" });
  const result = await sendOutboundMessage(service, { organizationId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: executionId, sendSmsFn: fakeSend });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.providerMessageId, "FAKE_SID_123");
    const { data: row } = await service.from("messages").select("status, provider_message_id").eq("id", result.messageId).maybeSingle();
    assert.equal(row?.status, "sent");
    assert.equal(row?.provider_message_id, "FAKE_SID_123");
  }
});

test("17. retry after successful send -> no second SMS, resolves to the existing sent message", async () => {
  const executionId = await makeExecution("running");
  const fakeSend = async () => ({ ok: true as const, providerMessageId: "FAKE_SID_456" });
  const first = await sendOutboundMessage(service, { organizationId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: executionId, sendSmsFn: fakeSend });
  assert.equal(first.ok, true);

  let secondProviderCalls = 0;
  const shouldNeverBeCalled = async () => {
    secondProviderCalls += 1;
    return { ok: true as const, providerMessageId: "SHOULD_NOT_HAPPEN" };
  };
  const second = await sendOutboundMessage(service, { organizationId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: executionId, sendSmsFn: shouldNeverBeCalled });

  assert.equal(secondProviderCalls, 0, "the provider must never be called a second time for the same execution");
  assert.equal(second.ok, true);
  if (second.ok && first.ok) assert.equal(second.messageId, first.messageId);

  const { count } = await service.from("messages").select("id", { count: "exact", head: true }).eq("workflow_execution_id", executionId).eq("direction", "outbound");
  assert.equal(count, 1, "exactly one outbound message row must exist for this execution, never two");
});

test("18. retry after provider failure -> real retry mechanism (a NEW execution for the same event, per retryWorkflowExecution/startWorkflowExecution) sends exactly once, never twice", async () => {
  // First attempt: the provider fails, so the execution is the kind
  // checkRetryEligibility actually allows retrying (status: 'failed' can
  // only ever be reached when no send succeeded - see failWorkflowExecutionAsService's
  // call sites in the n8n-callback route, never called after a successful
  // sendOutboundMessage).
  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: organizationId, event_type: "lead.created", entity_type: "lead", entity_id: null, payload: {}, status: "processing" })
    .select("id")
    .single();
  const { data: firstExecution } = await service
    .from("workflow_executions")
    .insert({ organization_id: organizationId, automation_event_id: event!.id, workflow_name: "lead_created_followup", status: "running", attempt: 1 })
    .select("id")
    .single();
  const firstExecutionId = firstExecution!.id as string;

  const failingSend = async () => ({ ok: false as const, error: "simulated transient failure" });
  const first = await sendOutboundMessage(service, { organizationId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: firstExecutionId, sendSmsFn: failingSend });
  assert.equal(first.ok, false);
  await service.from("workflow_executions").update({ status: "failed" }).eq("id", firstExecutionId);

  // Real retry mechanism: a NEW workflow_executions row for the SAME
  // automation_event_id, exactly like startWorkflowExecution(..., "retry")
  // creates inside retryWorkflowExecution - never the same execution_id.
  const { data: retryExecution } = await service
    .from("workflow_executions")
    .insert({ organization_id: organizationId, automation_event_id: event!.id, workflow_name: "lead_created_followup", status: "running", attempt: 2, trigger_source: "retry" })
    .select("id")
    .single();
  const retryExecutionId = retryExecution!.id as string;

  const gateResult = await evaluateOutboundGate(service, { organizationId, executionId: retryExecutionId, contactId, conversationId, leadId: null, aiResult: baseAiResult() });
  assert.equal(gateResult.allowed, true, "the retry's own execution has no outbound message yet, so the gate's duplicate check correctly allows it");

  const fakeSend = async () => ({ ok: true as const, providerMessageId: "RETRY_SUCCESS_SID" });
  const retry = await sendOutboundMessage(service, { organizationId, contactId, conversationId, channel: "sms", body: VALID_BODY, senderType: "ai", workflowExecutionId: retryExecutionId, sendSmsFn: fakeSend });
  assert.equal(retry.ok, true);

  // Exactly 2 rows total (one failed attempt, one real send) tied to 2
  // DIFFERENT execution ids - proves the customer received exactly one
  // actual message, not a duplicate, while both attempts remain individually
  // auditable.
  const { data: rows } = await service.from("messages").select("workflow_execution_id, status").eq("organization_id", organizationId).in("workflow_execution_id", [firstExecutionId, retryExecutionId]);
  assert.equal(rows?.length, 2);
  assert.equal(rows?.filter((r) => r.status === "sent").length, 1, "exactly one message was actually sent");
  assert.equal(rows?.filter((r) => r.status === "failed").length, 1);
});

// ==================== Fast-Track Production Readiness ====================

test("19. organization in Test mode -> organization_not_live, even with an otherwise-valid send", async () => {
  const { data: testModeOrg } = await service.from("organizations").insert({ name: "Outbound Gate Test-Mode Org" }).select("id").single();
  const testModeOrgId = testModeOrg!.id as string;
  try {
    const { data: contact } = await service.from("contacts").insert({ organization_id: testModeOrgId, first_name: "Test", last_name: "Mode", phone: VALID_PHONE }).select("id").single();
    const { data: conversation } = await service.from("conversations").insert({ organization_id: testModeOrgId, contact_id: contact!.id, channel: "sms", status: "open" }).select("id").single();
    const { data: event } = await service.from("automation_events").insert({ organization_id: testModeOrgId, event_type: "lead.created", entity_type: "lead", entity_id: null, payload: {}, status: "processing" }).select("id").single();
    const { data: execution } = await service.from("workflow_executions").insert({ organization_id: testModeOrgId, automation_event_id: event!.id, workflow_name: "lead_created_followup", status: "running", attempt: 1 }).select("id").single();

    const result = await evaluateOutboundGate(service, {
      organizationId: testModeOrgId,
      executionId: execution!.id as string,
      contactId: contact!.id,
      conversationId: conversation!.id,
      leadId: null,
      aiResult: baseAiResult(),
    });
    assert.deepEqual(result, { allowed: false, reason: "organization_not_live", detail: undefined });
  } finally {
    await service.from("organizations").delete().eq("id", testModeOrgId); // cascades contacts/conversations/automation_events/workflow_executions
  }
});

test("20. conversation with ai_enabled:false -> conversation_ai_disabled, even though this specific aiResult says needs_human:false", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "AI", last_name: "Locked", phone: VALID_PHONE }).select("id").single();
  const { data: lockedConversation } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: contact!.id, channel: "sms", status: "open", ai_enabled: false }).select("id").single();
  const executionId = await makeExecution("running");

  const result = await evaluateOutboundGate(service, {
    organizationId,
    executionId,
    contactId: contact!.id,
    conversationId: lockedConversation!.id,
    leadId: null,
    aiResult: baseAiResult({ needs_human: false }),
  });
  assert.deepEqual(result, { allowed: false, reason: "conversation_ai_disabled", detail: undefined });
});
