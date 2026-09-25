/**
 * Integration tests for Pass 3 (Revenue Intelligence Foundation), Part 5:
 * lib/customers/lifecycle.ts's getCustomerLifecycle and
 * getRepeatCustomerSummary. Real, disposable Supabase fixtures against the
 * real project, matching this codebase's established pattern (see
 * lib/bi/metrics.integration.test.ts) - no mocking layer for a Supabase
 * client exists here.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/customers/lifecycle.integration.test.ts
 */
import { test } from "node:test";
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
const { getCustomerLifecycle, getRepeatCustomerSummary }: typeof import("./lifecycle") = require(path.join(REPO_ROOT, "lib/customers/lifecycle.ts"));

const service = createServiceRoleClient();

async function makeOrg(name: string) {
  const { data } = await service.from("organizations").insert({ name }).select("id").single();
  return data!.id as string;
}

async function makeContact(orgId: string, phone: string) {
  const { data } = await service.from("contacts").insert({ organization_id: orgId, phone }).select("id").single();
  return data!.id as string;
}

async function makeJob(orgId: string, contactId: string | null, status: string, amount: number | null, completedAt: string | null) {
  const { data } = await service
    .from("jobs")
    .insert({ organization_id: orgId, contact_id: contactId, title: "Job", status, amount, completed_at: completedAt })
    .select("id")
    .single();
  return data!.id as string;
}

async function cleanupOrg(orgId: string) {
  await service.from("jobs").delete().eq("organization_id", orgId);
  await service.from("contacts").delete().eq("organization_id", orgId);
  await service.from("organizations").delete().eq("id", orgId);
}

test("1. a contact with zero completed jobs gets a real zeroed shape, never null and never a fabricated average", async () => {
  const orgId = await makeOrg("Lifecycle Test Org (No Jobs)");
  try {
    const contactId = await makeContact(orgId, "+15555560001");
    const lifecycle = await getCustomerLifecycle(service, orgId, contactId);
    assert.equal(lifecycle.totalCompletedJobs, 0);
    assert.equal(lifecycle.firstCompletedJobAt, null);
    assert.equal(lifecycle.lastCompletedJobAt, null);
    assert.equal(lifecycle.daysSinceLastCompletedJob, null);
    assert.equal(lifecycle.isRepeatCustomer, false);
    assert.equal(lifecycle.knownCompletedJobValue, 0);
    assert.equal(lifecycle.knownCompletedJobValueCount, 0);
    assert.equal(lifecycle.averageKnownCompletedJobValue, null);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("2. a repeat customer with a null-amount job: knownCompletedJobValue/average exclude the null, never coerce it to 0", async () => {
  const orgId = await makeOrg("Lifecycle Test Org (Repeat With Null Amount)");
  try {
    const contactId = await makeContact(orgId, "+15555560002");
    await makeJob(orgId, contactId, "completed", null, "2026-01-01T00:00:00.000Z");
    await makeJob(orgId, contactId, "completed", 500, "2026-02-01T00:00:00.000Z");
    await makeJob(orgId, contactId, "scheduled", 900, null); // not completed - must never count

    const lifecycle = await getCustomerLifecycle(service, orgId, contactId, new Date("2026-02-11T00:00:00.000Z"));
    assert.equal(lifecycle.totalCompletedJobs, 2);
    assert.equal(lifecycle.isRepeatCustomer, true);
    assert.equal(new Date(lifecycle.firstCompletedJobAt!).toISOString(), "2026-01-01T00:00:00.000Z", "first completed job should sort earliest first");
    assert.equal(new Date(lifecycle.lastCompletedJobAt!).toISOString(), "2026-02-01T00:00:00.000Z");
    assert.equal(lifecycle.knownCompletedJobValue, 500, "the null-amount job must be excluded from the sum, never treated as 0");
    assert.equal(lifecycle.knownCompletedJobValueCount, 1);
    assert.equal(lifecycle.averageKnownCompletedJobValue, 500);
    assert.equal(lifecycle.daysSinceLastCompletedJob, 10);
  } finally {
    await cleanupOrg(orgId);
  }
});

test("3. organization isolation: a completed job in organization B never appears in organization A's customer lifecycle", async () => {
  const orgA = await makeOrg("Lifecycle Test Org (Isolation A)");
  const orgB = await makeOrg("Lifecycle Test Org (Isolation B)");
  try {
    const contactA = await makeContact(orgA, "+15555560003");
    const contactB = await makeContact(orgB, "+15555560004");
    await makeJob(orgB, contactB, "completed", 999, "2026-01-01T00:00:00.000Z");

    const lifecycle = await getCustomerLifecycle(service, orgA, contactA);
    assert.equal(lifecycle.totalCompletedJobs, 0);
    assert.equal(lifecycle.knownCompletedJobValue, 0);
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

test("4. getRepeatCustomerSummary: counts distinct repeat customers correctly and excludes null amounts from the sum", async () => {
  const orgId = await makeOrg("Lifecycle Test Org (Repeat Summary)");
  try {
    const repeatCustomerA = await makeContact(orgId, "+15555560005");
    const repeatCustomerB = await makeContact(orgId, "+15555560006");
    const oneTimeCustomer = await makeContact(orgId, "+15555560007");

    await makeJob(orgId, repeatCustomerA, "completed", 100, "2026-01-01T00:00:00.000Z");
    await makeJob(orgId, repeatCustomerA, "completed", 200, "2026-01-05T00:00:00.000Z");
    await makeJob(orgId, repeatCustomerB, "completed", null, "2026-01-02T00:00:00.000Z");
    await makeJob(orgId, repeatCustomerB, "completed", 300, "2026-01-06T00:00:00.000Z");
    await makeJob(orgId, oneTimeCustomer, "completed", 400, "2026-01-03T00:00:00.000Z");

    const summary = await getRepeatCustomerSummary(service, orgId);
    assert.equal(summary.customersWithCompletedJob, 3);
    assert.equal(summary.repeatCustomerCount, 2);
    assert.ok(Math.abs(summary.repeatCustomerRate! - (2 / 3) * 100) < 0.01, `expected ~66.67%, got ${summary.repeatCustomerRate}`);
    assert.equal(summary.completedJobCount, 5);
    assert.equal(summary.knownCompletedJobValue, 1000, "100+200+300+400 - the null-amount job must be excluded");
    assert.equal(summary.averageKnownCompletedJobValue, 250, "1000 / 4 known-value jobs, not / 5 total jobs");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("5. getRepeatCustomerSummary organization isolation: organization B's completed jobs never inflate organization A's counts", async () => {
  const orgA = await makeOrg("Lifecycle Test Org (Repeat Summary Isolation A)");
  const orgB = await makeOrg("Lifecycle Test Org (Repeat Summary Isolation B)");
  try {
    const contactB = await makeContact(orgB, "+15555560008");
    await makeJob(orgB, contactB, "completed", 5000, "2026-01-01T00:00:00.000Z");

    const summary = await getRepeatCustomerSummary(service, orgA);
    assert.equal(summary.customersWithCompletedJob, 0);
    assert.equal(summary.repeatCustomerCount, 0);
    assert.equal(summary.repeatCustomerRate, null);
    assert.equal(summary.completedJobCount, 0);
    assert.equal(summary.knownCompletedJobValue, 0);
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});
