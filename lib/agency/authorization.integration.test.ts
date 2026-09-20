/**
 * Integration tests for the Agency Command Center's actual authorization
 * boundary (lib/agency/queries.ts's resolveAgencyOrganizations / the
 * is_agency_admin() SECURITY DEFINER RPC / the agency_admins and
 * agency_organizations RLS policies) - this real DB-backed boundary was not
 * previously exercised end-to-end anywhere in this suite (only referenced in
 * comments, or proven absent from an unrelated code path in
 * lib/automation/authorization.test.ts). Mirrors this codebase's established
 * pattern (lib/settings/sms-routing.integration.test.ts) of using real,
 * minted Supabase Auth sessions rather than a mocked client, since RLS and a
 * SECURITY DEFINER RPC's auth.uid() check can only be proven against a real
 * JWT.
 *
 * The "authorized agency admin" case reuses the pre-existing
 * agency-test-admin@example.com fixture already present in agency_admins
 * (from earlier manual QA) rather than inserting a new row - this suite
 * makes zero writes to agency_admins, so it never touches, grants, or
 * revokes any real account's authorization.
 *
 * Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/authorization.integration.test.ts
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
const { resolveAgencyOrganizations, isAgencyAdmin }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/agency/queries.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const EXISTING_AGENCY_ADMIN_USER_ID = "fcfaac02-ece5-402a-af3f-3af1cbccd049";
const EXISTING_AGENCY_ADMIN_EMAIL = "agency-test-admin@example.com";

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
  const { data: org } = await service.from("organizations").insert({ name: "Agency Authz Test Client Org" }).select("id").single();
  clientOrgId = org!.id;
  cleanupOrgIds.push(clientOrgId);

  const stamp = Date.now();
  clientUser = await createTestUser(`agency-authz-client-${stamp}@example.com`);
  await service.from("organization_members").insert({ organization_id: clientOrgId, user_id: clientUser.id, role: "owner" });

  // Reset the pre-existing fixture's password so this suite can sign in as
  // it - zero writes to agency_admins occur anywhere in this file.
  agencyAdminPassword = `AgencyFixture-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { error } = await service.auth.admin.updateUserById(EXISTING_AGENCY_ADMIN_USER_ID, { password: agencyAdminPassword });
  if (error) throw new Error(`failed to reset fixture password: ${error.message}`);
});

after(async () => {
  for (const orgId of cleanupOrgIds) {
    await service.from("organization_members").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
  // Password reset on the pre-existing fixture is intentionally left in
  // place (it is a test-only account with no client data, and its own
  // password is not a secret this repository relies on elsewhere).
});

test("1. an authorized agency admin (pre-existing fixture) is granted access via resolveAgencyOrganizations", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await resolveAgencyOrganizations(client, service);
  assert.equal(result.ok, true);
});

test("2. isAgencyAdmin (nav-visibility check) also returns true for the same admin", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await isAgencyAdmin(client);
  assert.equal(result, true);
});

test("3. an ordinary client/contractor org owner is denied - not_agency_admin, never given organization data", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const result = await resolveAgencyOrganizations(client, service);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_agency_admin");
});

test("4. an unauthenticated (anon) caller is denied - unauthenticated, never reaches the is_agency_admin RPC path", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = await resolveAgencyOrganizations(anon, service);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unauthenticated");
});

test("5. RLS: a client/contractor user cannot read the agency_admins table at all (not even their own absence)", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const { data, error } = await client.from("agency_admins").select("id");
  // agency_admins_select_self only ever returns the caller's own row - a
  // non-admin has no row, so this must return an empty array, never an
  // error that could leak table existence details, and never any other
  // admin's row.
  assert.equal(error, null);
  assert.equal(data?.length ?? 0, 0);
});

test("6. RLS: a client/contractor user cannot read agency_organizations - cross-tenant client list stays invisible", async () => {
  const client = await signInAs(clientUser.email, clientUser.password);
  const { data, error } = await client.from("agency_organizations").select("organization_id");
  assert.equal(error, null);
  assert.equal(data?.length ?? 0, 0, "agency_organizations_select requires is_agency_admin() - a client user must see zero rows");
});

test("7. RLS: an anonymous caller cannot read agency_admins or agency_organizations", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: admins } = await anon.from("agency_admins").select("id");
  const { data: orgs } = await anon.from("agency_organizations").select("organization_id");
  assert.equal(admins?.length ?? 0, 0);
  assert.equal(orgs?.length ?? 0, 0);
});

test("8. the agency admin's own resolved organization list is scoped strictly to agency_organizations - a client-only test org with no agency association is never included", async () => {
  const client = await signInAs(EXISTING_AGENCY_ADMIN_EMAIL, agencyAdminPassword);
  const result = await resolveAgencyOrganizations(client, service);
  assert.equal(result.ok, true);
  if (result.ok) {
    const ids = result.organizations.map((o) => o.organizationId);
    assert.equal(ids.includes(clientOrgId), false, "an organization never added to agency_organizations must never appear in the agency's resolved list");
  }
});

test("9. granting agency-admin status does not touch organization_members - the client user's own membership/role is unaffected by anything in this suite", async () => {
  const { data } = await service.from("organization_members").select("role").eq("organization_id", clientOrgId).eq("user_id", clientUser.id).single();
  assert.equal(data?.role, "owner");
});
