/**
 * Pass 2 (Native Calendar System): integration tests for the blocked_time
 * read layer (lib/scheduling/blocked-time.ts) against the real,
 * migration-created blocked_time table (see
 * supabase/migrations/20260925010000_blocked_time.sql). Real, disposable
 * organizations on the production Supabase project.
 *
 * REQUIRES the blocked_time migration to be applied first - until then,
 * every test here fails with "relation \"public.blocked_time\" does not
 * exist" (or the equivalent PostgREST schema-cache error), which is the
 * expected, honest failure mode for a migration not yet applied - not a
 * bug in this test file or in blocked-time.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/scheduling/blocked-time.integration.test.ts
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
const { getBlockedTimeInRange, getBlockedTimeById }: typeof import("./blocked-time") = require(path.join(REPO_ROOT, "lib/scheduling/blocked-time.ts"));

const service = createServiceRoleClient();

let organizationId: string;
let otherOrgId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Blocked Time Read Test Org", payment_status: "active" }).select("id").single();
  organizationId = org!.id;
  const { data: other } = await service.from("organizations").insert({ name: "Blocked Time Read Test Org (Other)", payment_status: "active" }).select("id").single();
  otherOrgId = other!.id;

  await service.from("blocked_time").insert([
    { organization_id: organizationId, start_at: "2027-05-01T12:00:00.000Z", end_at: "2027-05-01T13:00:00.000Z", reason: "Lunch" },
    { organization_id: organizationId, start_at: "2027-05-05T09:00:00.000Z", end_at: "2027-05-05T17:00:00.000Z", reason: "Vacation" },
    { organization_id: organizationId, start_at: "2027-06-01T09:00:00.000Z", end_at: "2027-06-01T10:00:00.000Z", reason: null },
  ]);
  await service.from("blocked_time").insert({ organization_id: otherOrgId, start_at: "2027-05-01T12:00:00.000Z", end_at: "2027-05-01T13:00:00.000Z", reason: "Other org lunch" });
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("blocked_time").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("getBlockedTimeInRange: returns blocks that overlap the requested range", async () => {
  const results = await getBlockedTimeInRange(service, organizationId, new Date("2027-05-01T00:00:00.000Z"), new Date("2027-05-02T00:00:00.000Z"));
  assert.equal(results.length, 1);
  assert.equal(results[0].reason, "Lunch");
});

test("getBlockedTimeInRange: excludes blocks entirely outside the range", async () => {
  const results = await getBlockedTimeInRange(service, organizationId, new Date("2027-05-01T00:00:00.000Z"), new Date("2027-05-02T00:00:00.000Z"));
  assert.ok(!results.some((b) => b.reason === "Vacation"));
});

test("getBlockedTimeInRange: a null reason (no text entered) is preserved, never coerced to an empty string or placeholder", async () => {
  const results = await getBlockedTimeInRange(service, organizationId, new Date("2027-06-01T00:00:00.000Z"), new Date("2027-06-02T00:00:00.000Z"));
  assert.equal(results[0].reason, null);
});

test("getBlockedTimeInRange: organization isolation - another organization's block is never returned", async () => {
  const results = await getBlockedTimeInRange(service, organizationId, new Date("2027-05-01T00:00:00.000Z"), new Date("2027-05-02T00:00:00.000Z"));
  assert.ok(!results.some((b) => b.reason === "Other org lunch"));
});

test("getBlockedTimeById: returns the row when it belongs to the requested organization", async () => {
  const [row] = await getBlockedTimeInRange(service, organizationId, new Date("2027-05-01T00:00:00.000Z"), new Date("2027-05-02T00:00:00.000Z"));
  const found = await getBlockedTimeById(service, organizationId, row.id);
  assert.ok(found);
  assert.equal(found?.id, row.id);
});

test("getBlockedTimeById: returns null for a real id under the WRONG organization - never leaks cross-tenant", async () => {
  const [row] = await getBlockedTimeInRange(service, organizationId, new Date("2027-05-01T00:00:00.000Z"), new Date("2027-05-02T00:00:00.000Z"));
  const found = await getBlockedTimeById(service, otherOrgId, row.id);
  assert.equal(found, null);
});

test("getBlockedTimeById: a nonexistent id resolves to null, never throws", async () => {
  const found = await getBlockedTimeById(service, organizationId, "00000000-0000-0000-0000-000000000000");
  assert.equal(found, null);
});
