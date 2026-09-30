/**
 * Performance Pass 2 (opportunity sync throttling): live proof of
 * claim_opportunity_sync (supabase/migrations/20260930025936_opportunity_sync_state.sql)
 * against a real Supabase project - the one thing the PGlite harness
 * (supabase/pending/scratch/validate-opportunity-sync-state.mjs) cannot
 * prove, because PGlite is a single connection: N genuinely simultaneous
 * claims for one organization yield exactly one winner. Also re-proves, on
 * the real grants/RLS/JWT path, that organizations are independent, that
 * membership and payment gate the claim, that anon cannot execute it, and
 * that the state table is unreachable directly.
 *
 * Requires the migration to be applied to the TEST project first. Refuses
 * to run against production. Real users sign in with a password, so every
 * claim carries a real authenticated JWT - the same path the Dashboard's
 * after() task takes (lib/opportunities/background-sync.ts). The service
 * role is used only for fixtures (users, organizations, memberships, payment
 * status, and backdating the cooldown) and cleanup - never by the feature.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/sync-claim.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
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

const PRODUCTION_PROJECT_REF = "mywznmxtlgajnczjvbmk";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!SUPABASE_URL || SUPABASE_URL.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error("Refusing to run: sync-claim.integration.test.ts only runs against the test Supabase project, never production.");
}

const options = { auth: { autoRefreshToken: false, persistSession: false } };
const service = createSupabaseClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
const anon = createSupabaseClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, options);
// Password sign-ins get their own client: supabase-js keeps a signed-in
// session in memory even with persistSession: false, so signing in through
// `anon` would silently turn it into the last user who signed in.
const signInClient = createSupabaseClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, options);

const PASSWORD = "a-real-test-password-123";
const RUN = Date.now();
const orgIds: string[] = [];
const userIds: string[] = [];

async function createOrg(name: string, paymentStatus: "payment_required" | "active" | "suspended" | "cancelled"): Promise<string> {
  const { data, error } = await service.from("organizations").insert({ name: `${name} ${RUN}` }).select("id").single();
  if (error) throw error;
  orgIds.push(data!.id);
  if (paymentStatus !== "payment_required") {
    const { error: statusError } = await service.from("organizations").update({ payment_status: paymentStatus }).eq("id", data!.id);
    if (statusError) throw statusError;
  }
  return data!.id;
}

/** A real user, a member of `organizationId` with `role`, signed in - returns a client carrying their JWT. */
async function signedInMember(label: string, organizationId: string | null, role: "owner" | "admin" | "member" = "owner"): Promise<SupabaseClient> {
  const email = `sync-claim-${label}-${RUN}@example.com`;
  const { data: created, error } = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  userIds.push(created.user!.id);
  if (organizationId) {
    const { error: memberError } = await service.from("organization_members").insert({ organization_id: organizationId, user_id: created.user!.id, role });
    if (memberError) throw memberError;
  }
  const { data: signIn, error: signInError } = await signInClient.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError || !signIn.session) throw signInError ?? new Error("no session");
  return createSupabaseClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    ...options,
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  });
}

async function claim(client: SupabaseClient, organizationId: string): Promise<boolean> {
  const { data, error } = await client.rpc("claim_opportunity_sync", { p_organization_id: organizationId });
  if (error) throw new Error(`claim_opportunity_sync failed: ${error.message}`);
  return data === true;
}

async function stateRow(organizationId: string) {
  const { data, error } = await service.from("opportunity_sync_state").select("organization_id, last_started_at").eq("organization_id", organizationId).maybeSingle();
  if (error) throw error;
  return data;
}

async function backdate(organizationId: string, seconds: number) {
  const { error } = await service.from("opportunity_sync_state").update({ last_started_at: new Date(Date.now() - seconds * 1000).toISOString() }).eq("organization_id", organizationId);
  if (error) throw error;
}

let orgA: string;
let orgB: string;
let orgUnpaid: string;
let ownerA: SupabaseClient;
let memberA: SupabaseClient;
let ownerB: SupabaseClient;
let ownerUnpaid: SupabaseClient;
let outsider: SupabaseClient;

before(async () => {
  orgA = await createOrg("Sync Claim Test Org A", "active");
  orgB = await createOrg("Sync Claim Test Org B", "active");
  orgUnpaid = await createOrg("Sync Claim Test Org Unpaid", "payment_required");
  ownerA = await signedInMember("owner-a", orgA, "owner");
  memberA = await signedInMember("member-a", orgA, "member");
  ownerB = await signedInMember("owner-b", orgB, "owner");
  ownerUnpaid = await signedInMember("owner-unpaid", orgUnpaid, "owner");
  outsider = await signedInMember("outsider", null);
});

after(async () => {
  for (const id of orgIds) await service.from("organizations").delete().eq("id", id); // cascades memberships and opportunity_sync_state
  for (const id of userIds) await service.auth.admin.deleteUser(id);
});

test("1. CONCURRENCY: 10 simultaneous claims for one organization (from two different members) yield exactly one true", async () => {
  assert.equal(await stateRow(orgA), null, "fresh organization: no claim row yet");
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(i % 2 === 0 ? ownerA : memberA, orgA)));
  assert.equal(results.filter(Boolean).length, 1, `exactly one winner: ${JSON.stringify(results)}`);
  assert.ok(await stateRow(orgA), "the winner wrote the organization's row");
});

test("2. CONCURRENCY after expiry: once the cooldown has passed, 10 simultaneous claims again yield exactly one true", async () => {
  await backdate(orgA, 5 * 60 + 5);
  const results = await Promise.all(Array.from({ length: 10 }, () => claim(ownerA, orgA)));
  assert.equal(results.filter(Boolean).length, 1, JSON.stringify(results));
});

test("3. the 5-minute cooldown on the real database: 4m55s after a claim still loses, 5m05s wins", async () => {
  await backdate(orgA, 4 * 60 + 55);
  assert.equal(await claim(ownerA, orgA), false);
  await backdate(orgA, 5 * 60 + 5);
  assert.equal(await claim(memberA, orgA), true, "any member role can win");
  assert.equal(await claim(ownerA, orgA), false, "and the new claim restarts the cooldown");
});

test("4. organizations are independent: organization B's claim wins while A is inside its cooldown, and A is unaffected", async () => {
  const before = await stateRow(orgA);
  assert.equal(await claim(ownerB, orgB), true);
  assert.equal(await claim(ownerA, orgA), false);
  assert.equal(String((await stateRow(orgA))!.last_started_at), String(before!.last_started_at));
});

test("5. membership gates the claim: a signed-in user who is not a member gets false, and nothing is written - even for an organization with no claim yet", async () => {
  const orgFresh = await createOrg("Sync Claim Test Org Fresh", "active");
  assert.equal(await claim(outsider, orgFresh), false);
  assert.equal(await stateRow(orgFresh), null);
  assert.equal(await claim(ownerA, orgB), false, "a member of A cannot claim B");
});

test("6. payment gates the claim: payment_required loses and writes nothing; the same owner wins once the organization is active", async () => {
  assert.equal(await claim(ownerUnpaid, orgUnpaid), false);
  assert.equal(await stateRow(orgUnpaid), null);
  for (const status of ["suspended", "cancelled"] as const) {
    await service.from("organizations").update({ payment_status: status }).eq("id", orgUnpaid);
    assert.equal(await claim(ownerUnpaid, orgUnpaid), false, status);
  }
  await service.from("organizations").update({ payment_status: "active" }).eq("id", orgUnpaid);
  assert.equal(await claim(ownerUnpaid, orgUnpaid), true);
});

test("7. a nonexistent organization gets the same false as any ineligible one - no existence signal", async () => {
  assert.equal(await claim(ownerA, "00000000-0000-4000-8000-000000000000"), false);
});

test("8. anon cannot execute claim_opportunity_sync", async () => {
  assert.equal((await anon.auth.getSession()).data.session, null, "the anon client really is anonymous");
  const { data, error } = await anon.rpc("claim_opportunity_sync", { p_organization_id: orgB });
  assert.ok(error, `anon must be refused, got data=${JSON.stringify(data)}`);
  assert.match(`${error!.code} ${error!.message}`, /42501|permission denied/i);
});

test("9. the state table is unreachable directly: SELECT/INSERT/UPDATE/DELETE are refused to authenticated and anon", async () => {
  for (const [label, client] of [["authenticated", ownerA], ["anon", anon]] as const) {
    const select = await client.from("opportunity_sync_state").select("organization_id");
    assert.ok(select.error, `${label} SELECT must be refused, got ${JSON.stringify(select.data)}`);
    const insert = await client.from("opportunity_sync_state").insert({ organization_id: orgUnpaid, last_started_at: new Date().toISOString() });
    assert.ok(insert.error, `${label} INSERT must be refused`);
    const update = await client.from("opportunity_sync_state").update({ last_started_at: new Date(Date.now() + 365 * 86_400_000).toISOString() }).eq("organization_id", orgB);
    assert.ok(update.error, `${label} UPDATE must be refused (it could suppress a sync)`);
    const remove = await client.from("opportunity_sync_state").delete().eq("organization_id", orgB);
    assert.ok(remove.error, `${label} DELETE must be refused`);
  }
  assert.ok(await stateRow(orgB), "organization B's row is intact");
});
