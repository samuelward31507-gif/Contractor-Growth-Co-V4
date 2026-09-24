/**
 * Live, authenticated-session proof for the memberships/check_ins RLS and
 * cross-org-contact-guard foundation (Gym Foundation Phase 1, Sections 3,
 * 4, 10, 12). Same disposable-fixture pattern as
 * lib/auth/payment-gate-rls.integration.test.ts.
 *
 * IMPORTANT - READ BEFORE INTERPRETING RESULTS / BEFORE RUNNING:
 * This suite is written against
 * supabase/migrations/20260924100100_memberships_and_check_ins.sql, which
 * has NOT been applied to this (the only reachable) Supabase project - no
 * local Supabase/Docker stack is available in this environment (same
 * constraint payment-gate-rls.integration.test.ts documents), and Phase 1
 * explicitly forbids applying any migration to production. Unlike that
 * suite (where the payment_status COLUMN already existed and only its RLS
 * enforcement was new, so some assertions could pass against the
 * unmigrated schema today), the memberships/check_ins TABLES do not exist
 * at all yet - every test below is guaranteed to fail with Postgres
 * "relation does not exist" until the migration is applied, and running it
 * now would only insert/delete real rows in production organizations/
 * auth.users for a guaranteed, uninformative failure. This file is
 * therefore written and left un-executed against production - it is ready
 * to run once the migration is reviewed and applied, at which point it
 * should go green with no other changes.
 *
 * Run with (only after the migration above has been applied):
 *   node --import ./lib/automation/test-loader.mjs --test "lib/memberships/memberships-checkins-rls.integration.test.ts"
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

let orgA: string;
let orgB: string;
let userAId: string;
let userBId: string;
let contactA: string;
let contactB: string;
let sessionA: Awaited<ReturnType<typeof createSessionFor>>;

before(async () => {
  const { data: a, error: aErr } = await service
    .from("organizations")
    .insert({ name: "Memberships RLS Test Org A", payment_status: "active" })
    .select("id")
    .single();
  if (aErr) throw aErr;
  orgA = a!.id;

  const { data: b, error: bErr } = await service
    .from("organizations")
    .insert({ name: "Memberships RLS Test Org B", payment_status: "active" })
    .select("id")
    .single();
  if (bErr) throw bErr;
  orgB = b!.id;

  const { data: cA, error: cAErr } = await service.from("contacts").insert({ organization_id: orgA, first_name: "Member A" }).select("id").single();
  if (cAErr) throw cAErr;
  contactA = cA!.id;

  const { data: cB, error: cBErr } = await service.from("contacts").insert({ organization_id: orgB, first_name: "Member B" }).select("id").single();
  if (cBErr) throw cBErr;
  contactB = cB!.id;

  const emailA = `memberships-rls-a-${Date.now()}@example.com`;
  const emailB = `memberships-rls-b-${Date.now()}@example.com`;
  const password = "a-real-test-password-123";

  const { data: userA, error: userAErr } = await service.auth.admin.createUser({ email: emailA, password, email_confirm: true });
  if (userAErr) throw userAErr;
  userAId = userA.user!.id;
  const { data: userB, error: userBErr } = await service.auth.admin.createUser({ email: emailB, password, email_confirm: true });
  if (userBErr) throw userBErr;
  userBId = userB.user!.id;

  const { error: memberAErr } = await service.from("organization_members").insert({ organization_id: orgA, user_id: userAId, role: "owner" });
  if (memberAErr) throw memberAErr;
  const { error: memberBErr } = await service.from("organization_members").insert({ organization_id: orgB, user_id: userBId, role: "owner" });
  if (memberBErr) throw memberBErr;

  sessionA = await createSessionFor(emailA, password);
});

after(async () => {
  await service.from("organizations").delete().eq("id", orgA);
  await service.from("organizations").delete().eq("id", orgB);
  await service.auth.admin.deleteUser(userAId);
  await service.auth.admin.deleteUser(userBId);
});

test("1. an org member can create and read their own org's membership (CRUD: create + read)", async () => {
  const { data: created, error: insertErr } = await sessionA
    .from("memberships")
    .insert({ organization_id: orgA, contact_id: contactA, plan_name: "Monthly Unlimited", start_at: new Date().toISOString() })
    .select("id")
    .single();
  assert.equal(insertErr, null);
  assert.ok(created?.id);

  const { data, error } = await sessionA.from("memberships").select("id, status").eq("id", created!.id).single();
  assert.equal(error, null);
  assert.equal(data?.status, "active", "status defaults to active");
});

test("2. an org member can update and delete their own org's membership (CRUD: update + delete)", async () => {
  const { data: created } = await sessionA
    .from("memberships")
    .insert({ organization_id: orgA, contact_id: contactA, plan_name: "Monthly Unlimited", start_at: new Date().toISOString() })
    .select("id")
    .single();

  const { error: updateErr } = await sessionA.from("memberships").update({ status: "paused" }).eq("id", created!.id);
  assert.equal(updateErr, null);

  const { error: deleteErr } = await sessionA.from("memberships").delete().eq("id", created!.id);
  assert.equal(deleteErr, null);
});

test("3. a member cannot read another organization's membership (org isolation)", async () => {
  const { data: otherMembership, error: insertErr } = await service
    .from("memberships")
    .insert({ organization_id: orgB, contact_id: contactB, plan_name: "Monthly Unlimited", start_at: new Date().toISOString() })
    .select("id")
    .single();
  assert.equal(insertErr, null);

  const { data, error } = await sessionA.from("memberships").select("id").eq("id", otherMembership!.id);
  assert.equal(error, null);
  assert.equal(data?.length, 0, "org A's session must not be able to read org B's membership");
});

test("4. a membership cannot reference a contact from a different organization (cross-org rejection)", async () => {
  const { error } = await sessionA
    .from("memberships")
    .insert({ organization_id: orgA, contact_id: contactB, plan_name: "Monthly Unlimited", start_at: new Date().toISOString() });
  assert.ok(error, "inserting a membership with a cross-org contact_id must be rejected by guard_same_organization_contact()");
});

test("5. an org member can create and read a check-in for their own org (CRUD)", async () => {
  const { data: created, error: insertErr } = await sessionA.from("check_ins").insert({ organization_id: orgA, contact_id: contactA }).select("id").single();
  assert.equal(insertErr, null);

  const { data, error } = await sessionA.from("check_ins").select("id, checked_in_at").eq("id", created!.id).single();
  assert.equal(error, null);
  assert.ok(data?.checked_in_at, "checked_in_at defaults to now()");
});

test("6. a member cannot read another organization's check-in (org isolation)", async () => {
  const { data: otherCheckIn, error: insertErr } = await service.from("check_ins").insert({ organization_id: orgB, contact_id: contactB }).select("id").single();
  assert.equal(insertErr, null);

  const { data, error } = await sessionA.from("check_ins").select("id").eq("id", otherCheckIn!.id);
  assert.equal(error, null);
  assert.equal(data?.length, 0, "org A's session must not be able to read org B's check-in");
});

test("7. a check-in cannot reference a contact from a different organization (cross-org rejection)", async () => {
  const { error } = await sessionA.from("check_ins").insert({ organization_id: orgA, contact_id: contactB });
  assert.ok(error, "inserting a check-in with a cross-org contact_id must be rejected by guard_same_organization_contact()");
});
