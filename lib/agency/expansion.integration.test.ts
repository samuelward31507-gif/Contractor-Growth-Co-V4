/**
 * Integration tests for lib/agency/expansion.ts - Trackpr Phase 5A, Agency
 * Expansion Intelligence. Mirrors lib/agency/authorization.integration.test.ts's
 * exact fixture pattern (real, minted Supabase Auth sessions against the
 * real database - not a mocked client, since resolveAgencyOrganizations's
 * own is_agency_admin() SECURITY DEFINER RPC and RLS can only be proven
 * against a real JWT) and reuses the same pre-existing
 * agency-test-admin@example.com fixture already present in agency_admins -
 * this suite makes zero writes to agency_admins or agency_organizations
 * beyond its own test-scoped organization, and cleans up everything it
 * creates.
 *
 * Deliberately inserts directly into `opportunities` rather than running the
 * full detection pipeline (leads/estimates/appointments/jobs) - this suite is
 * about the AGGREGATION layer (lib/agency/expansion.ts), not the Opportunity
 * Engine's own detection logic, which has its own tests elsewhere and is
 * never modified or re-tested here.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/expansion.integration.test.ts
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
const { getAgencyExpansionOpportunities, getAgencyExpansionReadiness }: typeof import("./expansion") = require(path.join(REPO_ROOT, "lib/agency/expansion.ts"));

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
  const { data: authorizedOrg } = await service.from("organizations").insert({ name: "Expansion Test Authorized Org" }).select("id").single();
  authorizedOrgId = authorizedOrg!.id;
  cleanupOrgIds.push(authorizedOrgId);

  const { data: unauthorizedOrg } = await service.from("organizations").insert({ name: "Expansion Test Unauthorized Org" }).select("id").single();
  unauthorizedOrgId = unauthorizedOrg!.id;
  cleanupOrgIds.push(unauthorizedOrgId);

  const { data: clientOrg } = await service.from("organizations").insert({ name: "Expansion Test Client-Only Org" }).select("id").single();
  clientOrgId = clientOrg!.id;
  cleanupOrgIds.push(clientOrgId);

  // Only authorizedOrgId is ever associated with the agency - unauthorizedOrgId
  // and clientOrgId deliberately never get an agency_organizations row, which
  // is exactly what this suite's cross-tenant tests depend on.
  await service.from("agency_organizations").insert({ organization_id: authorizedOrgId });

  // Opportunities inserted directly (see this file's own header comment for
  // why) - one known-value monetary type, one unknown-value monetary type,
  // for the authorized org; one for the unauthorized org, which must never
  // appear in any resolved result below.
  await service.from("opportunities").insert([
    {
      organization_id: authorizedOrgId,
      type: "stale_estimate",
      status: "open",
      source_entity_type: "estimate",
      source_entity_id: "00000000-0000-0000-0000-000000000001",
      title: "Roof estimate expired",
      description: "Estimate expired with no decision.",
      estimated_value: 12500,
      value_basis: "estimates.amount",
    },
    {
      organization_id: authorizedOrgId,
      type: "dormant_customer",
      status: "open",
      source_entity_type: "contact",
      source_entity_id: "00000000-0000-0000-0000-000000000002",
      title: "Past customer gone quiet",
      description: "No completed job in the configured reactivation window.",
      estimated_value: null,
      value_basis: null,
    },
    {
      organization_id: unauthorizedOrgId,
      type: "stale_estimate",
      status: "open",
      source_entity_type: "estimate",
      source_entity_id: "00000000-0000-0000-0000-000000000003",
      title: "Should never be visible to this agency",
      description: "Cross-tenant isolation canary.",
      estimated_value: 99999,
      value_basis: "estimates.amount",
    },
  ]);

  const stamp = Date.now();
  clientUser = await createTestUser(`expansion-test-client-${stamp}@example.com`);
  await service.from("organization_members").insert({ organization_id: clientOrgId, user_id: clientUser.id, role: "owner" });

  // Reset the pre-existing fixture's password, exactly like
  // authorization.integration.test.ts - zero writes to agency_admins occur
  // anywhere in this file.
  agencyAdminPassword = `AgencyFixture-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { error } = await service.auth.admin.updateUserById(EXISTING_AGENCY_ADMIN_USER_ID, { password: agencyAdminPassword });
  if (error) throw new Error(`failed to reset fixture password: ${error.message}`);
});

after(async () => {
  await service.from("opportunities").delete().in("organization_id", cleanupOrgIds);
  await service.from("agency_organizations").delete().eq("organization_id", authorizedOrgId);
  for (const orgId of cleanupOrgIds) {
    await service.from("organization_members").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
});

test("1. an authorized agency admin sees the authorized organization's open opportunities, with the correct organization name attached", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyExpansionOpportunities(client, service);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const forAuthorizedOrg = result.opportunities.filter((o) => o.organizationId === authorizedOrgId);
  assert.equal(forAuthorizedOrg.length, 2);
  assert.ok(forAuthorizedOrg.every((o) => o.organizationName === "Expansion Test Authorized Org"));
});

test("2. cross-tenant isolation: the unauthorized organization's opportunity never appears, even though it exists in the database", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyExpansionOpportunities(client, service);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const leaked = result.opportunities.filter((o) => o.organizationId === unauthorizedOrgId);
  assert.equal(leaked.length, 0, "an organization never added to agency_organizations must never appear in the agency's expansion opportunities, matching resolveAgencyOrganizations's own guarantee");
});

test("3. known opportunity value aggregates correctly and null estimated values are never converted to zero", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyExpansionOpportunities(client, service);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const staleEstimate = result.opportunities.find((o) => o.organizationId === authorizedOrgId && o.type === "stale_estimate");
  const dormantCustomer = result.opportunities.find((o) => o.organizationId === authorizedOrgId && o.type === "dormant_customer");

  assert.equal(staleEstimate?.estimatedValue, 12500);
  assert.equal(dormantCustomer?.estimatedValue, null, "dormant_customer's genuinely unknown value must stay null on the individual item, never coerced to 0");

  assert.ok(result.summary.knownOpportunityValue >= 12500, "the summary's known value must include the real $12,500 stale estimate");
  assert.ok(result.summary.unknownValueOpportunityCount >= 1, "the dormant_customer opportunity must be counted as unknown-value, not silently dropped or summed as $0");
});

test("4. the recommended-service mapping is applied correctly for real, persisted opportunity rows", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyExpansionOpportunities(client, service);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const staleEstimate = result.opportunities.find((o) => o.organizationId === authorizedOrgId && o.type === "stale_estimate");
  const dormantCustomer = result.opportunities.find((o) => o.organizationId === authorizedOrgId && o.type === "dormant_customer");

  assert.equal(staleEstimate?.recommendedService, "Estimate Recovery");
  assert.equal(dormantCustomer?.recommendedService, "Customer Reactivation");
});

test("5. an ordinary client/contractor org owner is denied - not_agency_admin, never given any organization's opportunity data", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const result = await getAgencyExpansionOpportunities(client, service);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not_agency_admin");
});

test("6. an unauthenticated (anon) caller is denied - unauthenticated, never reaches the opportunities read", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = await getAgencyExpansionOpportunities(anon, service);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unauthenticated");
});

test("7. getAgencyExpansionReadiness follows the exact same authorization chokepoint - denied for a non-admin, authorized organizations only for the admin", async () => {
  const clientSession = await signInAs(clientUser.email, clientUser.password);
  const deniedResult = await getAgencyExpansionReadiness(clientSession, service);
  assert.equal(deniedResult.ok, false);
  if (!deniedResult.ok) assert.equal(deniedResult.reason, "not_agency_admin");

  const adminSession = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const allowedResult = await getAgencyExpansionReadiness(adminSession, service);
  assert.equal(allowedResult.ok, true);
  if (!allowedResult.ok) return;

  const authorizedClient = allowedResult.clients.find((c) => c.organizationId === authorizedOrgId);
  const leakedClient = allowedResult.clients.find((c) => c.organizationId === unauthorizedOrgId);
  assert.ok(authorizedClient, "the authorized organization's readiness must be present");
  assert.equal(leakedClient, undefined, "an organization outside agency_organizations must never appear in the readiness result either");
  assert.equal(authorizedClient!.readiness.items.length, 7, "computeOnboardingReadiness's own 7 real items, never a fabricated or trimmed set");
});

test("8. granting agency-admin status does not touch organization_members - the client user's own membership/role is unaffected by anything in this suite", async () => {
  const { data } = await service.from("organization_members").select("role").eq("organization_id", clientOrgId).eq("user_id", clientUser.id).single();
  assert.equal(data?.role, "owner");
});
