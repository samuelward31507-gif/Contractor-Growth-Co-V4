/**
 * Integration tests for lib/agency/usage.ts - Trackpr Phase 5B, Agency
 * Client Usage Intelligence. Mirrors lib/agency/expansion.integration.test.ts's
 * exact fixture pattern (real, minted Supabase Auth sessions against the
 * real database - resolveAgencyOrganizations's own is_agency_admin()
 * SECURITY DEFINER RPC and RLS can only be proven against a real JWT) and
 * reuses the same pre-existing agency-test-admin@example.com fixture already
 * present in agency_admins - this suite makes zero writes to agency_admins
 * and cleans up everything it creates.
 *
 * Seeds real rows directly (messages, ai_interactions, workflow_executions,
 * automation_events) rather than exercising the full production automation
 * pipeline - this suite is about the AGGREGATION layer
 * (lib/agency/usage.ts) and the real BI functions it reads through, not
 * about re-testing automation dispatch, which has its own tests elsewhere.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/usage.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
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
const { getAgencyUsageSummary }: typeof import("./usage") = require(path.join(REPO_ROOT, "lib/agency/usage.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const EXISTING_AGENCY_ADMIN_USER_ID = "fcfaac02-ece5-402a-af3f-3af1cbccd049";
const EXISTING_AGENCY_ADMIN_EMAIL = "agency-test-admin@example.com";

let authorizedOrgId: string;
let unauthorizedOrgId: string;
let clientOrgId: string;
let clientUser: { id: string; email: string; password: string };
let agencyAdminPassword: string;
const testUserIds: string[] = [];
const cleanupOrgIds: string[] = [];

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
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

/** Seeds one conversation + the requested messages/ai_interactions/workflow_execution/missed-call event for a given org - real rows, exercised through the real BI queries, not a mock. */
async function seedUsageData(organizationId: string, canary: boolean) {
  const { data: conversation } = await service.from("conversations").insert({ organization_id: organizationId, channel: "sms" }).select("id").single();

  await service.from("messages").insert([
    { organization_id: organizationId, conversation_id: conversation!.id, direction: "inbound", sender_type: "customer", body: canary ? "canary inbound" : "real inbound", status: "received" },
    { organization_id: organizationId, conversation_id: conversation!.id, direction: "outbound", sender_type: "ai", body: canary ? "canary outbound" : "real outbound", status: "delivered" },
  ]);

  await service.from("ai_interactions").insert([
    { organization_id: organizationId, interaction_type: "lead_followup_response", model: "claude-sonnet-5", tokens_used: canary ? 99999 : 150, output: {} },
    { organization_id: organizationId, interaction_type: "lead_followup_response", model: "claude-sonnet-5", tokens_used: null, output: {} },
  ]);

  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: organizationId, event_type: "lead.created", entity_type: "lead", entity_id: null, payload: {}, status: "completed" })
    .select("id")
    .single();
  await service.from("workflow_executions").insert({ organization_id: organizationId, automation_event_id: event!.id, workflow_name: "lead_created_followup", status: "completed", attempt: 1, started_at: new Date().toISOString(), completed_at: new Date().toISOString() });

  await service.from("automation_events").insert({ organization_id: organizationId, event_type: "call.missed", entity_type: "lead", entity_id: null, payload: {}, status: "completed" });
}

before(async () => {
  const { data: authorizedOrg } = await service.from("organizations").insert({ name: "Usage Test Authorized Org" }).select("id").single();
  authorizedOrgId = authorizedOrg!.id;
  cleanupOrgIds.push(authorizedOrgId);

  const { data: unauthorizedOrg } = await service.from("organizations").insert({ name: "Usage Test Unauthorized Org" }).select("id").single();
  unauthorizedOrgId = unauthorizedOrg!.id;
  cleanupOrgIds.push(unauthorizedOrgId);

  const { data: clientOrg } = await service.from("organizations").insert({ name: "Usage Test Client-Only Org" }).select("id").single();
  clientOrgId = clientOrg!.id;
  cleanupOrgIds.push(clientOrgId);

  // Only authorizedOrgId is ever associated with the agency.
  await service.from("agency_organizations").insert({ organization_id: authorizedOrgId });

  await seedUsageData(authorizedOrgId, false);
  // The unauthorized org gets a deliberately larger, distinguishable "canary"
  // token value (99999) and its own extra message/missed-call - if any of
  // this leaks into the authorized org's own totals, the exact-count
  // assertions below will fail.
  await seedUsageData(unauthorizedOrgId, true);

  const stamp = Date.now();
  clientUser = await createTestUser(`usage-test-client-${stamp}@example.com`);
  await service.from("organization_members").insert({ organization_id: clientOrgId, user_id: clientUser.id, role: "owner" });

  agencyAdminPassword = `AgencyFixture-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { error } = await service.auth.admin.updateUserById(EXISTING_AGENCY_ADMIN_USER_ID, { password: agencyAdminPassword });
  if (error) throw new Error(`failed to reset fixture password: ${error.message}`);
});

after(async () => {
  for (const orgId of cleanupOrgIds) {
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("ai_interactions").delete().eq("organization_id", orgId);
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("organization_members").delete().eq("organization_id", orgId);
  }
  await service.from("agency_organizations").delete().eq("organization_id", authorizedOrgId);
  for (const orgId of cleanupOrgIds) {
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
});

test("1. an authorized agency admin sees the authorized organization's usage, with the correct organization name attached", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyUsageSummary(client, service);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId);
  assert.ok(authorized, "the authorized organization must appear");
  assert.equal(authorized!.organizationName, "Usage Test Authorized Org");
});

test("2. cross-tenant isolation: the unauthorized organization never appears, and its data never leaks into the authorized organization's own counts", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyUsageSummary(client, service);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const leaked = result.clients.find((c) => c.organizationId === unauthorizedOrgId);
  assert.equal(leaked, undefined, "an organization never added to agency_organizations must never appear in the agency's usage summary");

  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.equal(authorized.ai.tokens, 150, "the unauthorized org's 99999-token canary interaction must never be summed into the authorized org's own token total");
  assert.equal(authorized.messaging.total, 2, "the unauthorized org's own messages must never inflate the authorized org's message count");
  assert.equal(authorized.voice.missedCalls, 1, "the unauthorized org's own missed-call event must never inflate the authorized org's missed-call count");
});

test("3. messaging counts and full status breakdown reflect the real seeded rows exactly", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyUsageSummary(client, service);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.equal(authorized.messaging.inbound, 1);
  assert.equal(authorized.messaging.outbound, 1);
  assert.equal(authorized.messaging.total, 2);
  assert.equal(authorized.messaging.byStatus.received, 1);
  assert.equal(authorized.messaging.byStatus.delivered, 1);
});

test("4. a genuinely null-token AI interaction never corrupts the token total, and interactionsWithUsageData reflects only the interaction that reported real usage", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyUsageSummary(client, service);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.equal(authorized.ai.interactions, 2, "both interactions must be counted, including the one with no usage data");
  assert.equal(authorized.ai.interactionsWithUsageData, 1);
  assert.equal(authorized.ai.tokens, 150, "must be exactly the one real reported value, never inflated by the null interaction and never coerced to a fabricated combined figure");
});

test("5. automation execution counts and missed-call count reflect the real seeded rows exactly", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyUsageSummary(client, service);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.equal(authorized.automation.executions, 1);
  assert.equal(authorized.automation.successful, 1);
  assert.equal(authorized.voice.missedCalls, 1);
});

test("6. an ordinary client/contractor org owner is denied - not_agency_admin, never given any organization's usage data", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const result = await getAgencyUsageSummary(client, service);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not_agency_admin");
});

test("7. an unauthenticated (anon) caller is denied - unauthenticated, never reaches the usage read", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = await getAgencyUsageSummary(anon, service);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unauthenticated");
});

test("8. granting agency-admin status does not touch organization_members - the client user's own membership/role is unaffected by anything in this suite", async () => {
  const { data } = await service.from("organization_members").select("role").eq("organization_id", clientOrgId).eq("user_id", clientUser.id).single();
  assert.equal(data?.role, "owner");
});
