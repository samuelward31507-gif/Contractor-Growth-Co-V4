/**
 * Live proof for the consent-persistence half of Launch Blocker #3 - real
 * Supabase sessions, not source-code inspection.
 *
 * STATUS: supabase/migrations/20260922010000_terms_consent.sql was applied
 * to production (mywznmxtlgajnczjvbmk) on 2026-09-22 after a separate,
 * explicit authorization turn. All 4 tests below now exercise the real
 * production columns and are expected to pass for the real reason (not
 * vacuously, as test 3 briefly did pre-migration when the column simply
 * didn't exist yet).
 *
 * Proves:
 *
 *  - terms_accepted_at/terms_version can be populated on an organization's
 *    own row by that organization's own owner (exactly the write
 *    createOrganization() performs);
 *  - the values round-trip exactly, and terms_version matches the current
 *    TERMS_VERSION constant;
 *  - a payment_required organization's own member can still read/write
 *    these two columns (organizations is intentionally exempt from the
 *    payment_gate_rls_enforcement migration - this proves that exemption
 *    still holds for these new columns specifically, not just the ones
 *    that existed when that migration was written);
 *  - a DIFFERENT organization's admin cannot write these columns onto this
 *    organization - the existing organizations_update (is_org_admin) RLS
 *    policy, unmodified by this change, still enforces isolation.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/legal/consent-persistence.integration.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { TERMS_VERSION } from "./terms-version";

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

let orgA: string;
let orgB: string;
let userAId: string;
let userBId: string;
let sessionA: Awaited<ReturnType<typeof createSessionFor>>;
let sessionB: Awaited<ReturnType<typeof createSessionFor>>;

async function createSessionFor(email: string, password: string) {
  const { data: signIn, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !signIn.session) throw error ?? new Error("no session");
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  });
}

before(async () => {
  const { data: a, error: aErr } = await service.from("organizations").insert({ name: "Consent Test Org A" }).select("id").single();
  if (aErr) throw aErr;
  orgA = a!.id;
  const { data: b, error: bErr } = await service.from("organizations").insert({ name: "Consent Test Org B" }).select("id").single();
  if (bErr) throw bErr;
  orgB = b!.id;

  const password = "a-real-test-password-123";
  const emailA = `consent-test-a-${Date.now()}@example.com`;
  const emailB = `consent-test-b-${Date.now()}@example.com`;
  const { data: userA, error: userAErr } = await service.auth.admin.createUser({ email: emailA, password, email_confirm: true });
  if (userAErr) throw userAErr;
  userAId = userA.user!.id;
  const { data: userB, error: userBErr } = await service.auth.admin.createUser({ email: emailB, password, email_confirm: true });
  if (userBErr) throw userBErr;
  userBId = userB.user!.id;

  await service.from("organization_members").insert({ organization_id: orgA, user_id: userAId, role: "owner" });
  await service.from("organization_members").insert({ organization_id: orgB, user_id: userBId, role: "owner" });

  sessionA = await createSessionFor(emailA, password);
  sessionB = await createSessionFor(emailB, password);
});

after(async () => {
  await service.from("organizations").delete().eq("id", orgA);
  await service.from("organizations").delete().eq("id", orgB);
  await service.auth.admin.deleteUser(userAId);
  await service.auth.admin.deleteUser(userBId);
});

test("1. a fresh organization defaults to terms_accepted_at/terms_version both null (nothing fabricated by the migration itself)", async () => {
  const { data, error } = await service.from("organizations").select("terms_accepted_at, terms_version").eq("id", orgA).single();
  assert.equal(error, null);
  assert.equal(data?.terms_accepted_at, null);
  assert.equal(data?.terms_version, null);
});

test("2. an organization's own owner can write terms_accepted_at/terms_version onto their own org - the exact write createOrganization() performs, even while payment_required (organizations is exempt from the payment gate)", async () => {
  const acceptedAt = new Date().toISOString();
  const { error } = await sessionA.from("organizations").update({ terms_accepted_at: acceptedAt, terms_version: TERMS_VERSION }).eq("id", orgA);
  assert.equal(error, null);

  const { data, error: readError } = await sessionA.from("organizations").select("terms_accepted_at, terms_version, payment_status").eq("id", orgA).single();
  assert.equal(readError, null);
  assert.equal(data?.payment_status, "payment_required", "sanity check: this org is deliberately unpaid for this test");
  // Compare as instants, not strings: PostgREST serializes a timestamptz
  // with a "+00:00" offset, not the "Z" suffix Date.prototype.toISOString()
  // produces - same instant, different (both valid) ISO 8601 string forms.
  assert.equal(new Date(data!.terms_accepted_at as string).getTime(), new Date(acceptedAt).getTime(), "terms_accepted_at must round-trip to the exact same instant");
  assert.equal(data?.terms_version, TERMS_VERSION, "terms_version must equal the current TERMS_VERSION constant");
});

test("3. a DIFFERENT organization's admin cannot write terms_accepted_at/terms_version onto this organization - existing cross-org isolation, unmodified by this change", async () => {
  const spoofedAt = new Date().toISOString();
  await sessionB.from("organizations").update({ terms_accepted_at: spoofedAt, terms_version: "spoofed-version" }).eq("id", orgA);

  const { data } = await service.from("organizations").select("terms_accepted_at, terms_version").eq("id", orgA).single();
  assert.notEqual(data?.terms_version, "spoofed-version", "org B's admin must never be able to overwrite org A's consent record");
});

test("4. terms_accepted_at/terms_version remain readable by an organization's own member even while unpaid - no deadlock, same exemption organizations.payment_status itself relies on", async () => {
  const { data, error } = await sessionA.from("organizations").select("terms_accepted_at, terms_version").eq("id", orgA).single();
  assert.equal(error, null);
  assert.ok(data?.terms_accepted_at, "must still be readable from test 2's write");
});
