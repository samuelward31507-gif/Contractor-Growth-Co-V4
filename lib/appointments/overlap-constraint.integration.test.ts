/**
 * Live integration tests for the database-level double-booking guarantee
 * added by supabase/migrations/20260922030000_appointment_double_booking_protection.sql
 * (Phase 1 Scheduling Foundation, Stage 1) - the `appointments_no_overlap`
 * EXCLUDE constraint. Complements (does not replace)
 * lib/appointments/overlap.integration.test.ts, which already proves the
 * application-level fast-path check's semantics; this file proves the
 * actual DB-level guarantee underneath it, including the one thing an
 * application-level check can never prove on its own: that two genuinely
 * concurrent insert attempts for the same slot cannot both succeed.
 *
 * IMPORTANT - CURRENT STATUS: this migration has been written but NOT yet
 * applied to the database (blocked by this environment's own migration-
 * apply safety classifier - the user runs it manually per their standing
 * preference). Until it's applied, exactly the tests that require the
 * constraint to actually REJECT an overlapping insert - #2, #6, #8 - are
 * EXPECTED TO FAIL (both inserts silently succeed with no constraint
 * present); tests #1/#3/#4/#5/#7 only assert successful inserts, so they
 * pass regardless of whether the migration has landed yet - that's the
 * accurate, honest signal, not a defect in this file. Once the migration is
 * applied, re-run this file and all 8 should pass for the real reason.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "lib/appointments/overlap-constraint.integration.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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

const service = createServiceRoleClient();

let organizationId: string;
let otherOrganizationId: string;

async function insertAppointment(orgId: string, start: string, end: string, status = "scheduled") {
  return service.from("appointments").insert({ organization_id: orgId, title: "Test appointment", start_at: start, end_at: end, status }).select("id").single();
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Double-Booking Constraint Test Org" }).select("id").single();
  organizationId = org!.id;
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Double-Booking Constraint Test Org (Other)" }).select("id").single();
  otherOrganizationId = otherOrg!.id;
});

after(async () => {
  await service.from("appointments").delete().eq("organization_id", organizationId);
  await service.from("appointments").delete().eq("organization_id", otherOrganizationId);
  await service.from("organizations").delete().eq("id", organizationId);
  await service.from("organizations").delete().eq("id", otherOrganizationId);
});

test("1. a non-overlapping appointment inserts cleanly", async () => {
  const { error } = await insertAppointment(organizationId, "2027-01-01T10:00:00Z", "2027-01-01T11:00:00Z");
  assert.equal(error, null);
});

test("2. an overlapping scheduled appointment is rejected at the database layer with an exclusion violation (23P01), not merely by the application-level check", async () => {
  const { error: firstError } = await insertAppointment(organizationId, "2027-01-02T10:00:00Z", "2027-01-02T11:00:00Z");
  assert.equal(firstError, null);

  const { error: secondError } = await insertAppointment(organizationId, "2027-01-02T10:30:00Z", "2027-01-02T11:30:00Z");
  assert.ok(secondError, "an overlapping insert must be rejected");
  assert.equal(secondError!.code, "23P01", "must be a Postgres exclusion_violation, proving the DB constraint itself is what rejected it");
});

test("3. a back-to-back (touching, not overlapping) appointment is NOT rejected - the same boundary semantics as the application-level check", async () => {
  const { error: firstError } = await insertAppointment(organizationId, "2027-01-03T10:00:00Z", "2027-01-03T11:00:00Z");
  assert.equal(firstError, null);

  const { error: secondError } = await insertAppointment(organizationId, "2027-01-03T11:00:00Z", "2027-01-03T12:00:00Z");
  assert.equal(secondError, null, "a slot starting exactly when another ends must never be rejected");
});

test("4. a cancelled appointment never blocks an overlapping insert", async () => {
  const { error: firstError } = await insertAppointment(organizationId, "2027-01-04T10:00:00Z", "2027-01-04T11:00:00Z", "cancelled");
  assert.equal(firstError, null);

  const { error: secondError } = await insertAppointment(organizationId, "2027-01-04T10:00:00Z", "2027-01-04T11:00:00Z", "scheduled");
  assert.equal(secondError, null, "a cancelled appointment must never occupy the slot at the DB layer either");
});

test("5. a no_show appointment never blocks an overlapping insert", async () => {
  const { error: firstError } = await insertAppointment(organizationId, "2027-01-05T10:00:00Z", "2027-01-05T11:00:00Z", "no_show");
  assert.equal(firstError, null);

  const { error: secondError } = await insertAppointment(organizationId, "2027-01-05T10:00:00Z", "2027-01-05T11:00:00Z", "scheduled");
  assert.equal(secondError, null, "a no_show appointment must never occupy the slot at the DB layer either");
});

test("6. a completed appointment DOES block an overlapping insert, exactly like scheduled/confirmed", async () => {
  const { error: firstError } = await insertAppointment(organizationId, "2027-01-06T10:00:00Z", "2027-01-06T11:00:00Z", "completed");
  assert.equal(firstError, null);

  const { error: secondError } = await insertAppointment(organizationId, "2027-01-06T10:00:00Z", "2027-01-06T11:00:00Z", "scheduled");
  assert.ok(secondError, "a completed appointment must still occupy its slot");
  assert.equal(secondError!.code, "23P01");
});

test("7. two different organizations may hold the exact same time slot - the constraint is scoped per-organization, not global", async () => {
  const { error: firstError } = await insertAppointment(organizationId, "2027-01-07T10:00:00Z", "2027-01-07T11:00:00Z");
  assert.equal(firstError, null);

  const { error: secondError } = await insertAppointment(otherOrganizationId, "2027-01-07T10:00:00Z", "2027-01-07T11:00:00Z");
  assert.equal(secondError, null, "a different organization's identical time slot must never be rejected");
});

test("8. CONCURRENCY: two genuinely simultaneous insert attempts for the same slot result in exactly one success - proves the constraint, not just the sequential-check code path", async () => {
  const start = "2027-01-08T10:00:00Z";
  const end = "2027-01-08T11:00:00Z";

  // Two independent service-role clients (not the same client instance,
  // and not awaited sequentially) firing their inserts via Promise.all -
  // the closest a single Node process can get to genuinely concurrent
  // requests hitting Postgres at the same time. A purely application-level
  // check-then-insert (no DB constraint) would let both of these through;
  // only a real EXCLUDE constraint can guarantee exactly one wins.
  const clientA = createServiceRoleClient();
  const clientB = createServiceRoleClient();

  const [resultA, resultB] = await Promise.all([
    clientA.from("appointments").insert({ organization_id: organizationId, title: "Concurrent A", start_at: start, end_at: end, status: "scheduled" }).select("id").single(),
    clientB.from("appointments").insert({ organization_id: organizationId, title: "Concurrent B", start_at: start, end_at: end, status: "scheduled" }).select("id").single(),
  ]);

  const succeeded = [resultA, resultB].filter((r) => !r.error);
  const failed = [resultA, resultB].filter((r) => r.error);

  assert.equal(succeeded.length, 1, "exactly one of the two concurrent inserts must succeed");
  assert.equal(failed.length, 1, "exactly one of the two concurrent inserts must fail");
  assert.equal(failed[0].error!.code, "23P01", "the losing insert must fail specifically with an exclusion violation, not some other error");
});
