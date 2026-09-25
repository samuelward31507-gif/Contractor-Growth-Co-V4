/**
 * E1 (pre-launch lead-leak audit): integration tests for
 * classifyAndProcessEstimateReply (lib/automation/estimate-reply.ts) against
 * a real, disposable Supabase organization. Calls the function directly
 * rather than through the full inbound SMS webhook, matching
 * booking.integration.test.ts's own established "call the testable core
 * directly" precedent for this codebase.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/estimate-reply.integration.test.ts
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
const { classifyEstimateReplyIntent, classifyAndProcessEstimateReply }: typeof import("./estimate-reply") = require(path.join(REPO_ROOT, "lib/automation/estimate-reply.ts"));

function fakeSendSms() {
  return async () => ({ ok: true as const, providerMessageId: `FAKE-${Date.now()}-${Math.random()}` });
}

const service = createServiceRoleClient();
let organizationId: string;
let otherOrgId: string;

async function makeContactLeadConversation(orgId: string) {
  const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, first_name: "Jane", last_name: "Doe", phone: `+1555558${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const { data: lead } = await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, service: "Kitchen Remodel", status: "estimate", temperature: "warm" }).select("id").single();
  const conversation = await findOrCreateOpenConversation(service, orgId, contact!.id, "sms", lead!.id);
  return { contactId: contact!.id as string, leadId: lead!.id as string, conversationId: conversation!.id as string };
}

async function makeSentEstimate(orgId: string, contactId: string, leadId: string, title = "Kitchen Remodel Estimate") {
  const { data: estimate } = await service
    .from("estimates")
    .insert({ organization_id: orgId, contact_id: contactId, lead_id: leadId, title, amount: 8500, status: "sent", sent_at: new Date().toISOString() })
    .select("id")
    .single();
  return estimate!.id as string;
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "E1 Estimate Reply Test Org", payment_status: "active", automation_mode: "live", timezone: "UTC" }).select("id").single();
  organizationId = org!.id;
  const { data: other } = await service.from("organizations").insert({ name: "E1 Estimate Reply Test Org (Other)", payment_status: "active", automation_mode: "live" }).select("id").single();
  otherOrgId = other!.id;
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("automation_incidents").delete().eq("organization_id", orgId);
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("jobs").delete().eq("organization_id", orgId);
    await service.from("estimates").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("leads").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("classifyEstimateReplyIntent: clear, unambiguous acceptance phrases match 'accept'", () => {
  for (const body of ["Yes", "yes please", "sounds good", "looks good", "let's do it", "go ahead", "I approve", "we accept", "book it", "I'm in", "ok"]) {
    assert.equal(classifyEstimateReplyIntent(body), "accept", `expected "${body}" to classify as accept`);
  }
});

test("classifyEstimateReplyIntent: ambiguous or negative language never classifies as 'accept'", () => {
  for (const body of ["can we talk about the price?", "not sure yet", "no thanks", "that's too expensive", "maybe", "what does this include?", ""]) {
    assert.equal(classifyEstimateReplyIntent(body), "unclear", `expected "${body}" to classify as unclear, never accept`);
  }
});

test("A. a clear acceptance reply transitions the estimate to accepted, creates a job, and sends ONE deterministic confirmation SMS - no conversation lockout", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId);
  const estimateId = await makeSentEstimate(organizationId, contactId, leadId);

  await classifyAndProcessEstimateReply(service, organizationId, contactId, leadId, conversationId, "Yes, let's do it!", fakeSendSms());

  const { data: estimate } = await service.from("estimates").select("status, responded_at").eq("id", estimateId).single();
  assert.equal(estimate?.status, "accepted");
  assert.ok(estimate?.responded_at);

  const { data: job } = await service.from("jobs").select("id, estimate_id").eq("estimate_id", estimateId).maybeSingle();
  assert.ok(job, "an accepted estimate must create exactly one job");

  const { data: messages } = await service.from("messages").select("body, direction").eq("conversation_id", conversationId).eq("direction", "outbound");
  assert.equal(messages?.length, 1, "expected exactly one outbound confirmation message");
  assert.match(messages![0].body, /Kitchen Remodel Estimate/);

  const { data: conversation } = await service.from("conversations").select("ai_enabled").eq("id", conversationId).single();
  assert.equal(conversation?.ai_enabled, true, "a clean acceptance must never lock the conversation");
});

test("B. an ambiguous/unclear reply locks the conversation, records a human_escalation_requested incident, and never touches the estimate", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId);
  const estimateId = await makeSentEstimate(organizationId, contactId, leadId);

  await classifyAndProcessEstimateReply(service, organizationId, contactId, leadId, conversationId, "Can we adjust the price a bit?", fakeSendSms());

  const { data: estimate } = await service.from("estimates").select("status").eq("id", estimateId).single();
  assert.equal(estimate?.status, "sent", "an unclear reply must never transition the estimate");

  const { data: conversation } = await service.from("conversations").select("ai_enabled").eq("id", conversationId).single();
  assert.equal(conversation?.ai_enabled, false, "an unclear reply must lock the conversation out of further AI turns");

  const { data: incident } = await service
    .from("automation_incidents")
    .select("id, status, category")
    .eq("organization_id", organizationId)
    .eq("category", "human_escalation_requested")
    .eq("fingerprint", `human_escalation_requested:${conversationId}`)
    .maybeSingle();
  assert.ok(incident, "expected a human_escalation_requested incident for the unclear reply");
  assert.equal(incident?.status, "open");
});

test("C. idempotency: a second reply after acceptance (estimate no longer 'sent') is a safe no-op - no second job, no second message", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId);
  const estimateId = await makeSentEstimate(organizationId, contactId, leadId);

  await classifyAndProcessEstimateReply(service, organizationId, contactId, leadId, conversationId, "Yes", fakeSendSms());
  await classifyAndProcessEstimateReply(service, organizationId, contactId, leadId, conversationId, "Yes, confirmed!", fakeSendSms());

  const { data: jobs } = await service.from("jobs").select("id").eq("estimate_id", estimateId);
  assert.equal(jobs?.length, 1, "a second acceptance-shaped reply must never create a second job");

  const { data: messages } = await service.from("messages").select("id").eq("conversation_id", conversationId).eq("direction", "outbound");
  assert.equal(messages?.length, 1, "a second acceptance-shaped reply must never send a second confirmation");
});

test("D. no active estimate for this contact: a safe no-op, nothing created or changed", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId);

  await classifyAndProcessEstimateReply(service, organizationId, contactId, leadId, conversationId, "Yes, let's do it!", fakeSendSms());

  const { data: conversation } = await service.from("conversations").select("ai_enabled").eq("id", conversationId).single();
  assert.equal(conversation?.ai_enabled, true);
  const { data: incidents } = await service.from("automation_incidents").select("id").eq("organization_id", organizationId).eq("fingerprint", `human_escalation_requested:${conversationId}`);
  assert.equal(incidents?.length ?? 0, 0);
});

test("E. organization isolation: an estimate under organization A is never matched or transitioned by a call incorrectly scoped to organization B", async () => {
  const { contactId: contactA, leadId: leadA, conversationId: conversationA } = await makeContactLeadConversation(organizationId);
  const estimateIdA = await makeSentEstimate(organizationId, contactA, leadA);

  // organizationId argument deliberately mismatched against contactA/leadA's
  // real organization - the function's own query must never cross this
  // boundary, exactly like every other org-scoped query in this codebase.
  await classifyAndProcessEstimateReply(service, otherOrgId, contactA, leadA, conversationA, "Yes", fakeSendSms());

  const { data: estimate } = await service.from("estimates").select("status").eq("id", estimateIdA).single();
  assert.equal(estimate?.status, "sent", "a mismatched-organization call must never transition another organization's estimate");
});
