/**
 * Integration tests for lib/agency/cost-readiness.ts - Trackpr Phase 5C,
 * Cost Readiness. Mirrors lib/agency/usage.integration.test.ts's exact
 * fixture pattern (real, minted Supabase Auth sessions against the real
 * database - resolveAgencyOrganizations's own is_agency_admin() SECURITY
 * DEFINER RPC and RLS can only be proven against a real JWT) and reuses the
 * same pre-existing agency-test-admin@example.com fixture already present in
 * agency_admins - this suite makes zero writes to agency_admins and cleans
 * up everything it creates.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/cost-readiness.integration.test.ts
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
const { getAgencyCostReadiness }: typeof import("./cost-readiness") = require(path.join(REPO_ROOT, "lib/agency/cost-readiness.ts"));

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

before(async () => {
  const { data: authorizedOrg } = await service.from("organizations").insert({ name: "Cost Readiness Test Authorized Org" }).select("id").single();
  authorizedOrgId = authorizedOrg!.id;
  cleanupOrgIds.push(authorizedOrgId);

  const { data: unauthorizedOrg } = await service.from("organizations").insert({ name: "Cost Readiness Test Unauthorized Org" }).select("id").single();
  unauthorizedOrgId = unauthorizedOrg!.id;
  cleanupOrgIds.push(unauthorizedOrgId);

  const { data: clientOrg } = await service.from("organizations").insert({ name: "Cost Readiness Test Client-Only Org" }).select("id").single();
  clientOrgId = clientOrg!.id;
  cleanupOrgIds.push(clientOrg!.id);

  await service.from("agency_organizations").insert({ organization_id: authorizedOrgId });

  // Real AI interactions with a real, complete usage object - exactly the
  // shape app/api/automation/n8n-callback/route.ts actually stores
  // (`output: aiResult`, aiResult.usage.{input_tokens,output_tokens,total_tokens}).
  await service.from("ai_interactions").insert([
    { organization_id: authorizedOrgId, interaction_type: "lead_followup_response", model: "claude-sonnet-5", tokens_used: 150, output: { model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } },
    { organization_id: authorizedOrgId, interaction_type: "lead_followup_response", model: "claude-sonnet-5", tokens_used: null, output: { model: "claude-sonnet-5" } },
  ]);

  // Canary: a distinguishable, larger token value on the unauthorized org -
  // if scoping is broken, this leaks into the authorized org's own sum.
  await service.from("ai_interactions").insert({
    organization_id: unauthorizedOrgId,
    interaction_type: "lead_followup_response",
    model: "claude-sonnet-5",
    tokens_used: 99999,
    output: { model: "claude-sonnet-5", usage: { input_tokens: 88888, output_tokens: 77777, total_tokens: 99999 } },
  });

  const stamp = Date.now();
  clientUser = await createTestUser(`cost-readiness-test-client-${stamp}@example.com`);
  await service.from("organization_members").insert({ organization_id: clientOrgId, user_id: clientUser.id, role: "owner" });

  agencyAdminPassword = `AgencyFixture-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { error } = await service.auth.admin.updateUserById(EXISTING_AGENCY_ADMIN_USER_ID, { password: agencyAdminPassword });
  if (error) throw new Error(`failed to reset fixture password: ${error.message}`);
});

after(async () => {
  for (const orgId of cleanupOrgIds) {
    await service.from("ai_interactions").delete().eq("organization_id", orgId);
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

test("1. an authorized agency admin sees cost readiness for the authorized organization, with correct AI token extraction", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyCostReadiness(client, service);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.costReadiness.clients.find((c) => c.organizationId === authorizedOrgId);
  assert.ok(authorized, "the authorized organization must appear");
  assert.equal(authorized!.ai.inputTokens, 100, "must be exactly the one interaction that reported input_tokens - never inferred, never summed with the null-usage interaction");
  assert.equal(authorized!.ai.outputTokens, 50);
  assert.equal(authorized!.ai.totalTokens, 150, "totalTokens must match the existing tokens_used-column sum (the pass-through from ClientUsageSummary), not a re-derived JSONB sum");
});

test("2. cross-tenant isolation: the unauthorized organization's canary token values never leak into the authorized organization's own totals", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyCostReadiness(client, service);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const leaked = result.costReadiness.clients.find((c) => c.organizationId === unauthorizedOrgId);
  assert.equal(leaked, undefined, "an organization never added to agency_organizations must never appear");

  const authorized = result.costReadiness.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.equal(authorized.ai.inputTokens, 100, "the unauthorized org's 88888-input-token canary must never be summed in");
  assert.equal(authorized.ai.outputTokens, 50, "the unauthorized org's 77777-output-token canary must never be summed in");

  const leakedUsageClient = result.usage.clients.find((c) => c.organizationId === unauthorizedOrgId);
  assert.equal(leakedUsageClient, undefined, "the pass-through usage.clients list must also never leak the unauthorized organization");
});

test("3. pricingStatus is always the literal 'unpriced' for every usage category - never a computed value", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyCostReadiness(client, service);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.costReadiness.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.equal(authorized.messaging.pricingStatus, "unpriced");
  assert.equal(authorized.ai.pricingStatus, "unpriced");
  assert.equal(authorized.voice.pricingStatus, "unpriced");
  assert.equal(authorized.automation.pricingStatus, "unpriced");
});

test("4. revenue, variableCost, and contributionMargin are always the literal 'unavailable' status - never a number, never $0", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyCostReadiness(client, service);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.costReadiness.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.deepEqual(authorized.revenue, { status: "unavailable" });
  assert.deepEqual(authorized.variableCost, { status: "unavailable" });
  assert.deepEqual(authorized.contributionMargin, { status: "unavailable" });
});

test("5. the pass-through usage.clients/usage.totals exactly matches what the existing Phase 5B usage summary already produces - the existing page's own data is unmodified by this phase", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyCostReadiness(client, service);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorizedUsage = result.usage.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.equal(authorizedUsage.ai.interactions, 2);
  assert.equal(authorizedUsage.ai.tokens, 150);
  assert.equal(authorizedUsage.ai.interactionsWithUsageData, 1);
  assert.equal(result.usage.totals.organizationCount, 1);
});

test("6. an ordinary client/contractor org owner is denied - not_agency_admin, never given any organization's cost readiness data", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const result = await getAgencyCostReadiness(client, service);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not_agency_admin");
});

test("7. an unauthenticated (anon) caller is denied - unauthenticated, never reaches the cost readiness read", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = await getAgencyCostReadiness(anon, service);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unauthenticated");
});
