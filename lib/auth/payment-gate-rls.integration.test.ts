/**
 * Live, authenticated-session proof for Launch Blocker #1: "the payment
 * gate is enforced only at the page-render layer, not in RLS." This suite
 * intentionally does NOT inspect source code - every assertion below is a
 * real Supabase query issued through a real minted user session (the exact
 * same PostgREST path a browser or a direct REST/API call would use), the
 * same disposable-fixture pattern already established in
 * app/api/webhooks/stripe/route.test.ts and lib/agency/authorization.integration.test.ts.
 *
 * IMPORTANT - READ BEFORE INTERPRETING RESULTS:
 * This suite is written against supabase/migrations/20260921150000_payment_gate_rls_enforcement.sql,
 * which has NOT been applied to this (the only reachable) Supabase project as
 * of this run - Supabase branching was declined on this project's plan, and
 * no local Supabase/Docker stack is available in this environment, so there
 * was no disposable database to apply it to without touching the real
 * production project, which this task explicitly forbids. The tests below
 * therefore assert the DESIRED post-migration behavior, not the current
 * behavior:
 *   - Tests 1, 2, 9b, 10, 13, 16 (paid-organization access and cross-org
 *     isolation) already pass today, unmigrated - they prove nothing in
 *     this schema regresses.
 *   - Tests 3, 4, 5, 6, 7, 8, 9a (unpaid/suspended/cancelled organizations
 *     denied) are EXPECTED TO FAIL until the migration is applied - a
 *     failure here is the live, empirical proof that Launch Blocker #1
 *     is real today. Once the migration is applied to this project, this
 *     entire suite should go green with no other changes.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/auth/payment-gate-rls.integration.test.ts"
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

let orgA: string; // subject organization - cycled through every payment_status
let orgB: string; // a second, always-active organization, for cross-org isolation
let userAId: string;
let userBId: string;
let sessionA: Awaited<ReturnType<typeof createSessionFor>>;

before(async () => {
  const { data: a, error: aErr } = await service.from("organizations").insert({ name: "Payment Gate RLS Test Org A" }).select("id").single();
  if (aErr) throw aErr;
  orgA = a!.id;

  const { data: b, error: bErr } = await service.from("organizations").insert({ name: "Payment Gate RLS Test Org B" }).select("id").single();
  if (bErr) throw bErr;
  orgB = b!.id;
  const { error: activateBErr } = await service.from("organizations").update({ payment_status: "active" }).eq("id", orgB);
  if (activateBErr) throw activateBErr;

  const emailA = `payment-gate-rls-a-${Date.now()}@example.com`;
  const emailB = `payment-gate-rls-b-${Date.now()}@example.com`;
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

async function setOrgAStatus(status: "payment_required" | "active" | "suspended" | "cancelled") {
  const { error } = await service.from("organizations").update({ payment_status: status }).eq("id", orgA);
  if (error) throw error;
}

test("1. an active organization member can read permitted org data (leads) - REST/session path, already true today", async () => {
  await setOrgAStatus("active");
  const { data: lead, error: insertErr } = await service.from("leads").insert({ organization_id: orgA, status: "new", temperature: "cold" }).select("id").single();
  assert.equal(insertErr, null);
  const { data, error } = await sessionA.from("leads").select("id").eq("id", lead!.id);
  assert.equal(error, null);
  assert.equal(data?.length, 1, "an active org's own member must be able to read their own lead");
});

test("2. an active organization member can perform permitted writes (leads insert)", async () => {
  await setOrgAStatus("active");
  const { error } = await sessionA.from("leads").insert({ organization_id: orgA, status: "new", temperature: "cold" });
  assert.equal(error, null, "an active org's own member must be able to insert a lead via their own session");
});

test("3. a payment_required organization cannot read org-scoped data (leads) - EXPECTED TO FAIL until the migration is applied", async () => {
  await setOrgAStatus("payment_required");
  const { data: lead, error: insertErr } = await service.from("leads").insert({ organization_id: orgA, status: "new", temperature: "cold" }).select("id").single();
  assert.equal(insertErr, null);
  const { data, error } = await sessionA.from("leads").select("id").eq("id", lead!.id);
  assert.equal(error, null);
  assert.equal(data?.length, 0, "an unpaid org's own member must NOT be able to read leads via their own session - this must be an empty result, not an error, per Postgres RLS semantics");
});

test("4. a payment_required organization cannot write org-scoped data (leads insert) - EXPECTED TO FAIL until the migration is applied", async () => {
  await setOrgAStatus("payment_required");
  const { error } = await sessionA.from("leads").insert({ organization_id: orgA, status: "new", temperature: "cold" });
  assert.ok(error, "an unpaid org's own member must be rejected (RLS policy violation) when inserting a lead via their own session");
});

test("5. a suspended organization cannot read org-scoped data (contacts) - EXPECTED TO FAIL until the migration is applied", async () => {
  await setOrgAStatus("suspended");
  const { data: contact, error: insertErr } = await service.from("contacts").insert({ organization_id: orgA, first_name: "Test" }).select("id").single();
  assert.equal(insertErr, null);
  const { data, error } = await sessionA.from("contacts").select("id").eq("id", contact!.id);
  assert.equal(error, null);
  assert.equal(data?.length, 0, "a suspended org's own member must NOT be able to read contacts via their own session");
});

test("6. a suspended organization cannot write org-scoped data (contacts insert) - EXPECTED TO FAIL until the migration is applied", async () => {
  await setOrgAStatus("suspended");
  const { error } = await sessionA.from("contacts").insert({ organization_id: orgA, first_name: "Test" });
  assert.ok(error, "a suspended org's own member must be rejected when inserting a contact via their own session");
});

test("7. a cancelled organization cannot read org-scoped data (services) - EXPECTED TO FAIL until the migration is applied", async () => {
  await setOrgAStatus("cancelled");
  const { data: service_, error: insertErr } = await service.from("services").insert({ organization_id: orgA, name: "Roof repair" }).select("id").single();
  assert.equal(insertErr, null);
  const { data, error } = await sessionA.from("services").select("id").eq("id", service_!.id);
  assert.equal(error, null);
  assert.equal(data?.length, 0, "a cancelled org's own member must NOT be able to read services via their own session");
});

test("8. a cancelled organization cannot write org-scoped data (services insert) - EXPECTED TO FAIL until the migration is applied", async () => {
  await setOrgAStatus("cancelled");
  const { error } = await sessionA.from("services").insert({ organization_id: orgA, name: "Roof repair" });
  assert.ok(error, "a cancelled org's own member must be rejected when inserting a service via their own session");
});

test("9a. an unpaid authenticated user cannot bypass the restriction through direct Supabase REST/API access (raw PostgREST fetch, not the JS client) - EXPECTED TO FAIL until the migration is applied", async () => {
  await setOrgAStatus("payment_required");
  const { data: signIn } = await anon.auth.signInWithPassword({ email: (await service.auth.admin.getUserById(userAId)).data.user!.email!, password: "a-real-test-password-123" });
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/leads?organization_id=eq.${orgA}`, {
    headers: {
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${signIn.session!.access_token}`,
    },
  });
  const rows = await res.json();
  assert.equal(Array.isArray(rows) ? rows.length : -1, 0, "a raw REST call with an unpaid user's own JWT must return zero rows, proving this is a database-layer restriction, not something only the JS client happens to respect");
});

test("9b. once active again, the same raw REST call returns the organization's real data (proves this is a payment-status gate, not a blanket denial)", async () => {
  await setOrgAStatus("active");
  const { data: lead } = await service.from("leads").insert({ organization_id: orgA, status: "new", temperature: "cold" }).select("id").single();
  const { data: signIn } = await anon.auth.signInWithPassword({ email: (await service.auth.admin.getUserById(userAId)).data.user!.email!, password: "a-real-test-password-123" });
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/leads?id=eq.${lead!.id}`, {
    headers: {
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${signIn.session!.access_token}`,
    },
  });
  const rows = await res.json();
  assert.equal(Array.isArray(rows) ? rows.length : -1, 1, "the same raw REST path must return the row again once the organization is active");
});

test("10. an unpaid authenticated user cannot bypass the restriction by supplying another organization_id (cross-tenant isolation, independent of payment_status)", async () => {
  await setOrgAStatus("payment_required");
  const { data: bLead, error: insertErr } = await service.from("leads").insert({ organization_id: orgB, status: "new", temperature: "cold" }).select("id").single();
  assert.equal(insertErr, null);
  const { data, error } = await sessionA.from("leads").select("id").eq("id", bLead!.id);
  assert.equal(error, null);
  assert.equal(data?.length, 0, "org A's member must never see org B's lead, regardless of either organization's payment_status - this is existing, unmodified tenant isolation");

  const { error: crossInsertErr } = await sessionA.from("leads").insert({ organization_id: orgB, status: "new", temperature: "cold" });
  assert.ok(crossInsertErr, "org A's member must never be able to insert a lead into org B by supplying orgB's id - this is existing, unmodified tenant isolation, not something this migration weakens or depends on");
});

test("13. an active (paid) organization's access is completely unaffected by this change - full read/write still works exactly as before", async () => {
  await setOrgAStatus("active");
  const { error: insertErr } = await sessionA.from("contacts").insert({ organization_id: orgA, first_name: "Real", last_name: "Customer" });
  assert.equal(insertErr, null);
  const { data, error } = await sessionA.from("contacts").select("id").eq("organization_id", orgA);
  assert.equal(error, null);
  assert.ok((data?.length ?? 0) > 0, "a paid organization must retain full, unrestricted read/write access to its own data");
});

test("16. organization membership behavior for an active organization is unchanged - the member row itself remains readable regardless of this migration (organization_members is intentionally not gated)", async () => {
  await setOrgAStatus("payment_required");
  const { data, error } = await sessionA.from("organization_members").select("organization_id, role").eq("user_id", userAId);
  assert.equal(error, null);
  assert.equal(data?.length, 1, "a user's own membership row must remain readable even while unpaid - this is how the app knows to show the payment-required screen at all");
  assert.equal(data![0].organization_id, orgA);
});

test("17. no RLS recursion: querying organizations directly as a payment_required org's own member still succeeds (organizations itself is intentionally not gated, and the new helper function must not deadlock against it)", async () => {
  await setOrgAStatus("payment_required");
  const { data, error } = await sessionA.from("organizations").select("id, payment_status").eq("id", orgA);
  assert.equal(error, null, "if organization_payment_active() ever recursed into organizations' own RLS, this query would hang or error - it must return cleanly");
  assert.equal(data?.length, 1);
  assert.equal(data![0].payment_status, "payment_required");
});
