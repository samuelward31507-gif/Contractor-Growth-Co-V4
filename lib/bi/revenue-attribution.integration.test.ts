/**
 * Phase 2C: revenue attribution against real, disposable TEST fixtures -
 * Lead → Estimate → Job → completed job value attributed to the lead's
 * source, organization isolation, organization-timezone month boundaries,
 * and a job whose own lead differs from its estimate's.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/revenue-attribution.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
require("@next/env").loadEnvConfig(REPO_ROOT, true, { info() {}, error() {} });

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getRevenueAttribution }: typeof import("./revenue-attribution") = require(path.join(REPO_ROOT, "lib/bi/revenue-attribution.ts"));
const { resolveDateRange }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/bi/queries.ts"));

const service = createServiceRoleClient();
let orgA: string;
let orgB: string;
let orgEmpty: string;

async function org(name: string) {
  const { data, error } = await service.from("organizations").insert({ name }).select("id").single();
  if (error) throw error;
  return data!.id as string;
}
let phone = 0;
async function contact(orgId: string) {
  const { data, error } = await service.from("contacts").insert({ organization_id: orgId, phone: `+1555555${String(8100 + phone++)}` }).select("id").single();
  if (error) throw error;
  return data!.id as string;
}
async function lead(orgId: string, contactId: string, source: string | null, createdAt: string) {
  const { data, error } = await service.from("leads").insert({ organization_id: orgId, contact_id: contactId, source, status: "won", temperature: "warm", created_at: createdAt }).select("id").single();
  if (error) throw error;
  return data!.id as string;
}
async function estimate(orgId: string, contactId: string, leadId: string | null) {
  const { data, error } = await service.from("estimates").insert({ organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Quote", status: "accepted", amount: 1 }).select("id").single();
  if (error) throw error;
  return data!.id as string;
}
async function job(orgId: string, contactId: string, fields: { leadId: string | null; estimateId?: string | null; status: string; amount: number | null; createdAt: string; completedAt?: string | null }) {
  const { error } = await service.from("jobs").insert({
    organization_id: orgId,
    contact_id: contactId,
    lead_id: fields.leadId,
    estimate_id: fields.estimateId ?? null,
    title: "Job",
    status: fields.status,
    amount: fields.amount,
    created_at: fields.createdAt,
    completed_at: fields.completedAt ?? null,
  });
  if (error) throw error;
}

// "Last month" seen from Oct 15 in Denver: Sep 1 00:00 MDT (06:00Z) to Oct 1 00:00 MDT (06:00Z).
const NOW = new Date("2026-10-15T18:00:00Z");
const SEP_30_EVENING_DENVER = "2026-10-01T05:00:00Z"; // Oct 1 in UTC, still Sep 30 in Denver
const OCT_1_MORNING_DENVER = "2026-10-01T07:00:00Z";

before(async () => {
  orgA = await org("Revenue Attribution Test Org A");
  orgB = await org("Revenue Attribution Test Org B");
  orgEmpty = await org("Revenue Attribution Test Org (empty)");
  const c = await contact(orgA);

  // Lead → Estimate → Job → completed: the full chain, attributed to Google.
  const google = await lead(orgA, c, "Google", "2026-09-10T15:00:00Z");
  const googleEstimate = await estimate(orgA, c, google);
  await job(orgA, c, { leadId: google, estimateId: googleEstimate, status: "completed", amount: 1200, createdAt: "2026-09-12T15:00:00Z", completedAt: "2026-09-20T15:00:00Z" });
  await job(orgA, c, { leadId: google, status: "cancelled", amount: 999, createdAt: "2026-09-13T15:00:00Z" }); // second job, cancelled

  // Sep 30 evening in Denver - inside last month, though Oct 1 in UTC.
  const lateGoogle = await lead(orgA, c, " Google ", SEP_30_EVENING_DENVER);
  await job(orgA, c, { leadId: lateGoogle, status: "completed", amount: 300, createdAt: "2026-10-01T05:10:00Z", completedAt: "2026-10-01T05:30:00Z" });

  // Oct 1 morning in Denver - outside last month.
  const referral = await lead(orgA, c, "Referral", OCT_1_MORNING_DENVER);
  await job(orgA, c, { leadId: referral, status: "completed", amount: 5000, createdAt: OCT_1_MORNING_DENVER, completedAt: "2026-10-02T15:00:00Z" });

  // No source: Unknown source. Its second job came from Google's estimate - the job's own lead wins.
  const noSource = await lead(orgA, c, null, "2026-09-05T15:00:00Z");
  await job(orgA, c, { leadId: noSource, status: "scheduled", amount: 800, createdAt: "2026-09-06T15:00:00Z" });
  const ambiguousEstimate = await estimate(orgA, c, google);
  await job(orgA, c, { leadId: noSource, estimateId: ambiguousEstimate, status: "completed", amount: 100, createdAt: "2026-09-24T15:00:00Z", completedAt: "2026-09-25T15:00:00Z" });

  // A lead with no job yet.
  await lead(orgA, c, "Website", "2026-09-08T15:00:00Z");

  // A direct job with no lead: No lead linked, never dropped.
  await job(orgA, c, { leadId: null, status: "completed", amount: 450, createdAt: "2026-09-14T15:00:00Z", completedAt: "2026-09-15T15:00:00Z" });

  // Organization B - same source and month, never counted for A.
  const cb = await contact(orgB);
  const otherGoogle = await lead(orgB, cb, "Google", "2026-09-10T15:00:00Z");
  await job(orgB, cb, { leadId: otherGoogle, status: "completed", amount: 9999, createdAt: "2026-09-12T15:00:00Z", completedAt: "2026-09-20T15:00:00Z" });
});

after(async () => {
  for (const orgId of [orgA, orgB, orgEmpty].filter(Boolean)) {
    await service.from("jobs").delete().eq("organization_id", orgId);
    await service.from("estimates").delete().eq("organization_id", orgId);
    await service.from("leads").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("last month in Denver: Lead → Estimate → Job → completed value is attributed to its source; unknown and unlinked kept; Oct 1 Denver excluded; org B never counted", async () => {
  const result = await getRevenueAttribution(service, orgA, resolveDateRange("previousMonth", NOW, "America/Denver"));
  assert.equal(result.failed, false);
  assert.deepEqual(
    result.rows.map((row) => [row.label, row.leads, row.jobs, row.completedJobs, row.completedValue]),
    [
      ["Google", 2, 2, 2, 1500],
      ["Website", 1, 0, 0, 0],
      ["Unknown source", 1, 2, 1, 100],
      ["No lead linked", null, 1, 1, 450],
    ],
  );
  assert.deepEqual(result.totals, { leads: 4, jobs: 5, completedJobs: 4, completedValue: 2050 });
  assert.deepEqual(result.conversion, { leads: 4, leadsWithJob: 3, jobRate: 75, completedJobs: 3, completedValue: 1600 });
});

test("all time: every job and lead is in, including the Oct 1 Referral chain", async () => {
  const result = await getRevenueAttribution(service, orgA, resolveDateRange("allTime", NOW, "America/Denver"));
  assert.deepEqual(result.totals, { leads: 5, jobs: 6, completedJobs: 5, completedValue: 7050 });
  assert.deepEqual(result.rows.find((row) => row.label === "Referral"), { key: "source:Referral", label: "Referral", kind: "source", leads: 1, jobs: 1, completedJobs: 1, completedValue: 5000 });
  assert.deepEqual(result.conversion, { leads: 5, leadsWithJob: 4, jobRate: 80, completedJobs: 4, completedValue: 6600 });
});

test("organization isolation and an empty organization", async () => {
  const b = await getRevenueAttribution(service, orgB, resolveDateRange("allTime", NOW, "America/Denver"));
  assert.deepEqual(b.rows.map((row) => [row.label, row.completedValue]), [["Google", 9999]]);
  const empty = await getRevenueAttribution(service, orgEmpty, resolveDateRange("previousMonth", NOW, "America/Denver"));
  assert.deepEqual([empty.rows, empty.totals, empty.conversion.jobRate, empty.failed], [[], { leads: 0, jobs: 0, completedJobs: 0, completedValue: 0 }, null, false]);
});
