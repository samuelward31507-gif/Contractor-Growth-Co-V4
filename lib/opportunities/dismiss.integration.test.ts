/**
 * Finalization pass: dedicated integration tests for
 * dismissOpportunityForOrganization (lib/opportunities/detect.ts) - the
 * state-transition logic behind app/(app)/dashboard/actions.ts's
 * dismissOpportunity Server Action, exercised here with a REAL,
 * session-scoped client (sign-in via the anon key, matching
 * lib/reviews-referrals/tracking.integration.test.ts's own established
 * pattern) so RLS is genuinely enforced, not bypassed via service-role.
 *
 * This write path had no dedicated test before this pass - the Server
 * Action itself can't be invoked directly from a plain node test (its
 * createClient() requires next/headers' cookies(), which only resolves
 * inside a real Next.js request), which is exactly why the logic was
 * extracted into a testable, dependency-injected core function.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/dismiss.integration.test.ts
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
const { dismissOpportunityForOrganization }: typeof import("./detect") = require(path.join(REPO_ROOT, "lib/opportunities/detect.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let organizationId: string;
let otherOrgId: string;
const testUserIds: string[] = [];

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
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return client;
}

async function makeOpenOpportunity(orgId: string, overrides: Record<string, unknown> = {}) {
  const { data } = await service
    .from("opportunities")
    .insert({ organization_id: orgId, type: "qualified_lead_unbooked", status: "open", source_entity_type: "lead", source_entity_id: crypto.randomUUID(), title: "Test Lead", ...overrides })
    .select("id")
    .single();
  return data!.id as string;
}

let member: { id: string; email: string; password: string };
let memberSupabase: ReturnType<typeof createSupabaseClient>;

before(async () => {
  // payment_status defaults to 'payment_required' - the restrictive
  // opportunities_payment_active RLS policy (organization_payment_active())
  // applies to every command including SELECT, so a session-scoped member of
  // an unpaid org can't even read the row. Explicit 'active' here so this
  // suite tests dismiss's own logic, not the (already separately tested)
  // payment gate.
  const { data: org } = await service.from("organizations").insert({ name: "Dismiss Opportunity Test Org", payment_status: "active" }).select("id").single();
  const { data: other } = await service.from("organizations").insert({ name: "Dismiss Opportunity Test Org - Other", payment_status: "active" }).select("id").single();
  organizationId = org!.id;
  otherOrgId = other!.id;

  member = await createTestUser(`dismiss-opportunity-member-${Date.now()}@example.com`);
  await service.from("organization_members").insert({ organization_id: organizationId, user_id: member.id, role: "owner" });
  memberSupabase = await signInAs(member.email, member.password);
});

after(async () => {
  await service.from("opportunities").delete().eq("organization_id", organizationId);
  await service.from("opportunities").delete().eq("organization_id", otherOrgId);
  await service.from("organization_members").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
  await service.from("organizations").delete().eq("id", otherOrgId);
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
});

test("1. an authenticated org member can dismiss their own organization's open opportunity: status -> dismissed, resolution_reason -> 'dismissed'", async () => {
  const opportunityId = await makeOpenOpportunity(organizationId);

  const result = await dismissOpportunityForOrganization(memberSupabase, organizationId, opportunityId);
  assert.deepEqual(result, { ok: true });

  const { data: row } = await service.from("opportunities").select("status, resolution_reason, resolved_at").eq("id", opportunityId).single();
  assert.equal(row!.status, "dismissed");
  assert.equal(row!.resolution_reason, "dismissed");
  assert.ok(row!.resolved_at, "resolved_at must be set on dismissal, matching the existing resolved-opportunity convention");
});

test("2. organization isolation: a session-scoped member of organization A can never dismiss organization B's opportunity, even by guessing its id", async () => {
  const otherOrgOpportunityId = await makeOpenOpportunity(otherOrgId);

  const result = await dismissOpportunityForOrganization(memberSupabase, organizationId, otherOrgOpportunityId);
  assert.deepEqual(result, { ok: false, error: "Opportunity not found" }, "an opportunity belonging to a different organization must resolve to 'not found', never be dismissible");

  const { data: row } = await service.from("opportunities").select("status, resolution_reason").eq("id", otherOrgOpportunityId).single();
  assert.equal(row!.status, "open", "organization B's opportunity must remain untouched");
  assert.equal(row!.resolution_reason, null);
});

test("3. dismissing an already-dismissed opportunity is a harmless no-op: still ok:true, and resolution_reason/resolved_at are never overwritten with a new timestamp", async () => {
  const opportunityId = await makeOpenOpportunity(organizationId);
  const first = await dismissOpportunityForOrganization(memberSupabase, organizationId, opportunityId);
  assert.equal(first.ok, true);

  const { data: afterFirst } = await service.from("opportunities").select("resolved_at").eq("id", opportunityId).single();

  const second = await dismissOpportunityForOrganization(memberSupabase, organizationId, opportunityId);
  assert.deepEqual(second, { ok: true }, "re-dismissing an already-dismissed opportunity must not error - matches the existing 'status !== open -> ok:true, no-op' behavior");

  const { data: afterSecond } = await service.from("opportunities").select("status, resolution_reason, resolved_at").eq("id", opportunityId).single();
  assert.equal(afterSecond!.status, "dismissed");
  assert.equal(afterSecond!.resolution_reason, "dismissed");
  assert.equal(afterSecond!.resolved_at, afterFirst!.resolved_at, "the no-op path must never re-run the update and overwrite the original resolved_at");
});

test("4. a genuinely nonexistent opportunity id resolves to 'not found', never a crash", async () => {
  const result = await dismissOpportunityForOrganization(memberSupabase, organizationId, crypto.randomUUID());
  assert.deepEqual(result, { ok: false, error: "Opportunity not found" });
});

test("5. dismissing a RESOLVED (not open) opportunity is also a harmless no-op - dismiss only ever acts on an open opportunity", async () => {
  const opportunityId = await makeOpenOpportunity(organizationId, { status: "resolved", resolved_at: new Date().toISOString(), resolution_reason: "condition_no_longer_true" });

  const result = await dismissOpportunityForOrganization(memberSupabase, organizationId, opportunityId);
  assert.deepEqual(result, { ok: true });

  const { data: row } = await service.from("opportunities").select("status, resolution_reason").eq("id", opportunityId).single();
  assert.equal(row!.status, "resolved", "an already-resolved opportunity must never be silently reclassified as dismissed");
  assert.equal(row!.resolution_reason, "condition_no_longer_true", "its original resolution reason must be preserved, never overwritten");
});
