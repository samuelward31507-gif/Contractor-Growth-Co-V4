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
const { estimateToJobRate, customerAiInteractions }: typeof import("./metrics") = require(path.join(process.cwd(), "lib/bi/metrics.ts"));

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
