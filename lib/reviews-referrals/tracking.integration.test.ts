/**
 * Integration tests for Review & Referral Tracking V1 - the real DB-backed
 * schema/constraints, the deterministic tracking logic
 * (recordPostJobFollowupOutcome/recordRequestResponses), and RLS/
 * cross-org isolation, against an isolated test organization on the real
 * Supabase project (this codebase's established pattern - see
 * outbound-gate.integration.test.ts). No real Twilio/n8n call is ever made.
 *
 * Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/reviews-referrals/tracking.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const { createClient: createSupabaseClient } = require("@supabase/supabase-js");

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
const { recordPostJobFollowupOutcome, recordRequestResponses }: typeof import("./tracking") = require(path.join(REPO_ROOT, "lib/reviews-referrals/tracking.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let organizationId: string;
let otherOrgId: string;
let contactId: string;
let conversationId: string;
const testUserIds: string[] = [];

async function makeJob(status: "completed" = "completed") {
  const { data } = await service.from("jobs").insert({ organization_id: organizationId, contact_id: contactId, title: "Test job", status }).select("id").single();
  return data!.id as string;
}

// workflow_execution_id/message_id on review_requests/referral_requests are
// real foreign keys (references workflow_executions(id)/messages(id)) - a
// fabricated UUID that doesn't exist in either table is correctly rejected
// by the database, so every test exercising recordPostJobFollowupOutcome's
// "sent"/"blocked"/"send_failed" paths needs a real supporting row, mirroring
// outbound-gate.integration.test.ts's own makeExecution() helper.
async function makeExecution() {
  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: organizationId, event_type: "job.post_followup", entity_type: "job", entity_id: null, payload: {}, status: "processing" })
    .select("id")
    .single();
  const { data: execution } = await service
    .from("workflow_executions")
    .insert({ organization_id: organizationId, automation_event_id: event!.id, workflow_name: "post_job_followup", status: "running", attempt: 1 })
    .select("id")
    .single();
  return execution!.id as string;
}

async function makeMessage(conversationId: string) {
  const { data } = await service
    .from("messages")
    .insert({ organization_id: organizationId, conversation_id: conversationId, direction: "outbound", sender_type: "ai", body: "test", status: "sent" })
    .select("id")
    .single();
  return data!.id as string;
}

async function createTestUser(email: string) {
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`failed to create test user ${email}: ${error?.message}`);
  testUserIds.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function signInAs(email: string, password: string) {
  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return client;
}

let memberUser: { id: string; email: string; password: string };
let otherOwner: { id: string; email: string; password: string };

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Review Referral Tracking Test Org" }).select("id").single();
  const { data: other } = await service.from("organizations").insert({ name: "Review Referral Tracking Test Org - Other" }).select("id").single();
  organizationId = org!.id;
  otherOrgId = other!.id;

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15555550144" }).select("id").single();
  contactId = contact!.id;

  const { data: conversation } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: contactId, channel: "sms", status: "open" }).select("id").single();
  conversationId = conversation!.id;

  const stamp = Date.now();
  memberUser = await createTestUser(`rrv1-member-${stamp}@example.com`);
  otherOwner = await createTestUser(`rrv1-otherowner-${stamp}@example.com`);
  await service.from("organization_members").insert([
    { organization_id: organizationId, user_id: memberUser.id, role: "member" },
    { organization_id: otherOrgId, user_id: otherOwner.id, role: "owner" },
  ]);
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("review_requests").delete().eq("organization_id", orgId);
    await service.from("referral_requests").delete().eq("organization_id", orgId);
    await service.from("audit_log").delete().eq("organization_id", orgId);
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("jobs").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organization_members").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
});

// ==================== Database ====================

test("DB: review_requests.status CHECK constraint rejects an invalid value", async () => {
  const jobId = await makeJob();
  const { error } = await service.from("review_requests").insert({ organization_id: organizationId, job_id: jobId, status: "not-a-real-status" });
  assert.ok(error);
  assert.equal(error.code, "23514");
});

test("DB: one review_request per job is enforced at the database level", async () => {
  const jobId = await makeJob();
  const { error: first } = await service.from("review_requests").insert({ organization_id: organizationId, job_id: jobId, status: "requested" });
  assert.equal(first, null);
  const { error: second } = await service.from("review_requests").insert({ organization_id: organizationId, job_id: jobId, status: "requested" });
  assert.ok(second, "a second row for the same job must be rejected");
  assert.equal(second.code, "23505");
});

test("DB: one referral_request per job is enforced at the database level", async () => {
  const jobId = await makeJob();
  const { error: first } = await service.from("referral_requests").insert({ organization_id: organizationId, job_id: jobId, status: "requested" });
  assert.equal(first, null);
  const { error: second } = await service.from("referral_requests").insert({ organization_id: organizationId, job_id: jobId, status: "requested" });
  assert.ok(second);
  assert.equal(second.code, "23505");
});

// ==================== recordPostJobFollowupOutcome ====================

test("sent outcome with a reviewUrl creates BOTH a review_request and a referral_request, both 'requested'", async () => {
  const jobId = await makeJob();
  const messageId = await makeMessage(conversationId);
  const executionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: "https://g.page/r/test/review" },
    { kind: "sent", messageId, workflowExecutionId: executionId },
  );

  const { data: review } = await service.from("review_requests").select("status, review_url, message_id").eq("job_id", jobId).single();
  const { data: referral } = await service.from("referral_requests").select("status, message_id").eq("job_id", jobId).single();

  assert.equal(review?.status, "requested");
  assert.equal(review?.review_url, "https://g.page/r/test/review");
  assert.equal(review?.message_id, messageId);
  assert.equal(referral?.status, "requested");
});

test("sent outcome with reviewUrl: null creates ONLY a referral_request, never a review_request", async () => {
  const jobId = await makeJob();
  const messageId = await makeMessage(conversationId);
  const executionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: null },
    { kind: "sent", messageId, workflowExecutionId: executionId },
  );

  const { data: review } = await service.from("review_requests").select("id").eq("job_id", jobId).maybeSingle();
  const { data: referral } = await service.from("referral_requests").select("status").eq("job_id", jobId).single();

  assert.equal(review, null, "no review link was configured, so no review ask was ever really made");
  assert.equal(referral?.status, "requested");
});

test("a gate-blocked outcome records 'failed' with the block reason, never 'requested'", async () => {
  const jobId = await makeJob();
  const executionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: "https://example.com/review" },
    { kind: "blocked", workflowExecutionId: executionId, reason: "needs_human" },
  );

  const { data: review } = await service.from("review_requests").select("status, failure_reason").eq("job_id", jobId).single();
  assert.equal(review?.status, "failed");
  assert.equal(review?.failure_reason, "needs_human");
});

test("a provider send failure records 'failed' with the provider's error, never 'requested'", async () => {
  const jobId = await makeJob();
  const executionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: "https://example.com/review" },
    { kind: "send_failed", workflowExecutionId: executionId, reason: "The SMS provider rejected the request." },
  );

  const { data: referral } = await service.from("referral_requests").select("status, failure_reason").eq("job_id", jobId).single();
  assert.equal(referral?.status, "failed");
  assert.equal(referral?.failure_reason, "The SMS provider rejected the request.");
});

test("a retry after failure can upgrade 'failed' to 'requested' (the one legitimate re-attempt path)", async () => {
  const jobId = await makeJob();
  const firstExecutionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: null },
    { kind: "send_failed", workflowExecutionId: firstExecutionId, reason: "transient failure" },
  );
  const messageId = await makeMessage(conversationId);
  const secondExecutionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: null },
    { kind: "sent", messageId, workflowExecutionId: secondExecutionId },
  );

  const { data: referral } = await service.from("referral_requests").select("status, failure_reason, message_id").eq("job_id", jobId).single();
  assert.equal(referral?.status, "requested");
  assert.equal(referral?.failure_reason, null);
  assert.equal(referral?.message_id, messageId);
});

test("once a request reaches 'requested', a later 'blocked'/'failed' callback for the same job never downgrades it", async () => {
  const jobId = await makeJob();
  const messageId = await makeMessage(conversationId);
  const firstExecutionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: null },
    { kind: "sent", messageId, workflowExecutionId: firstExecutionId },
  );
  const secondExecutionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: null },
    { kind: "blocked", workflowExecutionId: secondExecutionId, reason: "should never apply" },
  );

  const { data: referral } = await service.from("referral_requests").select("status, message_id").eq("job_id", jobId).single();
  assert.equal(referral?.status, "requested", "a real successful request must never be silently reverted to failed");
  assert.equal(referral?.message_id, messageId);
});

test("a contractor-confirmed terminal state (completed/converted/declined) is never touched by the automation path", async () => {
  const jobId = await makeJob();
  const messageId = await makeMessage(conversationId);
  const firstExecutionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: "https://example.com/review" },
    { kind: "sent", messageId, workflowExecutionId: firstExecutionId },
  );
  await service.from("review_requests").update({ status: "completed", resolved_at: new Date().toISOString() }).eq("job_id", jobId);

  const secondExecutionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: "https://example.com/review" },
    { kind: "send_failed", workflowExecutionId: secondExecutionId, reason: "should never apply" },
  );

  const { data: review } = await service.from("review_requests").select("status").eq("job_id", jobId).single();
  assert.equal(review?.status, "completed");
});

// ==================== recordRequestResponses ====================

test("recordRequestResponses marks the pending 'requested' review and referral rows 'responded'", async () => {
  const jobId = await makeJob();
  const messageId = await makeMessage(conversationId);
  const executionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: "https://example.com/review" },
    { kind: "sent", messageId, workflowExecutionId: executionId },
  );

  await recordRequestResponses(service, organizationId, contactId);

  const { data: review } = await service.from("review_requests").select("status, responded_at").eq("job_id", jobId).single();
  const { data: referral } = await service.from("referral_requests").select("status, responded_at").eq("job_id", jobId).single();
  assert.equal(review?.status, "responded");
  assert.ok(review?.responded_at);
  assert.equal(referral?.status, "responded");
});

test("recordRequestResponses never touches a request that is already 'responded' or beyond (no reset on a second reply)", async () => {
  const jobId = await makeJob();
  const messageId = await makeMessage(conversationId);
  const executionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: null },
    { kind: "sent", messageId, workflowExecutionId: executionId },
  );
  await recordRequestResponses(service, organizationId, contactId);
  const { data: firstResponse } = await service.from("referral_requests").select("responded_at").eq("job_id", jobId).single();

  await recordRequestResponses(service, organizationId, contactId);
  const { data: secondCheck } = await service.from("referral_requests").select("status, responded_at").eq("job_id", jobId).single();

  assert.equal(secondCheck?.status, "responded");
  assert.equal(secondCheck?.responded_at, firstResponse?.responded_at, "a second reply must never re-timestamp an already-responded request");
});

test("recordRequestResponses is a safe no-op for a contact with no pending request", async () => {
  const { data: freshContact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15555550155" }).select("id").single();
  await recordRequestResponses(service, organizationId, freshContact!.id);
  const { count } = await service.from("review_requests").select("id", { count: "exact", head: true }).eq("contact_id", freshContact!.id);
  assert.equal(count ?? 0, 0);
  await service.from("contacts").delete().eq("id", freshContact!.id);
});

// ==================== Security / RLS ====================

test("an org member can read their own organization's review/referral requests", async () => {
  const client = await signInAs(memberUser.email, memberUser.password);
  const { data, error } = await client.from("review_requests").select("id").eq("organization_id", organizationId);
  assert.equal(error, null);
  assert.ok(Array.isArray(data));
});

test("cross-org read is blocked - a member of another org sees zero rows for this org, even with the real id", async () => {
  const client = await signInAs(otherOwner.email, otherOwner.password);
  const { data } = await client.from("review_requests").select("id").eq("organization_id", organizationId);
  assert.equal(data?.length ?? 0, 0);
});

test("anonymous read and write are both blocked", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: readData } = await anon.from("review_requests").select("id").eq("organization_id", organizationId);
  assert.equal(readData?.length ?? 0, 0);

  const { data: writeData } = await anon.from("review_requests").update({ status: "completed" }).eq("organization_id", organizationId).select("id");
  assert.equal(writeData?.length ?? 0, 0);
});

test("cross-org update is blocked - a member of another org cannot mark this org's referral converted", async () => {
  const jobId = await makeJob();
  const messageId = await makeMessage(conversationId);
  const executionId = await makeExecution();
  await recordPostJobFollowupOutcome(
    service,
    { organizationId, jobId, contactId, conversationId: null, reviewUrl: null },
    { kind: "sent", messageId, workflowExecutionId: executionId },
  );

  const client = await signInAs(otherOwner.email, otherOwner.password);
  const { data: updated } = await client.from("referral_requests").update({ status: "converted" }).eq("job_id", jobId).select("id");
  assert.equal(updated?.length ?? 0, 0);

  const { data: unchanged } = await service.from("referral_requests").select("status").eq("job_id", jobId).single();
  assert.equal(unchanged?.status, "requested");
});
