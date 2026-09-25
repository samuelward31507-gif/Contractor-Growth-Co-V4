/**
 * L4 (pre-launch lead-leak audit): integration tests proving both
 * lead-followup dispatch-failure boundaries in
 * lib/automation/lead-followup.ts (event creation, workflow-execution start)
 * now persist an automation_incidents row via the existing
 * recordAutomationHealthSignal helper, additively alongside the existing
 * console.error-only logging - exactly the same shape of fix already proven
 * for HANDOFF-01. Mirrors this codebase's own established session-creation
 * pattern for exercising a session-scoped function directly (see
 * app/(app)/jobs/actions.referral-lead.integration.test.ts's own identical
 * createTestUser/signInAs harness) since emitLeadCreatedFollowup requires a
 * real auth.uid(), unlike its *AsService sibling.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/automation/lead-followup.incident.integration.test.ts"
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
const { emitLeadCreatedFollowup, emitLeadCreatedFollowupAsService }: typeof import("./lead-followup") = require(path.join(REPO_ROOT, "lib/automation/lead-followup.ts"));
const { startWorkflowExecutionAsService }: typeof import("./executions") = require(path.join(REPO_ROOT, "lib/automation/executions.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// The RPC's own idempotency-key length guard (MAX_IDEMPOTENCY_KEY_LENGTH =
// 200 in lib/automation/events.ts) is the one deterministic, real,
// pre-RPC-call failure available without mocking anything - a lead id long
// enough that `lead.created:${leadId}` exceeds that limit reliably fails
// createAutomationEvent(AsService) with a real, typed validation error,
// exercising the exact same code path a genuine RPC failure would.
const OVERSIZED_LEAD_ID = "x".repeat(250);

async function createTestUser(email: string, testUserIds: string[]) {
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

/**
 * emitLeadCreatedFollowup(AsService)'s own n8n-dispatch call uses Next.js's
 * after(), which has no valid scope outside a real Next.js request - the
 * same established, documented test-harness limitation as
 * actions.referral-lead.integration.test.ts. Only reached on a genuine
 * success (an incident is never recorded on that path), so this only ever
 * needs to be caught around the one success-regression test below.
 */
async function callIgnoringAfterScope(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error && err.message.includes("`after` was called outside a request scope")) return;
    throw err;
  }
}

let organizationId: string;
let otherOrgId: string;
let userId: string;
let sessionSupabase: ReturnType<typeof createSupabaseClient>;
const testUserIds: string[] = [];

async function findLeadDispatchIncident(orgId: string, leadId: string) {
  const { data } = await service
    .from("automation_incidents")
    .select("id, status, category, severity, occurrence_count, metadata, description")
    .eq("organization_id", orgId)
    .eq("category", "n8n_dispatch_failed")
    .eq("fingerprint", `n8n_dispatch_failed:${leadId}`)
    .maybeSingle();
  return data;
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "L4 Lead Dispatch Incident Test Org", payment_status: "active", automation_mode: "live" }).select("id").single();
  organizationId = org!.id;

  const stamp = Date.now();
  const memberUser = await createTestUser(`l4-lead-dispatch-${stamp}@example.com`, testUserIds);
  await service.from("organization_members").insert({ organization_id: organizationId, user_id: memberUser.id, role: "member" });
  userId = memberUser.id;
  sessionSupabase = await signInAs(memberUser.email, memberUser.password);

  const { data: other } = await service.from("organizations").insert({ name: "L4 Lead Dispatch Incident Test Org (Other)" }).select("id").single();
  otherOrgId = other!.id;
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("automation_incidents").delete().eq("organization_id", orgId);
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("leads").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organization_members").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const id of testUserIds) {
    await service.auth.admin.deleteUser(id);
  }
  void userId;
});

test("A. emitLeadCreatedFollowup: an event-creation failure (idempotency key too long) records an open n8n_dispatch_failed incident, failureStage=event_creation", async () => {
  await emitLeadCreatedFollowup(sessionSupabase, {
    leadId: OVERSIZED_LEAD_ID,
    contactId: "00000000-0000-4000-8000-000000000000",
    organizationId,
    source: "manual",
    service: "Test",
    status: "new",
    temperature: "cold",
    estimatedValue: null,
  });

  const incident = await findLeadDispatchIncident(organizationId, OVERSIZED_LEAD_ID);
  assert.ok(incident, "expected an open n8n_dispatch_failed incident for the oversized-idempotency-key event-creation failure");
  assert.equal(incident?.category, "n8n_dispatch_failed");
  assert.equal(incident?.status, "open");
  assert.equal(incident?.occurrence_count, 1);
  const metadata = incident?.metadata as { leadId?: string; organizationId?: string; failureStage?: string; eventId?: string | null };
  assert.equal(metadata.leadId, OVERSIZED_LEAD_ID);
  assert.equal(metadata.organizationId, organizationId);
  assert.equal(metadata.failureStage, "event_creation");
  assert.equal(metadata.eventId, null, "no event was ever created on this failure boundary");
});

test("B. emitLeadCreatedFollowupAsService: the same event-creation failure records an open n8n_dispatch_failed incident, failureStage=event_creation", async () => {
  const leadId = OVERSIZED_LEAD_ID + "-b";

  await emitLeadCreatedFollowupAsService(service, {
    leadId,
    contactId: "00000000-0000-4000-8000-000000000001",
    organizationId,
    source: "lead_capture_api",
    service: "Test",
    status: "new",
    temperature: "cold",
    estimatedValue: null,
  });

  const incident = await findLeadDispatchIncident(organizationId, leadId);
  assert.ok(incident, "expected an open n8n_dispatch_failed incident (AsService path)");
  assert.equal(incident?.category, "n8n_dispatch_failed");
  assert.equal(incident?.status, "open");
  const metadata = incident?.metadata as { failureStage?: string };
  assert.equal(metadata.failureStage, "event_creation");
});

test("D. idempotency: a repeated event-creation failure for the SAME lead never creates a second open incident, only increments occurrence_count", async () => {
  const leadId = OVERSIZED_LEAD_ID + "-dedup";
  const input = {
    leadId,
    contactId: "00000000-0000-4000-8000-000000000002",
    organizationId,
    source: "manual" as const,
    service: "Test",
    status: "new" as const,
    temperature: "cold" as const,
    estimatedValue: null,
  };

  await emitLeadCreatedFollowup(sessionSupabase, input);
  await emitLeadCreatedFollowup(sessionSupabase, input);
  await emitLeadCreatedFollowup(sessionSupabase, input);

  const { data: incidents } = await service
    .from("automation_incidents")
    .select("id, occurrence_count")
    .eq("organization_id", organizationId)
    .eq("category", "n8n_dispatch_failed")
    .eq("fingerprint", `n8n_dispatch_failed:${leadId}`);
  assert.equal(incidents?.length, 1, "repeated failures for the same lead must never flood into multiple open incidents");
  assert.equal(incidents?.[0]?.occurrence_count, 3, "each repeated failure must still increment the same incident's occurrence_count");
});

test("E. success regression: a fully successful lead.created dispatch creates no n8n_dispatch_failed incident", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: `+1555557${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const { data: lead } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contact!.id, service: "Test", status: "new", temperature: "cold" }).select("id").single();
  const leadId = lead!.id as string;

  await callIgnoringAfterScope(() =>
    emitLeadCreatedFollowup(sessionSupabase, {
      leadId,
      contactId: contact!.id,
      organizationId,
      source: "manual",
      service: "Test",
      status: "new",
      temperature: "cold",
      estimatedValue: null,
    }),
  );

  const { data: event } = await service.from("automation_events").select("id, status").eq("organization_id", organizationId).eq("idempotency_key", `lead.created:${leadId}`).maybeSingle();
  assert.ok(event, "a successful dispatch must still create a real automation_events row");

  const incident = await findLeadDispatchIncident(organizationId, leadId);
  assert.equal(incident, null, "a fully successful dispatch must never create an n8n_dispatch_failed incident");
});

test("F. non-throwing: when the incident RPC ITSELF also rejects the call (not just event-creation), emitLeadCreatedFollowup still never throws", async () => {
  // record_automation_incident_signal's own server-side validation rejects
  // any fingerprint over 300 chars (see the automation_health_and_alerting
  // migration). A 400-char lead id fails createAutomationEvent's
  // idempotency-key-length check first (putting us on the event-creation
  // failure branch, same as test A), AND ALSO makes the resulting
  // `n8n_dispatch_failed:${leadId}` fingerprint exceed the RPC's own 300-char
  // limit - so recordAutomationHealthSignal's own RPC call genuinely fails
  // too, a real double-failure, not a synthetic one.
  const leadId = "y".repeat(400);
  await assert.doesNotReject(
    emitLeadCreatedFollowup(sessionSupabase, {
      leadId,
      contactId: "00000000-0000-4000-8000-000000000003",
      organizationId,
      source: "manual",
      service: "Test",
      status: "new",
      temperature: "cold",
      estimatedValue: null,
    }),
    "emitLeadCreatedFollowup must never throw, even when its own incident-recording call also fails at the RPC level",
  );

  const incident = await findLeadDispatchIncident(organizationId, leadId);
  assert.equal(incident, null, "the oversized fingerprint must have been genuinely rejected by the RPC, not silently accepted");
});

test("G. organization isolation: a lead-dispatch incident for org A is never visible scoped under org B", async () => {
  const leadId = OVERSIZED_LEAD_ID + "-isolation";
  await emitLeadCreatedFollowup(sessionSupabase, {
    leadId,
    contactId: "00000000-0000-4000-8000-000000000004",
    organizationId,
    source: "manual",
    service: "Test",
    status: "new",
    temperature: "cold",
    estimatedValue: null,
  });

  const crossOrg = await findLeadDispatchIncident(otherOrgId, leadId);
  assert.equal(crossOrg, null, "an org A lead-dispatch incident must never be readable scoped under org B");

  const ownOrg = await findLeadDispatchIncident(organizationId, leadId);
  assert.ok(ownOrg, "the incident must still exist under its own, correct organization");
});

/**
 * C. Workflow-execution-start failure (Boundary 2) - documented testability
 * limitation, not skipped silently. emitLeadCreatedFollowup(AsService) only
 * ever calls startWorkflowExecution(AsService) once per lead, on that lead's
 * FIRST, non-duplicate automation_events row - createAutomationEvent(AsService)'s
 * own idempotency-key dedup means any pre-existing row for that lead id
 * (however it got there) makes a second real call return duplicate:true and
 * return BEFORE ever reaching startWorkflowExecution(AsService) again. There
 * is no external state that can be manipulated ahead of time to make THAT
 * one, first, fresh call's own startWorkflowExecution(AsService) invocation
 * fail without either (a) a test-only injectable seam in lead-followup.ts
 * itself - not in this task's authorized scope - or (b) ES-module-level
 * mocking, a technique not used anywhere else in this codebase's test suite.
 * This test instead verifies, directly and for real (no mocking), that
 * startWorkflowExecutionAsService itself genuinely fails for a real,
 * malformed input the way the codebase already expects
 * (mapExecutionRpcError's own established error-mapping contract) - proving
 * the underlying call CAN fail in the exact shape lead-followup.ts's
 * boundary-2 branch handles - and relies on code review plus tests A/B/D/E/
 * F/G (which exercise the byte-identical, shared emitLeadDispatchFailureSignal
 * helper that boundary 2 also calls, with only `failureStage`/`eventId`
 * differing) to establish confidence in the branch itself. See this
 * implementation's final report for the full, explicit reasoning.
 */
test("C. startWorkflowExecutionAsService itself genuinely fails for a real, non-existent automation_event id (the underlying condition boundary 2 handles)", async () => {
  const result = await startWorkflowExecutionAsService(service, "00000000-0000-4000-8000-0000000000ff", "lead_created_followup");
  assert.equal(result.ok, false, "starting an execution against a non-existent automation_event id must fail, never silently succeed");
});
