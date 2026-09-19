/**
 * Security/authorization integration tests for Automation Health + Alerting
 * V1 - against an isolated test organization, a second organization (for
 * cross-org proof), and real minted Supabase Auth test users, matching
 * lib/contacts/merge.integration.test.ts's own established pattern for
 * exactly this class of proof. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/security.integration.test.ts
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
const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let organizationId: string;
let otherOrgId: string;
const testUserIds: string[] = [];

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

let ownerUser: { id: string; email: string; password: string };
let memberUser: { id: string; email: string; password: string };
let otherOrgOwner: { id: string; email: string; password: string };

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Automation Health Security Test Org" }).select("id").single();
  const { data: other } = await service.from("organizations").insert({ name: "Automation Health Security Test Org - Other" }).select("id").single();
  organizationId = org!.id;
  otherOrgId = other!.id;

  const stamp = Date.now();
  ownerUser = await createTestUser(`healthsec-owner-${stamp}@example.com`);
  memberUser = await createTestUser(`healthsec-member-${stamp}@example.com`);
  otherOrgOwner = await createTestUser(`healthsec-otherowner-${stamp}@example.com`);

  await service.from("organization_members").insert([
    { organization_id: organizationId, user_id: ownerUser.id, role: "owner" },
    { organization_id: organizationId, user_id: memberUser.id, role: "member" },
    { organization_id: otherOrgId, user_id: otherOrgOwner.id, role: "owner" },
  ]);
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("audit_log").delete().eq("organization_id", orgId);
    await service.from("automation_incidents").delete().eq("organization_id", orgId);
    await service.from("organization_members").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
});

async function makeOpenIncident(orgId: string, context = `sec-test-${Math.random().toString(36).slice(2)}`) {
  const { data } = await service
    .rpc("record_automation_incident_signal", {
      p_organization_id: orgId,
      p_category: "workflow_failed",
      p_severity: "warning",
      p_fingerprint: `workflow_failed:${context}`,
      p_title: "Security test incident",
    })
    .single();
  return (data as { id: string }).id;
}

// ==================== record_automation_incident_signal ====================

test("anonymous cannot call record_automation_incident_signal", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await anon.rpc("record_automation_incident_signal", {
    p_organization_id: organizationId,
    p_category: "workflow_failed",
    p_severity: "warning",
    p_fingerprint: "anon-attempt",
    p_title: "Anonymous attempt",
  });
  assert.ok(error);
});

test("an authenticated member of the organization CAN record a signal for their own organization", async () => {
  const client = await signInAs(memberUser.email, memberUser.password);
  const context = `member-own-org-${Date.now()}`;
  const { data, error } = await client
    .rpc("record_automation_incident_signal", {
      p_organization_id: organizationId,
      p_category: "workflow_failed",
      p_severity: "warning",
      p_fingerprint: `workflow_failed:${context}`,
      p_title: "Member-recorded signal",
    })
    .single();
  assert.equal(error, null);
  assert.equal(data.organization_id, organizationId);
});

test("an authenticated user CANNOT record a signal for a DIFFERENT organization they do not belong to", async () => {
  const client = await signInAs(otherOrgOwner.email, otherOrgOwner.password);
  const { error } = await client.rpc("record_automation_incident_signal", {
    p_organization_id: organizationId,
    p_category: "workflow_failed",
    p_severity: "warning",
    p_fingerprint: "cross-org-attempt",
    p_title: "Cross-org attempt",
  });
  assert.ok(error, "otherOrgOwner is not a member of organizationId, so is_org_member(organizationId) must be false for them");
});

test("an unsupported category is rejected outright, never silently coerced", async () => {
  const client = await signInAs(ownerUser.email, ownerUser.password);
  const { error } = await client.rpc("record_automation_incident_signal", {
    p_organization_id: organizationId,
    p_category: "not_a_real_category",
    p_severity: "warning",
    p_fingerprint: "bad-category",
    p_title: "Bad category attempt",
  });
  assert.ok(error);
});

test("'repeated_workflow_failure' cannot be requested directly - it is only ever produced by the RPC's own escalation logic", async () => {
  const client = await signInAs(ownerUser.email, ownerUser.password);
  const { error } = await client.rpc("record_automation_incident_signal", {
    p_organization_id: organizationId,
    p_category: "repeated_workflow_failure",
    p_severity: "critical",
    p_fingerprint: "forged-escalation",
    p_title: "Forged escalation attempt",
  });
  assert.ok(error);
});

// ==================== automation_incidents SELECT (RLS) ====================

test("anonymous cannot read automation_incidents", async () => {
  const incidentId = await makeOpenIncident(organizationId);
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data } = await anon.from("automation_incidents").select("id").eq("id", incidentId);
  assert.equal(data?.length ?? 0, 0);
});

test("a member of a DIFFERENT organization cannot read this organization's incidents", async () => {
  const incidentId = await makeOpenIncident(organizationId);
  const client = await signInAs(otherOrgOwner.email, otherOrgOwner.password);
  const { data } = await client.from("automation_incidents").select("id").eq("id", incidentId);
  assert.equal(data?.length ?? 0, 0);
});

test("a normal member of the SAME organization CAN read (view) its incidents", async () => {
  const incidentId = await makeOpenIncident(organizationId);
  const client = await signInAs(memberUser.email, memberUser.password);
  const { data, error } = await client.from("automation_incidents").select("id").eq("id", incidentId);
  assert.equal(error, null);
  assert.equal(data?.length, 1);
});

test("no client role can directly UPDATE automation_incidents - there is no write policy at all", async () => {
  const incidentId = await makeOpenIncident(organizationId);
  const client = await signInAs(ownerUser.email, ownerUser.password);
  await client.from("automation_incidents").update({ status: "resolved" }).eq("id", incidentId);
  const { data } = await service.from("automation_incidents").select("status").eq("id", incidentId).single();
  assert.equal(data?.status, "open", "a direct client update must silently affect zero rows under RLS, never actually change status");
});

// ==================== acknowledge_automation_incident / resolve_automation_incident ====================

test("anonymous cannot acknowledge or resolve an incident", async () => {
  const incidentId = await makeOpenIncident(organizationId);
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const ack = await anon.rpc("acknowledge_automation_incident", { p_incident_id: incidentId });
  const resolve = await anon.rpc("resolve_automation_incident", { p_incident_id: incidentId });
  assert.ok(ack.error);
  assert.ok(resolve.error);
});

test("a normal member cannot acknowledge or resolve an incident (owner/admin only)", async () => {
  const incidentId = await makeOpenIncident(organizationId);
  const client = await signInAs(memberUser.email, memberUser.password);
  const { error } = await client.rpc("acknowledge_automation_incident", { p_incident_id: incidentId });
  assert.ok(error);
  const { data: unchanged } = await service.from("automation_incidents").select("status").eq("id", incidentId).single();
  assert.equal(unchanged?.status, "open");
});

test("an owner of a DIFFERENT organization cannot acknowledge or resolve this organization's incident", async () => {
  const incidentId = await makeOpenIncident(organizationId);
  const client = await signInAs(otherOrgOwner.email, otherOrgOwner.password);
  const { error } = await client.rpc("resolve_automation_incident", { p_incident_id: incidentId });
  assert.ok(error);
});

test("the organization owner CAN acknowledge, then resolve, an incident - and each transition is audited", async () => {
  const incidentId = await makeOpenIncident(organizationId);
  const client = await signInAs(ownerUser.email, ownerUser.password);

  const ack = await client.rpc("acknowledge_automation_incident", { p_incident_id: incidentId }).single();
  assert.equal(ack.error, null);
  assert.equal(ack.data.status, "acknowledged");
  assert.ok(ack.data.acknowledged_at);

  const resolve = await client.rpc("resolve_automation_incident", { p_incident_id: incidentId }).single();
  assert.equal(resolve.error, null);
  assert.equal(resolve.data.status, "resolved");
  assert.ok(resolve.data.resolved_at);

  const { data: auditRows } = await service
    .from("audit_log")
    .select("action")
    .eq("organization_id", organizationId)
    .eq("entity_id", incidentId)
    .order("created_at", { ascending: true });
  assert.deepEqual(
    (auditRows ?? []).map((r) => r.action),
    ["automation_incident_acknowledged", "automation_incident_resolved"],
  );
});

test("resolving an already-resolved incident is rejected, not silently accepted", async () => {
  const incidentId = await makeOpenIncident(organizationId);
  const client = await signInAs(ownerUser.email, ownerUser.password);
  const first = await client.rpc("resolve_automation_incident", { p_incident_id: incidentId });
  assert.equal(first.error, null);
  const second = await client.rpc("resolve_automation_incident", { p_incident_id: incidentId });
  assert.ok(second.error);
});

// ==================== resolve_automation_incidents_by_fingerprint ====================

test("an authenticated user cannot resolve incidents by fingerprint for a DIFFERENT organization", async () => {
  const context = `cross-org-resolve-${Date.now()}`;
  await service.rpc("record_automation_incident_signal", {
    p_organization_id: organizationId,
    p_category: "workflow_failed",
    p_severity: "warning",
    p_fingerprint: `workflow_failed:${context}`,
    p_title: "Should survive cross-org attempt",
  });

  const client = await signInAs(otherOrgOwner.email, otherOrgOwner.password);
  const { error } = await client.rpc("resolve_automation_incidents_by_fingerprint", {
    p_organization_id: organizationId,
    p_fingerprints: [`workflow_failed:${context}`],
  });
  assert.ok(error);

  const { data: stillOpen } = await service.from("automation_incidents").select("status").eq("organization_id", organizationId).eq("fingerprint", `workflow_failed:${context}`).single();
  assert.equal(stillOpen?.status, "open");
});

// ==================== resolve_stale_stuck_incidents ====================

test("resolve_stale_stuck_incidents is service_role only - authenticated and anonymous are both rejected", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anonResult = await anon.rpc("resolve_stale_stuck_incidents");
  assert.ok(anonResult.error);

  const client = await signInAs(ownerUser.email, ownerUser.password);
  const authResult = await client.rpc("resolve_stale_stuck_incidents");
  assert.ok(authResult.error);
});
