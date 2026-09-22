/**
 * Tests for Launch Blocker #5's founder-facing kill switch: the Server
 * Action (app/agency/organizations/actions.ts), the migration it depends on
 * (supabase/migrations/20260922020000_organization_automation_pause.sql),
 * and the underlying authorization/audit mechanics.
 *
 * setAutomationPaused() calls createClient() from lib/supabase/server.ts
 * (cookies()) - the same "outside a request scope" limitation documented
 * throughout this codebase's other Server Action tests - so it can't be
 * invoked directly. Section 1 verifies its real source structurally.
 * Section 2 verifies the migration's SQL structurally. Section 3 is live,
 * calling the new RPC directly with real sessions, exactly mirroring
 * lib/auth/payment-gate-rpc-enforcement.integration.test.ts's approach.
 * supabase/migrations/20260922020000_organization_automation_pause.sql has
 * been applied to production, so all three sections pass for the real
 * reason.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/agency/organizations/actions.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
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

const ACTIONS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/agency/organizations/actions.ts"), "utf8");
const MIGRATION_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "supabase/migrations/20260922020000_organization_automation_pause.sql"), "utf8");

// ===========================================================================
// SECTION 1 - STATIC: the Server Action
// ===========================================================================

test("1. the action independently re-verifies agency-admin status via the existing resolveAgencyOrganizations chokepoint, not a new/divergent authorization path", () => {
  assert.match(ACTIONS_SOURCE, /import \{ resolveAgencyOrganizations \} from "@\/lib\/agency\/queries";/);
  assert.match(ACTIONS_SOURCE, /const resolved = await resolveAgencyOrganizations\(supabase, service\);/);
});

test("2. the target organization id must appear in the resolved (authorized) organization list before the RPC is ever called - a client-supplied id alone is never trusted", () => {
  const rpcIndex = ACTIONS_SOURCE.indexOf('supabase.rpc("set_organization_automation_paused"');
  const checkIndex = ACTIONS_SOURCE.indexOf("isAuthorizedOrganization");
  assert.ok(checkIndex !== -1 && rpcIndex !== -1 && checkIndex < rpcIndex);
  assert.match(ACTIONS_SOURCE, /resolved\.organizations\.some\(\(org\) => org\.organizationId === organizationId\)/);
});

test("3. an unauthorized organization and an unauthenticated/non-agency caller return the identical generic error - no enumeration signal either way", () => {
  const errorMessages = [...ACTIONS_SOURCE.matchAll(/error: "Not authorized\."/g)];
  assert.equal(errorMessages.length, 2, "expected the exact same 'Not authorized.' message for both the auth failure and the unauthorized-organization branches");
});

test("4. the actual state change is delegated entirely to the SECURITY DEFINER RPC - this action never writes organizations.automation_paused directly via .update()", () => {
  assert.doesNotMatch(ACTIONS_SOURCE, /\.from\("organizations"\)\.update\(/);
  assert.match(ACTIONS_SOURCE, /supabase\.rpc\("set_organization_automation_paused", \{\s*\n\s*p_organization_id: organizationId,\s*\n\s*p_paused: paused,\s*\n\s*\}\);/);
});

test("5. paused is derived strictly as formData.get(\"paused\") === \"true\" - any other value (including absence) is treated as false, never as an implicit true", () => {
  assert.match(ACTIONS_SOURCE, /const paused = formData\.get\("paused"\) === "true";/);
});

test("6. a successful change revalidates the specific organization's own detail page", () => {
  assert.match(ACTIONS_SOURCE, /revalidatePath\(`\/agency\/organizations\/\$\{organizationId\}`\);/);
});

// ===========================================================================
// SECTION 2 - STATIC: the migration (not yet applied - see file-level note)
// ===========================================================================

test("7. the migration adds automation_paused as a new, non-duplicate, boolean NOT NULL DEFAULT false column - no reuse/overload of automation_mode's existing CHECK-constrained values", () => {
  assert.match(MIGRATION_SOURCE, /add column if not exists automation_paused boolean not null default false;/);
  assert.doesNotMatch(MIGRATION_SOURCE, /alter table public\.organizations\s*\n\s*alter column automation_mode/);
});

test("8. the write-protection trigger allows exactly service_role OR a verified agency admin - never a bare authenticated session, never the target organization's own admin", () => {
  const fnMatch = MIGRATION_SOURCE.match(/create or replace function public\.guard_organizations_automation_paused\(\)[\s\S]*?\$\$;/);
  assert.ok(fnMatch, "expected to find guard_organizations_automation_paused()");
  const body = fnMatch![0];
  assert.match(body, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(body, /not public\.is_agency_admin\(\)/);
  assert.doesNotMatch(body, /is_org_admin/, "must never accept the target organization's own admin as a valid caller");
});

test("9. the trigger is actually attached to organizations as a BEFORE UPDATE trigger, mirroring the existing payment_status guard exactly", () => {
  assert.match(MIGRATION_SOURCE, /create trigger organizations_automation_paused_guard\s*\n\s*before update on public\.organizations\s*\n\s*for each row\s*\n\s*execute function public\.guard_organizations_automation_paused\(\);/);
});

test("10. set_organization_automation_paused() checks auth.uid(), is_agency_admin(), and agency_organizations membership, in that order, before ever updating the row", () => {
  const fnMatch = MIGRATION_SOURCE.match(/create or replace function public\.set_organization_automation_paused[\s\S]*?\$\$;/);
  assert.ok(fnMatch, "expected to find set_organization_automation_paused()");
  const body = fnMatch![0];
  const authIndex = body.indexOf("v_user_id is null");
  const adminIndex = body.indexOf("not public.is_agency_admin()");
  const membershipIndex = body.indexOf("agency_organizations");
  const updateIndex = body.indexOf("update public.organizations");
  assert.ok(authIndex !== -1 && adminIndex !== -1 && membershipIndex !== -1 && updateIndex !== -1);
  assert.ok(authIndex < adminIndex && adminIndex < membershipIndex && membershipIndex < updateIndex);
});

test("11. the audit action is derived server-side from the boolean parameter, never accepted as a free-text value from the caller - and it reuses the existing audit_log table, not a new one", () => {
  const fnMatch = MIGRATION_SOURCE.match(/create or replace function public\.set_organization_automation_paused[\s\S]*?\$\$;/);
  const body = fnMatch![0];
  assert.match(body, /v_action := case when p_paused then 'automation_paused' else 'automation_resumed' end;/);
  assert.match(body, /insert into public\.audit_log \(organization_id, user_id, action, entity_type, entity_id, automation_id, metadata\)/);
  assert.doesNotMatch(body.replace(/insert into public\.audit_log[\s\S]*/, ""), /create table/i);
});

test("12. the RPC's own function signature has no overload risk - exactly one CREATE OR REPLACE FUNCTION for set_organization_automation_paused in this migration", () => {
  const matches = MIGRATION_SOURCE.match(/create or replace function public\.set_organization_automation_paused/g) ?? [];
  assert.equal(matches.length, 1);
});

// ===========================================================================
// SECTION 3 - LIVE: real sessions calling the new RPC directly
// ===========================================================================

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let agencyManagedOrgId: string;
let unmanagedOrgId: string;
let agencyAdminUserId: string;
let contractorUserId: string;
const password = "a-real-test-password-123";
const agencyAdminEmail = `killswitch-agency-admin-${Date.now()}@example.com`;
const contractorEmail = `killswitch-contractor-${Date.now()}@example.com`;

async function signIn(email: string) {
  // Deliberately signs in on a throwaway client, never on the shared `anon`
  // client above - `anon` is reused by test 17 to prove a genuinely
  // unauthenticated call is rejected, and mutating it here (even though only
  // this function's own return value is normally used) would leave it
  // carrying a real signed-in session for the rest of the file.
  const throwaway = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await throwaway.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error ?? new Error("no session");
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

before(async () => {
  const { data: managedOrg, error: managedErr } = await service.from("organizations").insert({ name: "Kill Switch RPC Test Org (Agency-Managed)" }).select("id").single();
  if (managedErr) throw managedErr;
  agencyManagedOrgId = managedOrg!.id;

  const { data: unmanagedOrg, error: unmanagedErr } = await service.from("organizations").insert({ name: "Kill Switch RPC Test Org (NOT Agency-Managed)" }).select("id").single();
  if (unmanagedErr) throw unmanagedErr;
  unmanagedOrgId = unmanagedOrg!.id;

  const { error: agencyOrgLinkErr } = await service.from("agency_organizations").insert({ organization_id: agencyManagedOrgId });
  if (agencyOrgLinkErr) throw agencyOrgLinkErr;

  const { data: agencyAdmin, error: agencyAdminErr } = await service.auth.admin.createUser({ email: agencyAdminEmail, password, email_confirm: true });
  if (agencyAdminErr) throw agencyAdminErr;
  agencyAdminUserId = agencyAdmin.user!.id;
  const { error: agencyAdminRowErr } = await service.from("agency_admins").insert({ user_id: agencyAdminUserId });
  if (agencyAdminRowErr) throw agencyAdminRowErr;

  const { data: contractor, error: contractorErr } = await service.auth.admin.createUser({ email: contractorEmail, password, email_confirm: true });
  if (contractorErr) throw contractorErr;
  contractorUserId = contractor.user!.id;
  const { error: contractorMemberErr } = await service.from("organization_members").insert({ organization_id: agencyManagedOrgId, user_id: contractorUserId, role: "owner" });
  if (contractorMemberErr) throw contractorMemberErr;
});

after(async () => {
  await service.from("agency_organizations").delete().eq("organization_id", agencyManagedOrgId);
  await service.from("agency_admins").delete().eq("user_id", agencyAdminUserId);
  await service.from("organization_members").delete().eq("organization_id", agencyManagedOrgId).eq("user_id", contractorUserId);
  await service.from("organizations").delete().eq("id", agencyManagedOrgId);
  await service.from("organizations").delete().eq("id", unmanagedOrgId);
  await service.auth.admin.deleteUser(agencyAdminUserId);
  await service.auth.admin.deleteUser(contractorUserId);
});

test("13. a verified agency admin CAN pause an authorized (agency-managed) organization", async () => {
  const session = await signIn(agencyAdminEmail);
  const { error } = await session.rpc("set_organization_automation_paused", { p_organization_id: agencyManagedOrgId, p_paused: true });
  assert.equal(error, null);

  const { data } = await service.from("organizations").select("automation_paused").eq("id", agencyManagedOrgId).single();
  assert.equal(data?.automation_paused, true);
});

test("14. the same agency admin CAN resume it", async () => {
  const session = await signIn(agencyAdminEmail);
  const { error } = await session.rpc("set_organization_automation_paused", { p_organization_id: agencyManagedOrgId, p_paused: false });
  assert.equal(error, null);

  const { data } = await service.from("organizations").select("automation_paused").eq("id", agencyManagedOrgId).single();
  assert.equal(data?.automation_paused, false);
});

test("15. a normal contractor (org owner, NOT an agency admin) cannot invoke the founder action at all, even on their own organization - the rejection itself is already correct pre-migration (the RPC doesn't exist, so the call errors regardless)", async () => {
  const session = await signIn(contractorEmail);
  const { error } = await session.rpc("set_organization_automation_paused", { p_organization_id: agencyManagedOrgId, p_paused: true });
  assert.ok(error, "a non-agency-admin must be rejected by the RPC's own is_agency_admin() check");

  const { data } = await service.from("organizations").select("automation_paused").eq("id", agencyManagedOrgId).single();
  assert.equal(data?.automation_paused, false, "the rejected call must never have changed the row");
});

test("16. an agency admin cannot target an organization NOT managed by this agency", async () => {
  const session = await signIn(agencyAdminEmail);
  const { error } = await session.rpc("set_organization_automation_paused", { p_organization_id: unmanagedOrgId, p_paused: true });
  assert.ok(error, "an organization outside agency_organizations must be rejected");

  const { data } = await service.from("organizations").select("automation_paused").eq("id", unmanagedOrgId).single();
  assert.equal(data?.automation_paused, false);
});

test("17. an unauthenticated (anon) caller cannot invoke the RPC at all", async () => {
  const { error } = await anon.rpc("set_organization_automation_paused", { p_organization_id: agencyManagedOrgId, p_paused: true });
  assert.ok(error);
});

test("18. a direct REST UPDATE by the target organization's OWN admin (not an agency admin) is rejected by the write-protection trigger - closing the bypass a session-client .update() would otherwise have", async () => {
  const session = await signIn(contractorEmail);
  const { error } = await session.from("organizations").update({ automation_paused: true }).eq("id", agencyManagedOrgId);
  // Either RLS silently filters this to zero rows, or the trigger raises -
  // either way, verify via a fresh service-role read that nothing changed.
  const { data } = await service.from("organizations").select("automation_paused").eq("id", agencyManagedOrgId).single();
  assert.equal(data?.automation_paused, false, "the organization's own admin must never be able to change automation_paused directly, regardless of whether the attempt raised an error or was silently filtered");
  void error;
});

test("19. pausing creates an audit_log row with the correct organization, actor, action, and resulting state", async () => {
  const session = await signIn(agencyAdminEmail);
  await session.rpc("set_organization_automation_paused", { p_organization_id: agencyManagedOrgId, p_paused: true });

  const { data } = await service
    .from("audit_log")
    .select("organization_id, user_id, action, entity_type, entity_id, metadata")
    .eq("organization_id", agencyManagedOrgId)
    .eq("action", "automation_paused")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  assert.ok(data, "expected an audit_log row for the pause action");
  assert.equal(data?.organization_id, agencyManagedOrgId);
  assert.equal(data?.user_id, agencyAdminUserId);
  assert.equal(data?.entity_type, "organization");
  assert.equal(data?.entity_id, agencyManagedOrgId);
  assert.equal((data?.metadata as { paused?: boolean })?.paused, true);
});

test("20. resuming creates a SEPARATE audit_log row with action automation_resumed", async () => {
  const session = await signIn(agencyAdminEmail);
  await session.rpc("set_organization_automation_paused", { p_organization_id: agencyManagedOrgId, p_paused: false });

  const { data } = await service
    .from("audit_log")
    .select("action, metadata")
    .eq("organization_id", agencyManagedOrgId)
    .eq("action", "automation_resumed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  assert.ok(data, "expected an audit_log row for the resume action");
  assert.equal((data?.metadata as { paused?: boolean })?.paused, false);
});
