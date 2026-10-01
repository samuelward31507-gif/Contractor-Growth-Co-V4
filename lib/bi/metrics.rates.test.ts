/**
 * Two pure pieces of lib/bi/metrics.ts:
 *   - estimateToJobRate: accepted estimates that became a job, never all jobs
 *     over accepted estimates - so it can't exceed 100%;
 *   - customerAiInteractions: every AI interaction except the owner's own
 *     business_insights reports (aiInteractions keeps them, for cost).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/metrics.rates.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { estimateToJobRate, customerAiInteractions, computeEstimateAging, groupOpportunityOutcomes, summarizeAppointmentStatuses }: typeof import("./metrics") = require(path.join(process.cwd(), "lib/bi/metrics.ts"));
const { sentRequestOutcomes }: typeof import("./queries") = require(path.join(process.cwd(), "lib/bi/queries.ts"));

const accepted = (id: string, job: "array" | "object" | "none") => ({ id, jobs: job === "array" ? [{ id: `job-${id}` }] : job === "object" ? { id: `job-${id}` } : job === "none" ? [] : null });

test("estimate → job counts accepted estimates with a linked job - the embed may arrive as an array or a one-to-one object", () => {
  assert.equal(estimateToJobRate([accepted("a", "array"), accepted("b", "none")], 2), 50);
  assert.equal(estimateToJobRate([accepted("a", "object"), accepted("b", "none"), { id: "c", jobs: null }], 3), (1 / 3) * 100);
  assert.equal(estimateToJobRate([accepted("a", "array"), accepted("b", "object")], 2), 100);
});

test("estimate → job: a directly-created job (no estimate) never inflates the rate - it isn't linked to any accepted estimate", () => {
  // The old definition was totalJobs / acceptedEstimates: 1 linked job + 3
  // direct jobs over 1 accepted estimate read as 400%. Only the linked job
  // can appear on an accepted estimate's row.
  const rows = [accepted("a", "array")];
  assert.equal(estimateToJobRate(rows, 1), 100);
  assert.equal(estimateToJobRate([accepted("a", "none")], 1), 0, "direct jobs elsewhere leave an unlinked accepted estimate at 0%");
});

test("estimate → job can never exceed 100%, and is null when nothing was accepted", () => {
  for (const [rows, acceptedCount] of [
    [[accepted("a", "array"), accepted("b", "array"), accepted("c", "array")], 3],
    [[accepted("a", "array"), accepted("b", "array"), accepted("c", "array")], 2],
    [[accepted("a", "array")], 1],
  ] as const) {
    const value = estimateToJobRate([...rows], acceptedCount);
    assert.ok(value !== null && value <= 100, `${value}`);
  }
  assert.equal(estimateToJobRate([], 0), null);
});

test("business_insights counts toward aiInteractions but never toward customerAiInteractions", () => {
  const byType = { customer_reply_response: 3, lead_followup_response: 2, business_insights: 2 };
  const total = 7;
  assert.equal(customerAiInteractions(total, byType), 5);
  assert.equal(customerAiInteractions(3, { customer_reply_response: 3 }), 3, "no reports: the two counts agree");
  assert.equal(customerAiInteractions(2, { business_insights: 2 }), 0, "only reports: nothing customer-facing");
  assert.equal(customerAiInteractions(0, {}), 0);
});

// ---------------------------------------------------------------------------
// Phase 2A: review / referral outcomes over requests actually sent
// ---------------------------------------------------------------------------

const req = (status: string, responded_at: string | null = null) => ({ status, responded_at });
const REPLIED = "2026-09-20T12:00:00Z";

test("review response: a reply later completed still counts as responded; a completion with no recorded reply does not", () => {
  const result = sentRequestOutcomes([req("completed", REPLIED), req("completed", null), req("responded", REPLIED), req("requested"), req("declined", REPLIED)], "completed");
  assert.equal(result.sent, 5);
  assert.equal(result.withResponse, 3, "completed+reply, responded, declined+reply - not the completion without a reply");
  assert.equal(result.outcomes, 2);
  assert.equal(result.responseRate, 60);
  assert.equal(result.outcomeRate, 40);
});

test("referral conversion: converted after a reply counts as a response and a conversion", () => {
  const result = sentRequestOutcomes([req("converted", REPLIED), req("converted", null), req("requested")], "converted");
  assert.deepEqual([result.sent, result.withResponse, result.outcomes], [3, 1, 2]);
  assert.equal(Math.round(result.responseRate! * 100) / 100, 33.33);
});

test("failed and not_requested requests are never in the denominator - and never count as responses", () => {
  const result = sentRequestOutcomes([req("failed", REPLIED), req("not_requested"), req("requested"), req("responded", REPLIED)], "completed");
  assert.deepEqual([result.sent, result.withResponse, result.outcomes], [2, 1, 0]);
  assert.equal(result.responseRate, 50);
});

test("nothing sent: rates are null, never a fabricated 0%; rates can never exceed 100%", () => {
  assert.deepEqual(sentRequestOutcomes([req("failed"), req("not_requested")], "completed"), { sent: 0, withResponse: 0, outcomes: 0, responseRate: null, outcomeRate: null });
  assert.deepEqual(sentRequestOutcomes([], "converted"), { sent: 0, withResponse: 0, outcomes: 0, responseRate: null, outcomeRate: null });
  const all = sentRequestOutcomes([req("completed", REPLIED), req("completed", REPLIED)], "completed");
  assert.equal(all.responseRate, 100);
  assert.equal(all.outcomeRate, 100);
});

// ---------------------------------------------------------------------------
// Phase 2A: estimate aging, opportunity outcomes, appointment occurrence
// ---------------------------------------------------------------------------

test("estimate aging: Denver calendar days since sent - 7 is 0-7, 8 and 30 are 8-30, 31 is 31+; undated kept apart; past expiry counted", () => {
  const now = new Date("2026-10-01T05:30:00Z"); // 23:30 MDT Sep 30 in Denver
  const sent = (sentAt: string | null, amount: number, expiresAt: string | null = null) => ({ amount, sent_at: sentAt, expires_at: expiresAt });
  const aging = computeEstimateAging(
    [
      sent("2026-09-30T06:00:00Z", 100), // Sep 30 Denver: 0 days
      sent("2026-09-23T18:00:00Z", 200), // Sep 23: 7 days
      sent("2026-09-22T18:00:00Z", 300), // Sep 22: 8 days
      sent("2026-08-31T18:00:00Z", 400), // Aug 31: 30 days
      sent("2026-08-30T18:00:00Z", 500, "2026-09-29T06:00:00Z"), // Aug 30: 31 days, past expiry
      sent("2026-09-23T05:00:00Z", 50), // 23:00 MDT Sep 22 in Denver (UTC already Sep 23): 8 days
      sent(null, 60),
    ],
    now,
    "America/Denver",
  );
  assert.deepEqual(aging.buckets.map((bucket) => [bucket.key, bucket.count, bucket.value]), [["0-7", 2, 300], ["8-30", 3, 750], ["31+", 1, 500], ["undated", 1, 60]]);
  assert.deepEqual([aging.pastExpiryCount, aging.pastExpiryValue], [1, 500]);
});

test("opportunity outcomes: lost, no longer applies, dismissed and other - nothing labeled recovered", () => {
  const groups = groupOpportunityOutcomes([
    { status: "resolved", resolution_reason: "lost", estimated_value: 1000 },
    { status: "resolved", resolution_reason: "condition_no_longer_true", estimated_value: 400 },
    { status: "resolved", resolution_reason: "condition_no_longer_true", estimated_value: null },
    { status: "dismissed", resolution_reason: "dismissed", estimated_value: 250 },
    { status: "dismissed", resolution_reason: null, estimated_value: 100 },
    { status: "resolved", resolution_reason: null, estimated_value: 75 },
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.count, group.value]), [["Marked lost", 1, 1000], ["No longer applies", 2, 400], ["Dismissed", 2, 350], ["Other", 1, 75]]);
  assert.ok(!groups.some((group) => /recover/i.test(group.label)));
});

test("appointment occurrence summary: same status counts and no-show rate definition as the booking-date metrics", () => {
  const metrics = summarizeAppointmentStatuses([{ status: "completed" }, { status: "completed" }, { status: "no_show" }, { status: "cancelled" }, { status: "scheduled" }, { status: "confirmed" }]);
  assert.deepEqual(
    [metrics.totalAppointments, metrics.scheduledAppointments, metrics.confirmedAppointments, metrics.completedAppointments, metrics.cancelledAppointments, metrics.noShowAppointments],
    [6, 1, 1, 2, 1, 1],
  );
  assert.equal(metrics.appointmentNoShowRate, 25, "no-shows / (completed + cancelled + no-show)");
  assert.equal(summarizeAppointmentStatuses([{ status: "scheduled" }]).appointmentNoShowRate, null);
});
