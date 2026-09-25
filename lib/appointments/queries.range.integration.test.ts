/**
 * Pass 2 (Native Calendar System): integration tests for
 * getAppointmentsInRange (lib/appointments/queries.ts) - the calendar's own
 * range-scoped appointment fetch, distinct from getAppointments()'s
 * unscoped, capped-at-1000 read. Real, disposable organizations/contacts on
 * the production Supabase project.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/appointments/queries.range.integration.test.ts
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
const { getAppointmentsInRange }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/appointments/queries.ts"));

const service = createServiceRoleClient();

let organizationId: string;
let otherOrgId: string;
let contactId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Calendar Range Query Test Org", payment_status: "active" }).select("id").single();
  organizationId = org!.id;
  const { data: other } = await service.from("organizations").insert({ name: "Calendar Range Query Test Org (Other)", payment_status: "active" }).select("id").single();
  otherOrgId = other!.id;

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15555740001" }).select("id").single();
  contactId = contact!.id;

  await service.from("appointments").insert([
    { organization_id: organizationId, contact_id: contactId, title: "Before range", start_at: "2027-04-01T09:00:00.000Z", end_at: "2027-04-01T10:00:00.000Z", status: "scheduled" },
    { organization_id: organizationId, contact_id: contactId, title: "Inside range", start_at: "2027-04-05T09:00:00.000Z", end_at: "2027-04-05T10:00:00.000Z", status: "scheduled" },
    { organization_id: organizationId, contact_id: contactId, title: "Spans into range", start_at: "2027-04-04T23:00:00.000Z", end_at: "2027-04-05T01:00:00.000Z", status: "confirmed" },
    { organization_id: organizationId, contact_id: contactId, title: "Cancelled but still visible on the calendar", start_at: "2027-04-06T09:00:00.000Z", end_at: "2027-04-06T10:00:00.000Z", status: "cancelled" },
    { organization_id: organizationId, contact_id: contactId, title: "After range", start_at: "2027-04-10T09:00:00.000Z", end_at: "2027-04-10T10:00:00.000Z", status: "scheduled" },
  ]);

  const { data: otherContact } = await service.from("contacts").insert({ organization_id: otherOrgId, phone: "+15555740002" }).select("id").single();
  await service.from("appointments").insert({ organization_id: otherOrgId, contact_id: otherContact!.id, title: "Other org, same week", start_at: "2027-04-05T09:00:00.000Z", end_at: "2027-04-05T10:00:00.000Z", status: "scheduled" });
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("appointments").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

const RANGE = { start: new Date("2027-04-04T00:00:00.000Z"), end: new Date("2027-04-07T00:00:00.000Z") };

test("returns appointments that start inside the range", async () => {
  const results = await getAppointmentsInRange(service, organizationId, RANGE.start, RANGE.end);
  assert.ok(results.some((a) => a.title === "Inside range"));
});

test("returns an appointment that merely spans into the range, even though it starts before it", async () => {
  const results = await getAppointmentsInRange(service, organizationId, RANGE.start, RANGE.end);
  assert.ok(results.some((a) => a.title === "Spans into range"), "an appointment starting before the range but ending inside it must still be returned");
});

test("excludes appointments entirely before or after the range", async () => {
  const results = await getAppointmentsInRange(service, organizationId, RANGE.start, RANGE.end);
  assert.ok(!results.some((a) => a.title === "Before range"));
  assert.ok(!results.some((a) => a.title === "After range"));
});

test("includes cancelled/no-show appointments - the calendar shows every status, unlike the availability engine's own occupying-status filter", async () => {
  const results = await getAppointmentsInRange(service, organizationId, RANGE.start, RANGE.end);
  assert.ok(results.some((a) => a.title === "Cancelled but still visible on the calendar"));
});

test("organization isolation: another organization's appointment in the same real time range is never returned", async () => {
  const results = await getAppointmentsInRange(service, organizationId, RANGE.start, RANGE.end);
  assert.ok(!results.some((a) => a.title === "Other org, same week"));
});

test("results are ordered by start_at ascending", async () => {
  const results = await getAppointmentsInRange(service, organizationId, RANGE.start, RANGE.end);
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1].start_at <= results[i].start_at);
  }
});

test("an empty range with no matching appointments returns an empty array, not an error", async () => {
  const results = await getAppointmentsInRange(service, organizationId, new Date("2030-01-01T00:00:00.000Z"), new Date("2030-01-02T00:00:00.000Z"));
  assert.deepEqual(results, []);
});
