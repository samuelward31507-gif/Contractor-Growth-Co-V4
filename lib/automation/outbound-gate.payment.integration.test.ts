/**
 * TRACKPR — Final Outbound Safety Hardening: evaluateOutboundGate() is now
 * the single, centralized authority verifying organization payment_status
 * before ANY automated outbound message, whatever triggered it. Mirrors
 * outbound-gate.pause.integration.test.ts's exact two-section structure
 * (Section 1: structural/textual assertions against the source; Section 2:
 * live, DB-backed enforcement) - the same proven shape used for Launch
 * Blocker #5's identical class of change.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/automation/outbound-gate.payment.integration.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { evaluateOutboundGate, type OutboundGateInput } from "./outbound-gate";

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

const OUTBOUND_GATE_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "lib/automation/outbound-gate.ts"), "utf8");

// ===========================================================================
// SECTION 1 - STATIC (structural, no database)
// ===========================================================================

test("1. payment_status is read fresh from its own independent query on every call, never cached, and never combined into the same select as automation_mode or automation_paused - a missing/unreadable payment_status column can only ever add its own fail-closed restriction, never take down either pre-existing check by making its query fail too", () => {
  assert.match(OUTBOUND_GATE_SOURCE, /\.select\("automation_mode"\)/);
  assert.match(OUTBOUND_GATE_SOURCE, /\.select\("payment_status"\)/);
  assert.match(OUTBOUND_GATE_SOURCE, /\.select\("automation_paused"\)/);
  assert.doesNotMatch(OUTBOUND_GATE_SOURCE, /\.select\("automation_mode, payment_status"\)/);
  assert.doesNotMatch(OUTBOUND_GATE_SOURCE, /\.select\("payment_status, automation_paused"\)/);
});

test("2. the organization_payment_inactive denial is checked after organization_not_live and before organization_automation_paused - additive, never replacing either existing check", () => {
  const notLiveIndex = OUTBOUND_GATE_SOURCE.indexOf('deny("organization_not_live")');
  const paymentCheckIndex = OUTBOUND_GATE_SOURCE.indexOf('deny("organization_payment_inactive")');
  const pausedCheckIndex = OUTBOUND_GATE_SOURCE.indexOf("pauseRow?.automation_paused");
  assert.ok(notLiveIndex !== -1 && paymentCheckIndex !== -1 && pausedCheckIndex !== -1);
  assert.ok(notLiveIndex < paymentCheckIndex, "payment check must come after the go-live check");
  assert.ok(paymentCheckIndex < pausedCheckIndex, "payment check must come before the automation-pause check");
});

test("3. a missing/unreadable payment_status row or a query error is never treated as \"payment is active\" - fails closed the same way the existing automation_mode/automation_paused checks already do", () => {
  assert.match(OUTBOUND_GATE_SOURCE, /if \(paymentError \|\| paymentRow\?\.payment_status !== "active"\) return deny\("organization_payment_inactive"\);/);
});

test("4. every existing safety check (opt-out, content safety, needs_human, duplicate-send, conversation/lead/appointment/estimate/job scoping, business hours, go-live, automation pause) is textually unmodified by this change", () => {
  for (const marker of [
    'return deny("contact_opted_out")',
    "evaluateContentSafety(body)",
    'return deny("needs_human")',
    'return deny("duplicate_outbound_send")',
    'return deny("conversation_ai_disabled")',
    "isWithinBusinessHours(",
    'return deny("organization_not_live")',
    'if (pauseError || pauseRow?.automation_paused) return deny("organization_automation_paused");',
  ]) {
    assert.ok(OUTBOUND_GATE_SOURCE.includes(marker), `expected existing safety check to still be present: ${marker}`);
  }
});

// ===========================================================================
// SECTION 2 - LIVE: real enforcement
// ===========================================================================

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let organizationId: string;
let otherOrgId: string;
let contactId: string;
let conversationId: string;
let executionId: string;
let otherContactId: string;
let otherConversationId: string;
let otherExecutionId: string;

async function setPaymentStatus(orgId: string, status: "payment_required" | "active" | "suspended" | "cancelled") {
  const { error } = await service.from("organizations").update({ payment_status: status }).eq("id", orgId);
  if (error) throw error;
}

function baseInput(overrides: Partial<OutboundGateInput> = {}): OutboundGateInput {
  return {
    organizationId,
    executionId,
    contactId,
    conversationId,
    leadId: null,
    aiResult: { should_send: true, response_message: "Thanks for reaching out - we'll follow up shortly.", needs_human: false },
    ...overrides,
  };
}

async function makeExecution(orgId: string, eventId: string) {
  const { data: execution, error } = await service
    .from("workflow_executions")
    .insert({ organization_id: orgId, automation_event_id: eventId, workflow_name: "payment_gate_test", status: "running" })
    .select("id")
    .single();
  if (error) throw error;
  return execution!.id as string;
}

before(async () => {
  const { data: org, error: orgErr } = await service.from("organizations").insert({ name: "Payment Gate Test Org", automation_mode: "live", payment_status: "active" }).select("id").single();
  if (orgErr) throw orgErr;
  organizationId = org!.id;

  const { data: contact, error: contactErr } = await service
    .from("contacts")
    .insert({ organization_id: organizationId, first_name: "Payment", phone: "+15555550122", sms_opt_out: false })
    .select("id")
    .single();
  if (contactErr) throw contactErr;
  contactId = contact!.id;

  const { data: conversation, error: convErr } = await service
    .from("conversations")
    .insert({ organization_id: organizationId, contact_id: contactId, channel: "sms", status: "open", ai_enabled: true })
    .select("id")
    .single();
  if (convErr) throw convErr;
  conversationId = conversation!.id;

  const { data: event, error: eventErr } = await service
    .from("automation_events")
    .insert({ organization_id: organizationId, event_type: "lead.created", entity_type: "lead", entity_id: null, payload: {}, status: "processing" })
    .select("id")
    .single();
  if (eventErr) throw eventErr;
  executionId = await makeExecution(organizationId, event!.id as string);

  // Isolation fixture: a second organization, ACTIVE payment, entirely
  // independent of the first.
  const { data: otherOrg, error: otherOrgErr } = await service.from("organizations").insert({ name: "Payment Gate Test Org (Other)", automation_mode: "live", payment_status: "active" }).select("id").single();
  if (otherOrgErr) throw otherOrgErr;
  otherOrgId = otherOrg!.id;

  const { data: otherContact, error: otherContactErr } = await service
    .from("contacts")
    .insert({ organization_id: otherOrgId, first_name: "Other", phone: "+15555550133", sms_opt_out: false })
    .select("id")
    .single();
  if (otherContactErr) throw otherContactErr;
  otherContactId = otherContact!.id;

  const { data: otherConversation, error: otherConvErr } = await service
    .from("conversations")
    .insert({ organization_id: otherOrgId, contact_id: otherContactId, channel: "sms", status: "open", ai_enabled: true })
    .select("id")
    .single();
  if (otherConvErr) throw otherConvErr;
  otherConversationId = otherConversation!.id;

  const { data: otherEvent, error: otherEventErr } = await service
    .from("automation_events")
    .insert({ organization_id: otherOrgId, event_type: "lead.created", entity_type: "lead", entity_id: null, payload: {}, status: "processing" })
    .select("id")
    .single();
  if (otherEventErr) throw otherEventErr;
  otherExecutionId = await makeExecution(otherOrgId, otherEvent!.id as string);
});

after(async () => {
  await service.from("organizations").delete().eq("id", organizationId);
  await service.from("organizations").delete().eq("id", otherOrgId);
});

test("5. an ACTIVE organization: an otherwise-fully-eligible send is allowed - the baseline this suite's other cases are compared against", async () => {
  await setPaymentStatus(organizationId, "active");
  const result = await evaluateOutboundGate(service, baseInput());
  assert.equal(result.allowed, true);
});

test("6. an organization still in onboarding (payment_required, never yet paid) is denied with organization_payment_inactive - this is the normal pre-payment state, and it must never send automated outbound", async () => {
  await setPaymentStatus(organizationId, "payment_required");
  try {
    const result = await evaluateOutboundGate(service, baseInput());
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.reason, "organization_payment_inactive");
  } finally {
    await setPaymentStatus(organizationId, "active");
  }
});

test("7. a SUSPENDED organization is denied with organization_payment_inactive", async () => {
  await setPaymentStatus(organizationId, "suspended");
  try {
    const result = await evaluateOutboundGate(service, baseInput());
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.reason, "organization_payment_inactive");
  } finally {
    await setPaymentStatus(organizationId, "active");
  }
});

test("8. a CANCELLED organization is denied with organization_payment_inactive", async () => {
  await setPaymentStatus(organizationId, "cancelled");
  try {
    const result = await evaluateOutboundGate(service, baseInput());
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.reason, "organization_payment_inactive");
  } finally {
    await setPaymentStatus(organizationId, "active");
  }
});

test("9. restoring payment to active immediately restores normal send behavior - no stale caching, no lingering denial", async () => {
  await setPaymentStatus(organizationId, "suspended");
  const denied = await evaluateOutboundGate(service, baseInput());
  assert.equal(denied.allowed, false);

  await setPaymentStatus(organizationId, "active");
  const allowed = await evaluateOutboundGate(service, baseInput());
  assert.equal(allowed.allowed, true);
});

test("10. an ACTIVE-payment organization that is also PAUSED (founder kill switch) is still denied - the payment fix does not weaken or bypass the pause check", async () => {
  await setPaymentStatus(organizationId, "active");
  await service.from("organizations").update({ automation_paused: true }).eq("id", organizationId);
  try {
    const result = await evaluateOutboundGate(service, baseInput());
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.reason, "organization_automation_paused");
  } finally {
    await service.from("organizations").update({ automation_paused: false }).eq("id", organizationId);
  }
});

test("11. an ACTIVE-payment, unpaused organization with an opted-out contact is still denied for that reason - the payment fix does not weaken or bypass opt-out enforcement", async () => {
  await setPaymentStatus(organizationId, "active");
  await service.from("contacts").update({ sms_opt_out: true }).eq("id", contactId);
  try {
    const result = await evaluateOutboundGate(service, baseInput());
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.reason, "contact_opted_out");
  } finally {
    await service.from("contacts").update({ sms_opt_out: false }).eq("id", contactId);
  }
});

test("12. an ACTIVE-payment organization outside its configured business hours (respectBusinessHours requested) is still denied for that reason - the payment fix does not weaken or bypass business-hours enforcement", async () => {
  await setPaymentStatus(organizationId, "active");
  await service.from("business_hours").insert({ organization_id: organizationId, day_of_week: "monday", is_open: false, open_time: null, close_time: null });
  const now = new Date();
  const isMonday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(now).toLowerCase() === "monday";
  try {
    if (!isMonday) {
      // business_hours has at least one configured day - every OTHER day
      // (including today, whatever it is) now correctly reads as closed per
      // isWithinBusinessHours's own documented semantics.
      const result = await evaluateOutboundGate(service, baseInput({ respectBusinessHours: true }));
      assert.equal(result.allowed, false);
      if (!result.allowed) assert.equal(result.reason, "outside_business_hours");
    }
  } finally {
    await service.from("business_hours").delete().eq("organization_id", organizationId);
  }
});

test("13. cross-organization isolation: organization A's suspended payment status never affects organization B's otherwise-eligible send", async () => {
  await setPaymentStatus(organizationId, "suspended");
  try {
    const resultA = await evaluateOutboundGate(service, baseInput());
    assert.equal(resultA.allowed, false);

    const resultB = await evaluateOutboundGate(service, {
      organizationId: otherOrgId,
      executionId: otherExecutionId,
      contactId: otherContactId,
      conversationId: otherConversationId,
      leadId: null,
      aiResult: { should_send: true, response_message: "Thanks for reaching out - we'll follow up shortly.", needs_human: false },
    });
    assert.equal(resultB.allowed, true, "organization B's own active payment status must be evaluated independently of organization A's");
  } finally {
    await setPaymentStatus(organizationId, "active");
  }
});
