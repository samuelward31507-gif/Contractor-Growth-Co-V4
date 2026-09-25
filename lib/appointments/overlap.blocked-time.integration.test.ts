/**
 * Pass 2 (Native Calendar System): integration tests for
 * checkBlockedTimeOverlap (lib/appointments/overlap.ts) - the manual
 * create/edit path's fast pre-check that a new or rescheduled appointment
 * doesn't land inside a native blocked period. REQUIRES the blocked_time
 * migration to be applied first (see
 * supabase/migrations/20260925010000_blocked_time.sql).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/appointments/overlap.blocked-time.integration.test.ts
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
const { checkBlockedTimeOverlap }: typeof import("./overlap") = require(path.join(REPO_ROOT, "lib/appointments/overlap.ts"));

const service = createServiceRoleClient();

let organizationId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Blocked Time Overlap Test Org", payment_status: "active" }).select("id").single();
  organizationId = org!.id;
  await service.from("blocked_time").insert({ organization_id: organizationId, start_at: "2027-05-10T12:00:00.000Z", end_at: "2027-05-10T13:00:00.000Z", reason: "Lunch" });
});

after(async () => {
  await service.from("blocked_time").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("a candidate time fully inside a blocked period overlaps", async () => {
  const result = await checkBlockedTimeOverlap(service, organizationId, { start_at: "2027-05-10T12:15:00.000Z", end_at: "2027-05-10T12:45:00.000Z" });
  assert.equal(result, true);
});

test("a candidate time partially overlapping the start of a blocked period overlaps", async () => {
  const result = await checkBlockedTimeOverlap(service, organizationId, { start_at: "2027-05-10T11:30:00.000Z", end_at: "2027-05-10T12:30:00.000Z" });
  assert.equal(result, true);
});

test("a candidate time entirely before the blocked period does not overlap", async () => {
  const result = await checkBlockedTimeOverlap(service, organizationId, { start_at: "2027-05-10T09:00:00.000Z", end_at: "2027-05-10T10:00:00.000Z" });
  assert.equal(result, false);
});

test("a back-to-back candidate (touching, not overlapping) does not overlap", async () => {
  const result = await checkBlockedTimeOverlap(service, organizationId, { start_at: "2027-05-10T13:00:00.000Z", end_at: "2027-05-10T14:00:00.000Z" });
  assert.equal(result, false);
});

test("no blocked time configured for the organization at all never overlaps", async () => {
  const { data: freshOrg } = await service.from("organizations").insert({ name: "Blocked Time Overlap Test Org (fresh)", payment_status: "active" }).select("id").single();
  try {
    const result = await checkBlockedTimeOverlap(service, freshOrg!.id, { start_at: "2027-05-10T12:15:00.000Z", end_at: "2027-05-10T12:45:00.000Z" });
    assert.equal(result, false);
  } finally {
    await service.from("organizations").delete().eq("id", freshOrg!.id);
  }
});
