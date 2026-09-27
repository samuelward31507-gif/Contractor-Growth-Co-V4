/**
 * Integration tests for lib/agency/revenue.ts - Trackpr Phase 5D-1, Revenue
 * Intelligence. Mirrors lib/agency/cost-readiness.integration.test.ts's exact
 * fixture pattern (real, minted Supabase Auth sessions against the real
 * database - resolveAgencyOrganizations's own is_agency_admin() SECURITY
 * DEFINER RPC and RLS can only be proven against a real JWT) and reuses the
 * same pre-existing agency-test-admin@example.com fixture already present in
 * agency_admins - this suite makes zero writes to agency_admins and cleans up
 * everything it creates, including every revenue_events row it inserts.
 *
 * REQUIRES the revenue_events table and organizations.stripe_customer_id/
 * stripe_subscription_id columns from
 * supabase/migrations/20260926120000_revenue_intelligence.sql to already be
 * applied to the target database - these tests will fail with a clear
 * Postgres error ("relation \"revenue_events\" does not exist") until that
 * migration has been run.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/revenue.integration.test.ts
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
const { getAgencyRevenue }: typeof import("./revenue") = require(path.join(REPO_ROOT, "lib/agency/revenue.ts"));

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
  const { data: authorizedOrg } = await service.from("organizations").insert({ name: "Revenue Test Authorized Org" }).select("id").single();
  authorizedOrgId = authorizedOrg!.id;
  cleanupOrgIds.push(authorizedOrgId);

  const { data: unauthorizedOrg } = await service.from("organizations").insert({ name: "Revenue Test Unauthorized Org" }).select("id").single();
  unauthorizedOrgId = unauthorizedOrg!.id;
  cleanupOrgIds.push(unauthorizedOrgId);

  const { data: clientOrg } = await service.from("organizations").insert({ name: "Revenue Test Client-Only Org" }).select("id").single();
  clientOrgId = clientOrg!.id;
  cleanupOrgIds.push(clientOrg!.id);

  await service.from("agency_organizations").insert({ organization_id: authorizedOrgId });

  // Real revenue_events rows, inserted directly (this suite tests the read
  // layer, not webhook ingestion - see app/api/webhooks/stripe/revenue.integration.test.ts
  // for that) - exactly the shape recordRevenueEvent in the webhook route
  // actually writes.
  await service.from("revenue_events").insert([
    {
      organization_id: authorizedOrgId,
      provider_event_id: `evt_test_setup_${Date.now()}`,
      provider_object_id: "in_test_1",
      event_type: "payment_succeeded",
      revenue_category: "setup",
      amount: 250000,
      currency: "usd",
      occurred_at: "2026-01-15T00:00:00Z",
    },
    {
      organization_id: authorizedOrgId,
      provider_event_id: `evt_test_recurring_${Date.now()}`,
      provider_object_id: "in_test_2",
      event_type: "payment_succeeded",
      revenue_category: "recurring",
      amount: 149700,
      currency: "usd",
      occurred_at: "2026-02-15T00:00:00Z",
    },
    {
      organization_id: authorizedOrgId,
      provider_event_id: `evt_test_refund_${Date.now()}`,
      provider_object_id: "re_test_1",
      event_type: "refund",
      revenue_category: null,
      amount: 50000,
      currency: "usd",
      occurred_at: "2026-02-20T00:00:00Z",
    },
    {
      organization_id: authorizedOrgId,
      provider_event_id: `evt_test_failed_${Date.now()}`,
      provider_object_id: "in_test_3",
      event_type: "payment_failed",
      revenue_category: null,
      amount: 149700,
      currency: "usd",
      occurred_at: "2026-03-01T00:00:00Z",
    },
  ]);

  // Canary: a distinguishable amount on the unauthorized org - if scoping is
  // broken, this leaks into the authorized org's own totals.
  await service.from("revenue_events").insert({
    organization_id: unauthorizedOrgId,
    provider_event_id: `evt_test_canary_${Date.now()}`,
    provider_object_id: "in_test_canary",
    event_type: "payment_succeeded",
    revenue_category: "recurring",
    amount: 9999999,
    currency: "usd",
    occurred_at: "2026-02-15T00:00:00Z",
  });

  const stamp = Date.now();
  clientUser = await createTestUser(`revenue-test-client-${stamp}@example.com`);
  await service.from("organization_members").insert({ organization_id: clientOrgId, user_id: clientUser.id, role: "owner" });

  agencyAdminPassword = `AgencyFixture-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { error } = await service.auth.admin.updateUserById(EXISTING_AGENCY_ADMIN_USER_ID, { password: agencyAdminPassword });
  if (error) throw new Error(`failed to reset fixture password: ${error.message}`);
});

after(async () => {
  for (const orgId of cleanupOrgIds) {
    await service.from("revenue_events").delete().eq("organization_id", orgId);
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

test("1. an authorized agency admin sees revenue for the authorized organization, correctly split by category", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyRevenue(client, service, "allTime");

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId);
  assert.ok(authorized, "the authorized organization must appear");
  assert.deepEqual(authorized!.totals.setupCollected, [{ currency: "usd", amount: 250000 }]);
  assert.deepEqual(authorized!.totals.recurringCollected, [{ currency: "usd", amount: 149700 }]);
  assert.deepEqual(authorized!.totals.collected, [{ currency: "usd", amount: 399700 }]);
});

test("2. refunds reduce netCollected but never mutate/reduce the collected total itself", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyRevenue(client, service, "allTime");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.deepEqual(authorized.totals.refunded, [{ currency: "usd", amount: 50000 }]);
  assert.deepEqual(authorized.totals.collected, [{ currency: "usd", amount: 399700 }], "collected must remain the full original amount - never reduced by the refund");
  assert.deepEqual(authorized.totals.netCollected, [{ currency: "usd", amount: 349700 }]);
});

test("3. a failed payment is never counted in collected or netCollected, and appears only in failedAttempted", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyRevenue(client, service, "allTime");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.deepEqual(authorized.totals.failedAttempted, [{ currency: "usd", amount: 149700 }]);
});

test("4. cross-tenant isolation: the unauthorized organization's canary amount never leaks into the authorized organization's or agency-wide totals", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyRevenue(client, service, "allTime");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const leaked = result.clients.find((c) => c.organizationId === unauthorizedOrgId);
  assert.equal(leaked, undefined, "an organization never added to agency_organizations must never appear");

  const agencyUsdCollected = result.totals.collected.find((entry) => entry.currency === "usd")?.amount ?? 0;
  assert.ok(agencyUsdCollected < 9999999, "the unauthorized org's 9,999,999-cent canary must never be summed into the agency-wide total");
});

test("5. an occurred_at date range filters correctly - a February-only range excludes the January setup fee", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyRevenue(client, service, { from: "2026-02-01T00:00:00Z", to: "2026-03-01T00:00:00Z" });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.deepEqual(authorized.totals.setupCollected, [], "the January setup fee must be excluded from a February-only range");
  assert.deepEqual(authorized.totals.recurringCollected, [{ currency: "usd", amount: 149700 }], "the February recurring payment must still be included");
});

test("6. an ordinary client/contractor org owner is denied - not_agency_admin, never given any organization's revenue", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const result = await getAgencyRevenue(client, service, "allTime");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not_agency_admin");
});

test("7. an unauthenticated (anon) caller is denied - unauthenticated, never reaches the revenue read", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = await getAgencyRevenue(anon, service, "allTime");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unauthenticated");
});

test("8. an organization with zero revenue_events rows in range reports a genuine empty result (empty arrays), never a fabricated figure, and partialData is false", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await getAgencyRevenue(client, service, { from: "2020-01-01T00:00:00Z", to: "2020-02-01T00:00:00Z" });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.partialData, false);
  const authorized = result.clients.find((c) => c.organizationId === authorizedOrgId)!;
  assert.equal(authorized.eventCount, 0);
  assert.deepEqual(authorized.totals.collected, []);
});
