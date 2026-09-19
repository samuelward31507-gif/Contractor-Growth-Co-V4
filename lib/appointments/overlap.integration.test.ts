/**
 * Integration tests for checkAppointmentOverlap() - production-readiness
 * audit finding (HIGH): double-booking was previously completely
 * unprevented. Against an isolated, fully-cleaned-up test organization on
 * the real Supabase project, matching this codebase's established pattern
 * for exactly this class of DB-backed logic. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/appointments/overlap.integration.test.ts
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
const { checkAppointmentOverlap }: typeof import("./overlap") = require(path.join(REPO_ROOT, "lib/appointments/overlap.ts"));

const service = createServiceRoleClient();
let organizationId: string;

async function makeAppointment(start: string, end: string, status = "scheduled") {
  const { data } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, title: "Test appointment", start_at: start, end_at: end, status })
    .select("id")
    .single();
  return data!.id as string;
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Appointment Overlap Integration Test Org" }).select("id").single();
  organizationId = org!.id;
});

after(async () => {
  await service.from("appointments").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("no existing appointments -> no overlap", async () => {
  const hasOverlap = await checkAppointmentOverlap(service, organizationId, { start_at: "2026-10-01T10:00:00Z", end_at: "2026-10-01T11:00:00Z" });
  assert.equal(hasOverlap, false);
});

test("an identical time slot for an existing scheduled appointment is a conflict", async () => {
  await makeAppointment("2026-10-02T10:00:00Z", "2026-10-02T11:00:00Z");
  const hasOverlap = await checkAppointmentOverlap(service, organizationId, { start_at: "2026-10-02T10:00:00Z", end_at: "2026-10-02T11:00:00Z" });
  assert.equal(hasOverlap, true);
});

test("a partially overlapping time slot is a conflict", async () => {
  await makeAppointment("2026-10-03T10:00:00Z", "2026-10-03T11:00:00Z");
  const hasOverlap = await checkAppointmentOverlap(service, organizationId, { start_at: "2026-10-03T10:30:00Z", end_at: "2026-10-03T11:30:00Z" });
  assert.equal(hasOverlap, true);
});

test("a back-to-back (touching, not overlapping) time slot is NOT a conflict", async () => {
  await makeAppointment("2026-10-04T10:00:00Z", "2026-10-04T11:00:00Z");
  const hasOverlap = await checkAppointmentOverlap(service, organizationId, { start_at: "2026-10-04T11:00:00Z", end_at: "2026-10-04T12:00:00Z" });
  assert.equal(hasOverlap, false);
});

test("a non-overlapping time slot on the same day is NOT a conflict", async () => {
  await makeAppointment("2026-10-05T10:00:00Z", "2026-10-05T11:00:00Z");
  const hasOverlap = await checkAppointmentOverlap(service, organizationId, { start_at: "2026-10-05T14:00:00Z", end_at: "2026-10-05T15:00:00Z" });
  assert.equal(hasOverlap, false);
});

test("a cancelled appointment never counts as a conflict", async () => {
  await makeAppointment("2026-10-06T10:00:00Z", "2026-10-06T11:00:00Z", "cancelled");
  const hasOverlap = await checkAppointmentOverlap(service, organizationId, { start_at: "2026-10-06T10:00:00Z", end_at: "2026-10-06T11:00:00Z" });
  assert.equal(hasOverlap, false);
});

test("a no-show appointment never counts as a conflict", async () => {
  await makeAppointment("2026-10-07T10:00:00Z", "2026-10-07T11:00:00Z", "no_show");
  const hasOverlap = await checkAppointmentOverlap(service, organizationId, { start_at: "2026-10-07T10:00:00Z", end_at: "2026-10-07T11:00:00Z" });
  assert.equal(hasOverlap, false);
});

test("a confirmed appointment counts as a conflict, just like scheduled", async () => {
  await makeAppointment("2026-10-08T10:00:00Z", "2026-10-08T11:00:00Z", "confirmed");
  const hasOverlap = await checkAppointmentOverlap(service, organizationId, { start_at: "2026-10-08T10:00:00Z", end_at: "2026-10-08T11:00:00Z" });
  assert.equal(hasOverlap, true);
});

test("excludeId lets an appointment being updated check against everyone else without conflicting with itself", async () => {
  const id = await makeAppointment("2026-10-09T10:00:00Z", "2026-10-09T11:00:00Z");
  const hasOverlapExcludingSelf = await checkAppointmentOverlap(service, organizationId, { start_at: "2026-10-09T10:00:00Z", end_at: "2026-10-09T11:00:00Z" }, id);
  assert.equal(hasOverlapExcludingSelf, false, "the appointment being edited must not conflict with its own unchanged time slot");

  const other = await makeAppointment("2026-10-09T13:00:00Z", "2026-10-09T14:00:00Z");
  const hasOverlapWithOther = await checkAppointmentOverlap(service, organizationId, { start_at: "2026-10-09T13:30:00Z", end_at: "2026-10-09T14:30:00Z" }, id);
  assert.equal(hasOverlapWithOther, true, "excludeId must not suppress a genuine conflict with a DIFFERENT appointment");
  void other;
});

test("overlap is scoped to the organization - a different organization's identical time slot is never a conflict", async () => {
  const { data: otherOrg } = await service.from("organizations").insert({ name: "Appointment Overlap Integration Test Org - Other" }).select("id").single();
  const otherOrgId = otherOrg!.id as string;

  await service.from("appointments").insert({ organization_id: otherOrgId, title: "Other org appointment", start_at: "2026-10-10T10:00:00Z", end_at: "2026-10-10T11:00:00Z", status: "scheduled" });

  const hasOverlap = await checkAppointmentOverlap(service, organizationId, { start_at: "2026-10-10T10:00:00Z", end_at: "2026-10-10T11:00:00Z" });
  assert.equal(hasOverlap, false);

  await service.from("appointments").delete().eq("organization_id", otherOrgId);
  await service.from("organizations").delete().eq("id", otherOrgId);
});
