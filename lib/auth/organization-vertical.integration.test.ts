/**
 * Live, authenticated-session proof that getUserOrganization() actually
 * reads organizations.vertical from the database rather than returning a
 * hardcoded value - Gym Foundation Phase 1 completion. Same disposable-
 * fixture pattern as lib/auth/payment-gate-rls.integration.test.ts and
 * lib/memberships/memberships-checkins-rls.integration.test.ts.
 *
 * organizations.vertical is now live in production
 * (20260924100000_organization_vertical.sql, applied and verified), so
 * unlike the memberships/check_ins integration test, this suite is
 * expected to run and pass today - it is not blocked on any further
 * migration.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/auth/organization-vertical.integration.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { getUserOrganization }: typeof import("./organization") = require("./organization.ts");

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

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createSessionFor(email: string, password: string) {
  const { data: signIn, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !signIn.session) throw error ?? new Error("no session");
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  });
}

let orgContractor: string;
let orgGym: string;
let userContractorId: string;
let userGymId: string;
let sessionContractor: Awaited<ReturnType<typeof createSessionFor>>;
let sessionGym: Awaited<ReturnType<typeof createSessionFor>>;

before(async () => {
  // Deliberately does NOT set vertical - proves the column's own DEFAULT
  // 'contractor' is what a brand-new organization resolves as, matching
  // every pre-existing production organization.
  const { data: orgC, error: orgCErr } = await service
    .from("organizations")
    .insert({ name: "Vertical Resolution Test Org - Contractor", payment_status: "active" })
    .select("id")
    .single();
  if (orgCErr) throw orgCErr;
  orgContractor = orgC!.id;

  // vertical is service-role-only writable (organizations_vertical_guard);
  // the service-role client bypasses that guard, same as this fixture
  // already relies on to set payment_status directly.
  const { data: orgG, error: orgGErr } = await service
    .from("organizations")
    .insert({ name: "Vertical Resolution Test Org - Gym", payment_status: "active", vertical: "gym" })
    .select("id")
    .single();
  if (orgGErr) throw orgGErr;
  orgGym = orgG!.id;

  const emailC = `vertical-resolution-contractor-${Date.now()}@example.com`;
  const emailG = `vertical-resolution-gym-${Date.now()}@example.com`;
  const password = "a-real-test-password-123";

  const { data: userC, error: userCErr } = await service.auth.admin.createUser({ email: emailC, password, email_confirm: true });
  if (userCErr) throw userCErr;
  userContractorId = userC.user!.id;
  const { data: userG, error: userGErr } = await service.auth.admin.createUser({ email: emailG, password, email_confirm: true });
  if (userGErr) throw userGErr;
  userGymId = userG.user!.id;

  const { error: memberCErr } = await service.from("organization_members").insert({ organization_id: orgContractor, user_id: userContractorId, role: "owner" });
  if (memberCErr) throw memberCErr;
  const { error: memberGErr } = await service.from("organization_members").insert({ organization_id: orgGym, user_id: userGymId, role: "owner" });
  if (memberGErr) throw memberGErr;

  sessionContractor = await createSessionFor(emailC, password);
  sessionGym = await createSessionFor(emailG, password);
});

after(async () => {
  await service.from("organizations").delete().eq("id", orgContractor);
  await service.from("organizations").delete().eq("id", orgGym);
  await service.auth.admin.deleteUser(userContractorId);
  await service.auth.admin.deleteUser(userGymId);
});

test("1. a contractor organization (vertical never explicitly set) resolves as contractor", async () => {
  const membership = await getUserOrganization(sessionContractor, userContractorId);
  assert.ok(membership);
  assert.equal(membership!.vertical, "contractor");
});

test("2. a gym organization (vertical explicitly set to 'gym' in the database) resolves as gym", async () => {
  const membership = await getUserOrganization(sessionGym, userGymId);
  assert.ok(membership);
  assert.equal(membership!.vertical, "gym");
});

test("3. vertical is actually read from the database, not hardcoded - flipping the DB value flips the resolved value", async () => {
  const before = await getUserOrganization(sessionContractor, userContractorId);
  assert.equal(before!.vertical, "contractor");

  const { error: flipErr } = await service.from("organizations").update({ vertical: "gym" }).eq("id", orgContractor);
  assert.equal(flipErr, null);

  const after = await getUserOrganization(sessionContractor, userContractorId);
  assert.equal(after!.vertical, "gym", "getUserOrganization must reflect the live database value, proving it isn't a hardcoded constant");

  // Restore, so this test doesn't leave the fixture in a state the other
  // tests in this file don't expect regardless of run order.
  await service.from("organizations").update({ vertical: "contractor" }).eq("id", orgContractor);
});

test("4. existing organization-loading behavior remains intact - name, role, and paymentStatus are still resolved correctly", async () => {
  const membership = await getUserOrganization(sessionContractor, userContractorId);
  assert.ok(membership);
  assert.equal(membership!.organizationId, orgContractor);
  assert.equal(membership!.organizationName, "Vertical Resolution Test Org - Contractor");
  assert.equal(membership!.role, "owner");
  assert.equal(membership!.paymentStatus, "active");
});
