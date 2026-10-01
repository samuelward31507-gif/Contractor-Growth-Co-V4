/**
 * Phase 2D: the outcome-dated Analytics figures (lib/bi/outcome-metrics.ts)
 * - the pure summary and the query shape. Denver boundaries, a job created
 * in August and completed in September, cancelled/no-show exclusion and
 * the headline-equals-Revenue-by-source check run against TEST in
 * outcome-metrics.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/outcome-metrics.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { summarizeOutcomeMetrics, NOT_A_BOOKING_STATUSES }: typeof import("./outcome-metrics") = require(path.join(process.cwd(), "lib/bi/outcome-metrics.ts"));

test("completed jobs and value: every completed amount summed (strings parsed, a missing amount counts but adds nothing)", () => {
  const result = summarizeOutcomeMetrics({ completedJobAmounts: [1200, "300.50", null], acceptedEstimates: 0, declinedEstimates: 0, leadsInRange: 0, leadsWithActiveBooking: 0 });
  assert.deepEqual([result.completedJobs, result.completedJobValue], [3, 1500.5]);
});

test("rates are percentages over their own denominators, and null - never 0% - when there is nothing to divide by", () => {
  const result = summarizeOutcomeMetrics({ completedJobAmounts: [], acceptedEstimates: 3, declinedEstimates: 1, leadsInRange: 8, leadsWithActiveBooking: 2 });
  assert.equal(result.estimateAcceptanceRate, 75);
  assert.equal(result.leadToBookingRate, 25);
  const empty = summarizeOutcomeMetrics({ completedJobAmounts: [], acceptedEstimates: 0, declinedEstimates: 0, leadsInRange: 0, leadsWithActiveBooking: 0 });
  assert.deepEqual([empty.estimateAcceptanceRate, empty.leadToBookingRate, empty.completedJobValue], [null, null, 0]);
});

test("cancelled and no-show appointments never count as a booking", () => {
  assert.deepEqual([...NOT_A_BOOKING_STATUSES], ["cancelled", "no_show"]);
});

test("queries: outcome-dated columns, the same completed-job filters as Revenue by source, a server-side join for bookings, no ID lists", () => {
  const strip = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const source = strip("lib/bi/outcome-metrics.ts");
  assert.doesNotMatch(source, /\.in\(/);
  assert.equal((source.match(/\.eq\("organization_id", organizationId\)/g) ?? []).length, 5);
  assert.match(source, /from\("jobs"\)\.select\("amount"\)\.eq\("organization_id", organizationId\)\.eq\("status", "completed"\), "completed_at"\)/);
  assert.match(source, /\.eq\("status", "accepted"\), "responded_at"\)/);
  assert.match(source, /\.eq\("status", "declined"\), "responded_at"\)/);
  assert.match(source, /appointments!appointments_lead_id_fkey!inner\(id\)[\s\S]*\.not\("appointments\.status", "in"/);
  // Revenue by source's completed read uses the same three filters, so the headline equals its total.
  const attribution = strip("lib/bi/revenue-attribution.ts");
  assert.match(attribution, /\.eq\("organization_id", organizationId\)\.eq\("status", "completed"\);\s*if \(range\.from\) query = query\.gte\("completed_at", range\.from\);\s*if \(range\.to\) query = query\.lt\("completed_at", range\.to\);/);
});
