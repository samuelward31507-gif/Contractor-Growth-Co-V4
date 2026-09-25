/**
 * Pass 2 (Native Calendar System): tests for the blocked_time migration
 * (supabase/migrations/20260925010000_blocked_time.sql) itself.
 *
 * Two parts, deliberately split by what each can actually prove:
 *
 * 1. A structural check of the migration's own SQL text, verifying its RLS
 *    and payment-gate policies are an exact structural mirror of
 *    appointments' own already-tested policies (is_org_member/
 *    is_org_admin, organization_payment_active()) - not a live RLS proof
 *    (that would require a full authenticated-session harness, like
 *    lib/auth/payment-gate-rls.integration.test.ts's own considerably
 *    heavier fixture; the mirror-of-an-already-proven-pattern approach here
 *    is the deliberately lighter-weight, still-meaningful alternative for a
 *    new table whose policies are a verbatim copy, not novel logic).
 *
 * 2. A live check-constraint test via the service-role client (constraints
 *    apply regardless of role, unlike RLS) - REQUIRES the migration to be
 *    applied first.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "supabase/migrations/blocked-time-migration.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const MIGRATION_PATH = path.join(REPO_ROOT, "supabase/migrations/20260925010000_blocked_time.sql");
const MIGRATION_SOURCE = fs.readFileSync(MIGRATION_PATH, "utf8");

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

test("1. the table is organization-scoped, with a foreign key to organizations and cascade delete - matching appointments/business_hours' own shape", () => {
  assert.match(MIGRATION_SOURCE, /organization_id uuid not null references public\.organizations\(id\) on delete cascade/);
});

test("2. a database-level check constraint requires end_at > start_at - never trusting only application-level validation", () => {
  assert.match(MIGRATION_SOURCE, /check \(end_at > start_at\)/);
});

test("3. RLS is enabled, and select/insert/update/delete policies all gate on is_org_member() - the exact same member-level access appointments already has, never admin-only like services", () => {
  assert.match(MIGRATION_SOURCE, /alter table public\.blocked_time enable row level security/);
  for (const op of ["select", "insert", "update", "delete"]) {
    assert.match(MIGRATION_SOURCE, new RegExp(`create policy blocked_time_${op} on public\\.blocked_time for ${op}(?: to authenticated)? using \\(is_org_member\\(organization_id\\)\\)|create policy blocked_time_${op} on public\\.blocked_time for ${op} to authenticated with check \\(is_org_member\\(organization_id\\)\\)`), `expected a member-scoped ${op} policy`);
  }
});

test("4. the payment-gate RESTRICTIVE policy reuses organization_payment_active() verbatim - the exact same function every other ordinary business-data table (appointments, business_hours, booking_settings) already relies on, never a new/duplicated payment check", () => {
  assert.match(MIGRATION_SOURCE, /create policy blocked_time_payment_active on public\.blocked_time as restrictive for all to public/);
  assert.match(MIGRATION_SOURCE, /using \(public\.organization_payment_active\(organization_id\)\)/);
  assert.match(MIGRATION_SOURCE, /with check \(public\.organization_payment_active\(organization_id\)\)/);
});

test("5. an index on (organization_id, start_at) exists for efficient range queries - matching appointments' own idx_appointments_start shape", () => {
  assert.match(MIGRATION_SOURCE, /create index if not exists idx_blocked_time_org_start on public\.blocked_time \(organization_id, start_at\)/);
});

test("6. no exclusion constraint is added on blocked_time itself - a deliberate difference from appointments_no_overlap, documented in the migration's own comment", () => {
  assert.doesNotMatch(MIGRATION_SOURCE, /exclude using gist/i);
});

// ---------------------------------------------------------------------------
// Live constraint test - requires the migration to actually be applied.
// ---------------------------------------------------------------------------

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const service = createServiceRoleClient();
let organizationId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Blocked Time Migration Constraint Test Org", payment_status: "active" }).select("id").single();
  organizationId = org!.id;
});

after(async () => {
  await service.from("blocked_time").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("7. LIVE: a valid blocked_time row (end after start) inserts cleanly", async () => {
  const { error } = await service.from("blocked_time").insert({ organization_id: organizationId, start_at: "2027-07-01T09:00:00.000Z", end_at: "2027-07-01T10:00:00.000Z" });
  assert.equal(error, null);
});

test("8. LIVE: an invalid row (end_at <= start_at) is rejected at the database layer (23514), never silently accepted", async () => {
  const { error } = await service.from("blocked_time").insert({ organization_id: organizationId, start_at: "2027-07-02T10:00:00.000Z", end_at: "2027-07-02T09:00:00.000Z" });
  assert.ok(error, "an invalid time range must be rejected");
  assert.equal(error!.code, "23514");
});

test("9. LIVE: deleting the organization cascades to its blocked_time rows", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Blocked Time Cascade Test Org", payment_status: "active" }).select("id").single();
  const { data: block } = await service.from("blocked_time").insert({ organization_id: org!.id, start_at: "2027-07-03T09:00:00.000Z", end_at: "2027-07-03T10:00:00.000Z" }).select("id").single();

  await service.from("organizations").delete().eq("id", org!.id);

  const { data: remaining } = await service.from("blocked_time").select("id").eq("id", block!.id);
  assert.equal(remaining?.length ?? 0, 0, "blocked_time rows must be cascade-deleted with their organization");
});
