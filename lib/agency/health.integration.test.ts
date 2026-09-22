/**
 * Integration tests for Growth System Completion Pass 2, Part 9/10 - payment
 * status and automation-paused state surfaced in the Agency Command Center's
 * health rollup (lib/agency/health.ts's getAgencyHealth). Mirrors
 * lib/agency/authorization.integration.test.ts's exact fixture pattern: the
 * pre-existing agency-test-admin@example.com fixture already present in
 * agency_admins (zero writes to that table here), plus an explicit
 * agency_organizations association (never implicit - see that suite's own
 * test 8, which proves an unassociated organization never appears).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/health.integration.test.ts
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
const { getAgencyHealth }: typeof import("./health") = require(path.join(REPO_ROOT, "lib/agency/health.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const EXISTING_AGENCY_ADMIN_USER_ID = "fcfaac02-ece5-402a-af3f-3af1cbccd049";
const EXISTING_AGENCY_ADMIN_EMAIL = "agency-test-admin@example.com";

let agencyAdminSupabase: ReturnType<typeof createSupabaseClient>;
let agencyAdminPassword: string;
const orgIds: string[] = [];

async function signInAs(email: string, password: string) {
  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

async function makeAssociatedOrg(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data: org } = await service
    .from("organizations")
    .insert({ name: `Agency Health Test Org ${Math.random().toString(36).slice(2)}`, payment_status: "active", automation_mode: "live", ...overrides })
    .select("id")
    .single();
  const organizationId = org!.id as string;
  orgIds.push(organizationId);
  await service.from("agency_organizations").insert({ organization_id: organizationId });
  return organizationId;
}

before(async () => {
  // Reset the pre-existing fixture's password so this suite can sign in as
  // it - mirrors authorization.integration.test.ts's own identical pattern.
  agencyAdminPassword = `AgencyHealthFixture-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { error } = await service.auth.admin.updateUserById(EXISTING_AGENCY_ADMIN_USER_ID, { password: agencyAdminPassword });
  if (error) throw new Error(`failed to reset fixture password: ${error.message}`);
  agencyAdminSupabase = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
});

after(async () => {
  for (const organizationId of orgIds) {
    await service.from("agency_organizations").delete().eq("organization_id", organizationId);
    await service.from("organizations").delete().eq("id", organizationId);
  }
});

test("1. a normally-paying, active organization reports paymentStatus 'active' and is not flagged for payment", async () => {
  const organizationId = await makeAssociatedOrg({ payment_status: "active" });

  const result = await getAgencyHealth(agencyAdminSupabase, service);
  assert.equal(result.ok, true);
  const org = (result as { organizations: { organizationId: string; paymentStatus: string; needsAttention: boolean }[] }).organizations.find((o) => o.organizationId === organizationId);
  assert.equal(org?.paymentStatus, "active");
});

test("2. a suspended organization's payment status is surfaced and flags needsAttention", async () => {
  const organizationId = await makeAssociatedOrg({ payment_status: "suspended" });

  const result = await getAgencyHealth(agencyAdminSupabase, service);
  const org = (result as { organizations: { organizationId: string; paymentStatus: string; needsAttention: boolean }[] }).organizations.find((o) => o.organizationId === organizationId);
  assert.equal(org?.paymentStatus, "suspended");
  assert.equal(org?.needsAttention, true, "a suspended organization must be surfaced as needing attention");
});

test("3. a cancelled organization's payment status is surfaced and flags needsAttention", async () => {
  const organizationId = await makeAssociatedOrg({ payment_status: "cancelled" });

  const result = await getAgencyHealth(agencyAdminSupabase, service);
  const org = (result as { organizations: { organizationId: string; paymentStatus: string; needsAttention: boolean }[] }).organizations.find((o) => o.organizationId === organizationId);
  assert.equal(org?.paymentStatus, "cancelled");
  assert.equal(org?.needsAttention, true);
});

test("4. an organization still in onboarding (payment_required) is surfaced honestly but is NOT flagged as needing attention - a normal, transient state, not a regression", async () => {
  const organizationId = await makeAssociatedOrg({ payment_status: "payment_required" });

  const result = await getAgencyHealth(agencyAdminSupabase, service);
  const org = (result as { organizations: { organizationId: string; paymentStatus: string; needsAttention: boolean }[] }).organizations.find((o) => o.organizationId === organizationId);
  assert.equal(org?.paymentStatus, "payment_required");
  assert.equal(org?.needsAttention, false, "payment_required must never be a false-positive attention flag by itself");
});

test("5. automation_paused is surfaced and flags needsAttention", async () => {
  const organizationId = await makeAssociatedOrg({ automation_paused: true });

  const result = await getAgencyHealth(agencyAdminSupabase, service);
  const org = (result as { organizations: { organizationId: string; automationPaused: boolean; needsAttention: boolean }[] }).organizations.find((o) => o.organizationId === organizationId);
  assert.equal(org?.automationPaused, true);
  assert.equal(org?.needsAttention, true, "a paused organization must be surfaced as needing attention");
});

test("6. an organization that is active, unpaused, and otherwise healthy is never flagged", async () => {
  const organizationId = await makeAssociatedOrg({ payment_status: "active", automation_paused: false });

  const result = await getAgencyHealth(agencyAdminSupabase, service);
  const org = (result as { organizations: { organizationId: string; needsAttention: boolean }[] }).organizations.find((o) => o.organizationId === organizationId);
  assert.equal(org?.needsAttention, false);
});
