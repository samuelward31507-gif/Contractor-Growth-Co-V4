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
const { getCustomerLifecycle, getRepeatCustomerSummary, getDormantCustomersValueSummary }: typeof import("./lifecycle") = require(path.join(REPO_ROOT, "lib/customers/lifecycle.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

async function signInAs(email: string, password: string) {
  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return client;
}

async function makeOrg(name: string, paymentStatus?: string) {
  const { data } = await service.from("organizations").insert({ name, ...(paymentStatus ? { payment_status: paymentStatus } : {}) }).select("id").single();
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

// ==================== Pass 4 P0: live authenticated-session RLS proof ====================
//
// Every test above uses the service-role client, which bypasses RLS by
// design and therefore cannot prove anything about RLS. lib/customers/
// lifecycle.ts's own two functions take a plain SupabaseClient and apply no
// authorization logic themselves - they trust RLS on `jobs` entirely, the
// same way every other query function in this codebase does. Production
// callers (the analytics page) invoke them under a real user session, so
// this is the one thing about them that had never actually been proven
// end-to-end. Modeled on lib/contacts/merge.integration.test.ts's own
// real-minted-session technique.

test("6. LIVE RLS: organization A's authenticated session gets real lifecycle data for its own organization's contact", async () => {
  const orgA = await makeOrg("Lifecycle RLS Test Org A", "active");
  const testUserIds: string[] = [];
  try {
    const contactA = await makeContact(orgA, "+15555560009");
    await makeJob(orgA, contactA, "completed", 600, "2026-01-01T00:00:00.000Z");

    const email = `lifecycle-rls-a-${Date.now()}@example.com`;
    const password = "a-real-test-password-123";
    const { data: userA, error: userAErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (userAErr) throw userAErr;
    testUserIds.push(userA.user!.id);
    await service.from("organization_members").insert({ organization_id: orgA, user_id: userA.user!.id, role: "owner" });

    const sessionA = await signInAs(email, password);
    const lifecycle = await getCustomerLifecycle(sessionA, orgA, contactA);
    assert.equal(lifecycle.totalCompletedJobs, 1);
    assert.equal(lifecycle.knownCompletedJobValue, 600);
  } finally {
    for (const userId of testUserIds) await service.auth.admin.deleteUser(userId);
    await cleanupOrg(orgA);
  }
});

test("7. LIVE RLS: organization A's authenticated session cannot retrieve organization B's contact lifecycle data, even when organization B's own id is passed explicitly", async () => {
  const orgA = await makeOrg("Lifecycle RLS Test Org A (Cross-Org)", "active");
  const orgB = await makeOrg("Lifecycle RLS Test Org B (Cross-Org)", "active");
  const testUserIds: string[] = [];
  try {
    const contactB = await makeContact(orgB, "+15555560010");
    await makeJob(orgB, contactB, "completed", 9999, "2026-01-01T00:00:00.000Z");
    await makeJob(orgB, contactB, "completed", 8888, "2026-01-05T00:00:00.000Z");

    const email = `lifecycle-rls-crossorg-${Date.now()}@example.com`;
    const password = "a-real-test-password-123";
    const { data: userA, error: userAErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (userAErr) throw userAErr;
    testUserIds.push(userA.user!.id);
    await service.from("organization_members").insert({ organization_id: orgA, user_id: userA.user!.id, role: "owner" });

    const sessionA = await signInAs(email, password);

    // organizationId is passed explicitly by the caller, not derived from
    // the session - this proves RLS itself is the real backstop (is_org_member
    // on jobs denies rows outside the caller's own membership), not just
    // "the caller happened to pass the right id."
    const lifecycle = await getCustomerLifecycle(sessionA, orgB, contactB);
    assert.equal(lifecycle.totalCompletedJobs, 0, "RLS must deny these rows entirely, not just filter them client-side");
    assert.equal(lifecycle.knownCompletedJobValue, 0);
    assert.equal(lifecycle.isRepeatCustomer, false, "organization B's real repeat-customer (2 completed jobs) must not leak through to organization A's session");
  } finally {
    for (const userId of testUserIds) await service.auth.admin.deleteUser(userId);
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

test("8. LIVE RLS: organization A's authenticated session gets an org-wide repeat-customer summary that never includes organization B's data", async () => {
  const orgA = await makeOrg("Lifecycle RLS Test Org A (Summary)", "active");
  const orgB = await makeOrg("Lifecycle RLS Test Org B (Summary)", "active");
  const testUserIds: string[] = [];
  try {
    const contactA = await makeContact(orgA, "+15555560011");
    await makeJob(orgA, contactA, "completed", 111, "2026-01-01T00:00:00.000Z");

    const repeatContactB = await makeContact(orgB, "+15555560012");
    await makeJob(orgB, repeatContactB, "completed", 5000, "2026-01-01T00:00:00.000Z");
    await makeJob(orgB, repeatContactB, "completed", 5000, "2026-01-05T00:00:00.000Z");

    const email = `lifecycle-rls-summary-${Date.now()}@example.com`;
    const password = "a-real-test-password-123";
    const { data: userA, error: userAErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (userAErr) throw userAErr;
    testUserIds.push(userA.user!.id);
    await service.from("organization_members").insert({ organization_id: orgA, user_id: userA.user!.id, role: "owner" });

    const sessionA = await signInAs(email, password);

    const summaryOwnOrg = await getRepeatCustomerSummary(sessionA, orgA);
    assert.equal(summaryOwnOrg.customersWithCompletedJob, 1);
    assert.equal(summaryOwnOrg.knownCompletedJobValue, 111);

    const summaryOtherOrg = await getRepeatCustomerSummary(sessionA, orgB);
    assert.equal(summaryOtherOrg.customersWithCompletedJob, 0, "organization B's real customer must not leak through");
    assert.equal(summaryOtherOrg.repeatCustomerCount, 0, "organization B's real repeat customer (2 completed jobs, $10,000 known value) must not leak through");
    assert.equal(summaryOtherOrg.knownCompletedJobValue, 0);
  } finally {
    for (const userId of testUserIds) await service.auth.admin.deleteUser(userId);
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

// ==================== Pass 4 P1-C: additional-job figures on getRepeatCustomerSummary ====================

test("9. getRepeatCustomerSummary: a customer with exactly 2 completed jobs contributes exactly 1 'additional' job, never counting the first", async () => {
  const orgId = await makeOrg("Lifecycle Test Org (Additional Jobs x2)");
  try {
    const contactId = await makeContact(orgId, "+15555560013");
    await makeJob(orgId, contactId, "completed", 500, "2026-01-01T00:00:00.000Z"); // first - never "additional"
    await makeJob(orgId, contactId, "completed", 700, "2026-02-01T00:00:00.000Z"); // additional

    const summary = await getRepeatCustomerSummary(service, orgId);
    assert.equal(summary.additionalCompletedJobCount, 1);
    assert.equal(summary.additionalCompletedJobKnownValue, 700, "only the second (additional) job's value, never the first job's $500");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("10. getRepeatCustomerSummary: a customer with 3 completed jobs contributes 2 additional jobs, and a one-time customer contributes 0", async () => {
  const orgId = await makeOrg("Lifecycle Test Org (Additional Jobs x3 Plus One-Time)");
  try {
    const repeatContact = await makeContact(orgId, "+15555560014");
    await makeJob(orgId, repeatContact, "completed", 100, "2026-01-01T00:00:00.000Z");
    await makeJob(orgId, repeatContact, "completed", 200, "2026-01-05T00:00:00.000Z");
    await makeJob(orgId, repeatContact, "completed", 300, "2026-01-10T00:00:00.000Z");

    const oneTimeContact = await makeContact(orgId, "+15555560015");
    await makeJob(orgId, oneTimeContact, "completed", 999, "2026-01-01T00:00:00.000Z");

    const summary = await getRepeatCustomerSummary(service, orgId);
    assert.equal(summary.additionalCompletedJobCount, 2, "the repeat customer's 2nd and 3rd jobs are additional - the one-time customer's single job never counts");
    assert.equal(summary.additionalCompletedJobKnownValue, 500, "200 + 300 - the first job's $100 is excluded, and the one-time customer's $999 is excluded entirely");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("11. getRepeatCustomerSummary: a NULL amount on the customer's first job never blocks the additional jobs' own known values from being summed", async () => {
  const orgId = await makeOrg("Lifecycle Test Org (Additional Jobs Null First)");
  try {
    const contactId = await makeContact(orgId, "+15555560016");
    await makeJob(orgId, contactId, "completed", null, "2026-01-01T00:00:00.000Z"); // first, unknown value
    await makeJob(orgId, contactId, "completed", 400, "2026-01-05T00:00:00.000Z"); // additional, known
    await makeJob(orgId, contactId, "completed", null, "2026-01-10T00:00:00.000Z"); // additional, unknown

    const summary = await getRepeatCustomerSummary(service, orgId);
    assert.equal(summary.additionalCompletedJobCount, 2, "2 additional jobs (2nd and 3rd) regardless of whether their amounts are known");
    assert.equal(summary.additionalCompletedJobKnownValue, 400, "only the one additional job with a real amount - the null ones are excluded, never coerced to 0");
  } finally {
    await cleanupOrg(orgId);
  }
});

// ==================== Pass 4 P1-B/E: getDormantCustomersValueSummary ====================

test("12. getDormantCustomersValueSummary: sums known value across the given dormant contacts and counts those with no known value at all", async () => {
  const orgId = await makeOrg("Lifecycle Test Org (Dormant Value Summary)");
  try {
    const knownValueContact = await makeContact(orgId, "+15555560017");
    await makeJob(orgId, knownValueContact, "completed", 1500, "2026-01-01T00:00:00.000Z");

    const mixedContact = await makeContact(orgId, "+15555560018");
    await makeJob(orgId, mixedContact, "completed", null, "2026-01-01T00:00:00.000Z");
    await makeJob(orgId, mixedContact, "completed", 900, "2026-01-05T00:00:00.000Z");

    const unknownValueContact = await makeContact(orgId, "+15555560019");
    await makeJob(orgId, unknownValueContact, "completed", null, "2026-01-01T00:00:00.000Z");

    const summary = await getDormantCustomersValueSummary(service, orgId, [knownValueContact, mixedContact, unknownValueContact]);
    assert.equal(summary.knownValue, 2400, "1500 + 900 - only the real, non-null amounts, from any of the given contacts' completed jobs");
    assert.equal(summary.unknownValueCount, 1, "only unknownValueContact has ZERO known-value jobs among the given set");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("13. getDormantCustomersValueSummary: an empty contact id list returns a real zeroed shape, never queries the database", async () => {
  const summary = await getDormantCustomersValueSummary(service, "00000000-0000-0000-0000-000000000000", []);
  assert.equal(summary.knownValue, 0);
  assert.equal(summary.unknownValueCount, 0);
});

test("14. getDormantCustomersValueSummary: never sums a completed job belonging to a contact NOT in the given id list - no join fanout, no over-inclusion", async () => {
  const orgId = await makeOrg("Lifecycle Test Org (Dormant Value No Fanout)");
  try {
    const includedContact = await makeContact(orgId, "+15555560020");
    await makeJob(orgId, includedContact, "completed", 200, "2026-01-01T00:00:00.000Z");

    const excludedContact = await makeContact(orgId, "+15555560021");
    await makeJob(orgId, excludedContact, "completed", 99999, "2026-01-01T00:00:00.000Z");

    const summary = await getDormantCustomersValueSummary(service, orgId, [includedContact]);
    assert.equal(summary.knownValue, 200, "excludedContact's job must never be included just because it exists in the same organization");
  } finally {
    await cleanupOrg(orgId);
  }
});

test("15. getDormantCustomersValueSummary: organization isolation - a contact id from organization B is never queried against organization A's jobs table", async () => {
  const orgA = await makeOrg("Lifecycle Test Org (Dormant Value Isolation A)");
  const orgB = await makeOrg("Lifecycle Test Org (Dormant Value Isolation B)");
  try {
    const contactB = await makeContact(orgB, "+15555560022");
    await makeJob(orgB, contactB, "completed", 5000, "2026-01-01T00:00:00.000Z");

    // Ask for organization B's contact but scope the query to organization A.
    const summary = await getDormantCustomersValueSummary(service, orgA, [contactB]);
    assert.equal(summary.knownValue, 0, "organization B's job must never be summed under organization A's scope");
    assert.equal(summary.unknownValueCount, 1, "the contact is correctly reported as having no known-value job within organization A's own data");
  } finally {
    await cleanupOrg(orgA);
    await cleanupOrg(orgB);
  }
});

test("16. exactly one completed job is never a repeat customer - the boundary between test 1 (0 jobs) and test 2 (2 jobs)", async () => {
  const orgId = await makeOrg("Lifecycle Test Org (Exactly One Job)");
  try {
    const contactId = await makeContact(orgId, "+15555560023");
    await makeJob(orgId, contactId, "completed", 800, "2026-01-01T00:00:00.000Z");

    const lifecycle = await getCustomerLifecycle(service, orgId, contactId);
    assert.equal(lifecycle.totalCompletedJobs, 1);
    assert.equal(lifecycle.isRepeatCustomer, false, "1 completed job is a real customer with history, but not yet a repeat customer");
    assert.equal(lifecycle.knownCompletedJobValue, 800);
    assert.equal(lifecycle.knownCompletedJobValueCount, 1);
    assert.equal(lifecycle.averageKnownCompletedJobValue, 800);

    const summary = await getRepeatCustomerSummary(service, orgId);
    assert.equal(summary.repeatCustomerCount, 0);
    assert.equal(summary.additionalCompletedJobCount, 0, "a single job is never itself an 'additional' job");
  } finally {
    await cleanupOrg(orgId);
  }
});
