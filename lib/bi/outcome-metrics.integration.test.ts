/**
 * Phase 2D: outcome-dated Analytics figures against real, disposable TEST
 * fixtures - Denver month boundaries, a job created in August and completed
 * in September, cancelled/no-show appointments excluded from lead →
 * booking, the headline completed job value equal to Revenue by source's
 * completed total, and organization isolation.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/outcome-metrics.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
require("@next/env").loadEnvConfig(REPO_ROOT, true, { info() {}, error() {} });

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getOutcomeMetrics }: typeof import("./outcome-metrics") = require(path.join(REPO_ROOT, "lib/bi/outcome-metrics.ts"));
const { getRevenueAttribution }: typeof import("./revenue-attribution") = require(path.join(REPO_ROOT, "lib/bi/revenue-attribution.ts"));
const { resolveDateRange }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/bi/queries.ts"));

const service = createServiceRoleClient();
let orgA: string;
let orgB: string;

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await service.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data!.id as string;
}

// "Last month" seen from Oct 15 in Denver: Sep 1 00:00 MDT (06:00Z) to Oct 1 00:00 MDT (06:00Z).
const NOW = new Date("2026-10-15T18:00:00Z");
const SEP_30_EVENING_DENVER = "2026-10-01T05:00:00Z";
const OCT_1_MORNING_DENVER = "2026-10-01T07:00:00Z";
let phone = 0;

async function seed(orgId: string) {
  const contactId = await insert("contacts", { organization_id: orgId, phone: `+1555555${String(8200 + phone++)}` });
  const lead = (createdAt: string) => insert("leads", { organization_id: orgId, contact_id: contactId, source: "Google", status: "won", temperature: "warm", created_at: createdAt });
  const job = (fields: { leadId?: string | null; status: string; amount: number; createdAt: string; completedAt?: string | null }) =>
    insert("jobs", { organization_id: orgId, contact_id: contactId, lead_id: fields.leadId ?? null, title: "Job", status: fields.status, amount: fields.amount, created_at: fields.createdAt, completed_at: fields.completedAt ?? null });
  const estimate = (status: string, createdAt: string, respondedAt: string | null) =>
    insert("estimates", { organization_id: orgId, contact_id: contactId, title: "Quote", status, amount: 1, created_at: createdAt, responded_at: respondedAt });
  let hour = 0;
  const appointment = (leadId: string, status: string) =>
    insert("appointments", { organization_id: orgId, contact_id: contactId, lead_id: leadId, title: "Visit", status, start_at: `2026-09-20T${String(10 + hour).padStart(2, "0")}:00:00Z`, end_at: `2026-09-20T${String(10 + hour++).padStart(2, "0")}:30:00Z` });
  return { contactId, lead, job, estimate, appointment };
}

before(async () => {
  orgA = await insert("organizations", { name: "Outcome Metrics Test Org A" });
  orgB = await insert("organizations", { name: "Outcome Metrics Test Org B" });
  const a = await seed(orgA);

  // Jobs - dated by completion.
  const jobLead = await a.lead("2026-08-10T15:00:00Z");
  await a.job({ leadId: jobLead, status: "completed", amount: 400, createdAt: "2026-08-20T15:00:00Z", completedAt: "2026-09-10T15:00:00Z" }); // created Aug, completed Sep: in
  await a.job({ leadId: jobLead, status: "completed", amount: 1200, createdAt: "2026-09-12T15:00:00Z", completedAt: "2026-10-01T05:30:00Z" }); // Sep 30 evening Denver: in
  await a.job({ leadId: jobLead, status: "completed", amount: 5000, createdAt: "2026-09-25T15:00:00Z", completedAt: OCT_1_MORNING_DENVER }); // Oct 1 Denver: out
  await a.job({ leadId: null, status: "completed", amount: 450, createdAt: "2026-09-14T15:00:00Z", completedAt: "2026-09-15T15:00:00Z" }); // no lead: in
  await a.job({ status: "cancelled", amount: 999, createdAt: "2026-09-16T15:00:00Z" });
  await a.job({ status: "scheduled", amount: 777, createdAt: "2026-09-17T15:00:00Z" });

  // Estimates - dated by the customer's answer.
  await a.estimate("accepted", "2026-09-01T15:00:00Z", "2026-09-05T15:00:00Z");
  await a.estimate("accepted", "2026-08-01T15:00:00Z", SEP_30_EVENING_DENVER); // created Aug, answered Sep 30 Denver: in
  await a.estimate("declined", "2026-09-10T15:00:00Z", "2026-09-20T15:00:00Z");
  await a.estimate("accepted", "2026-09-28T15:00:00Z", OCT_1_MORNING_DENVER); // answered Oct 1 Denver: out
  await a.estimate("declined", "2026-09-28T15:00:00Z", "2026-10-02T15:00:00Z"); // created Sep, answered Oct: out

  // Leads created last month, and their appointments.
  const booked = await a.lead("2026-09-03T15:00:00Z");
  await a.appointment(booked, "completed");
  const cancelledOnly = await a.lead("2026-09-04T15:00:00Z");
  await a.appointment(cancelledOnly, "cancelled");
  const noShowOnly = await a.lead("2026-09-05T15:00:00Z");
  await a.appointment(noShowOnly, "no_show");
  const twoAppointments = await a.lead("2026-09-06T15:00:00Z");
  await a.appointment(twoAppointments, "no_show");
  await a.appointment(twoAppointments, "scheduled");
  await a.appointment(twoAppointments, "confirmed");
  const lateSep = await a.lead(SEP_30_EVENING_DENVER);
  await a.appointment(lateSep, "confirmed");
  const oct1 = await a.lead(OCT_1_MORNING_DENVER);
  await a.appointment(oct1, "scheduled");

  // Organization B - same month, never counted for A.
  const b = await seed(orgB);
  const otherLead = await b.lead("2026-09-03T15:00:00Z");
  await b.appointment(otherLead, "completed");
  await b.job({ status: "completed", amount: 9999, createdAt: "2026-09-12T15:00:00Z", completedAt: "2026-09-20T15:00:00Z" });
  await b.estimate("accepted", "2026-09-01T15:00:00Z", "2026-09-05T15:00:00Z");
});

after(async () => {
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    for (const table of ["appointments", "jobs", "estimates", "leads", "contacts"]) await service.from(table).delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("last month in Denver: completed by completion date, acceptance by answer date, bookings without cancelled or no-show", async () => {
  const range = resolveDateRange("previousMonth", NOW, "America/Denver");
  const result = await getOutcomeMetrics(service, orgA, range);
  assert.equal(result.failed, false);
  assert.deepEqual([result.completedJobs, result.completedJobValue], [3, 2050], "Aug-created/Sep-completed $400 + Sep 30 Denver $1,200 + unlinked $450; Oct 1 Denver $5,000 out");
  assert.deepEqual([result.acceptedEstimates, result.declinedEstimates], [2, 1]);
  assert.equal(Math.round(result.estimateAcceptanceRate! * 100) / 100, 66.67);
  assert.equal(result.leadsInRange, 5, "Sep 3/4/5/6 and Sep 30 Denver - not Aug 10, not Oct 1 Denver");
  assert.equal(result.leadsWithActiveBooking, 3, "completed, the two-appointment lead (once), Sep 30 Denver - not cancelled-only or no-show-only");
  assert.equal(result.leadToBookingRate, 60);
});

test("the headline completed job value equals Revenue by source's completed total for the same period", async () => {
  for (const preset of ["previousMonth", "currentMonth", "allTime"] as const) {
    const range = resolveDateRange(preset, NOW, "America/Denver");
    const [outcomes, attribution] = await Promise.all([getOutcomeMetrics(service, orgA, range), getRevenueAttribution(service, orgA, range)]);
    assert.equal(outcomes.completedJobValue, attribution.totals.completedValue, preset);
    assert.equal(outcomes.completedJobs, attribution.totals.completedJobs, preset);
  }
});

test("this month and all time; organization B is never counted", async () => {
  const thisMonth = await getOutcomeMetrics(service, orgA, resolveDateRange("currentMonth", NOW, "America/Denver"));
  assert.deepEqual([thisMonth.completedJobs, thisMonth.completedJobValue, thisMonth.acceptedEstimates, thisMonth.declinedEstimates, thisMonth.leadsInRange, thisMonth.leadsWithActiveBooking], [1, 5000, 1, 1, 1, 1]);
  const allTime = await getOutcomeMetrics(service, orgA, resolveDateRange("allTime", NOW, "America/Denver"));
  assert.deepEqual([allTime.completedJobs, allTime.completedJobValue, allTime.acceptedEstimates, allTime.declinedEstimates, allTime.leadsInRange, allTime.leadsWithActiveBooking], [4, 7050, 3, 2, 7, 4]);
  const other = await getOutcomeMetrics(service, orgB, resolveDateRange("previousMonth", NOW, "America/Denver"));
  assert.deepEqual([other.completedJobValue, other.acceptedEstimates, other.leadsInRange, other.leadsWithActiveBooking], [9999, 1, 1, 1]);
});
