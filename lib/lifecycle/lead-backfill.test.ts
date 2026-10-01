/**
 * Phase 2B: the one-off lead-link backfill plan (lib/lifecycle/lead-backfill.ts).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/lifecycle/lead-backfill.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { planLeadBackfill }: typeof import("./lead-backfill") = require(path.join(process.cwd(), "lib/lifecycle/lead-backfill.ts"));

type Input = Parameters<typeof planLeadBackfill>[0];
const D = (day: number) => `2026-09-${String(day).padStart(2, "0")}T12:00:00Z`;

const FIXTURE: Input = {
  leads: [
    { id: "L-solo", contact_id: "c-solo", created_at: D(1) },
    { id: "L-late", contact_id: "c-late", created_at: D(20) },
    { id: "L-m1", contact_id: "c-multi", created_at: D(1) },
    { id: "L-m2", contact_id: "c-multi", created_at: D(15) },
  ],
  estimates: [
    { id: "E-linked", contact_id: "c-multi", lead_id: "L-m1", created_at: D(5) },
    { id: "E-eligible", contact_id: "c-solo", lead_id: null, created_at: D(5) },
    { id: "E-ambiguous", contact_id: "c-multi", lead_id: null, created_at: D(20) },
    { id: "E-lead-after", contact_id: "c-late", lead_id: null, created_at: D(10) },
    { id: "E-no-lead", contact_id: "c-none", lead_id: null, created_at: D(10) },
  ],
  jobs: [
    { id: "J-linked", contact_id: "c-multi", lead_id: "L-m2", estimate_id: "E-linked", created_at: D(25) },
    { id: "J-from-linked-estimate", contact_id: "c-multi", lead_id: null, estimate_id: "E-linked", created_at: D(25) },
    { id: "J-from-planned-estimate", contact_id: "c-solo", lead_id: null, estimate_id: "E-eligible", created_at: D(6) },
    { id: "J-single-earlier", contact_id: "c-multi", lead_id: null, estimate_id: null, created_at: D(10) },
    { id: "J-ambiguous", contact_id: "c-multi", lead_id: null, estimate_id: "E-ambiguous", created_at: D(25) },
    { id: "J-lead-after", contact_id: "c-late", lead_id: null, estimate_id: null, created_at: D(10) },
    { id: "J-no-contact", contact_id: null, lead_id: null, estimate_id: null, created_at: D(10) },
  ],
};

test("dry-run counts by category", () => {
  assert.deepEqual(planLeadBackfill(FIXTURE).counts, {
    estimatesAlreadyLinked: 1,
    estimatesEligible: 1,
    estimatesAmbiguous: 1,
    estimatesSkipped: 2,
    jobsAlreadyLinked: 1,
    jobsInheritingFromEstimate: 2,
    jobsEligibleFromSingleLead: 1,
    jobsAmbiguous: 1,
    jobsSkipped: 2,
    totalRowsToChange: 4,
  });
});

test("estimates: only a contact with EXACTLY ONE lead created BEFORE the estimate - never a later lead, never a choice between leads", () => {
  assert.deepEqual(planLeadBackfill(FIXTURE).estimateUpdates, [{ id: "E-eligible", lead_id: "L-solo" }]);
});

test("jobs: the estimate's lead first (even one planned this run), else exactly one earlier contact lead, else blank", () => {
  assert.deepEqual(planLeadBackfill(FIXTURE).jobUpdates, [
    { id: "J-from-linked-estimate", lead_id: "L-m1", via: "estimate" },
    { id: "J-from-planned-estimate", lead_id: "L-solo", via: "estimate" },
    { id: "J-single-earlier", lead_id: "L-m1", via: "single_lead" },
  ]);
});

test("never overwrites: rows that already have a lead are never in the plan", () => {
  const plan = planLeadBackfill(FIXTURE);
  const linked = new Set([...FIXTURE.estimates, ...FIXTURE.jobs].filter((row) => row.lead_id).map((row) => row.id));
  for (const update of [...plan.estimateUpdates, ...plan.jobUpdates]) assert.ok(!linked.has(update.id), update.id);
});

test("an estimate's lead created at the same instant is not 'before' - skipped, not guessed", () => {
  const plan = planLeadBackfill({ leads: [{ id: "L", contact_id: "c", created_at: D(5) }], estimates: [{ id: "E", contact_id: "c", lead_id: null, created_at: D(5) }], jobs: [] });
  assert.equal(plan.counts.estimatesSkipped, 1);
  assert.equal(plan.counts.totalRowsToChange, 0);
});

test("idempotent: applying the plan and planning again changes nothing", () => {
  const first = planLeadBackfill(FIXTURE);
  const applied = (rows: { id: string; lead_id: string | null }[], updates: { id: string; lead_id: string }[]) =>
    rows.map((row) => ({ ...row, lead_id: row.lead_id ?? updates.find((update) => update.id === row.id)?.lead_id ?? null }));
  const second = planLeadBackfill({ leads: FIXTURE.leads, estimates: applied(FIXTURE.estimates, first.estimateUpdates) as Input["estimates"], jobs: applied(FIXTURE.jobs, first.jobUpdates) as Input["jobs"] });
  assert.equal(second.counts.totalRowsToChange, 0);
  assert.deepEqual([second.estimateUpdates, second.jobUpdates], [[], []]);
  assert.equal(second.counts.estimatesAlreadyLinked, 2);
  assert.equal(second.counts.jobsAlreadyLinked, 4);
});

test("the runner is TEST-locked, dry-run by default, and every write is guarded by lead_id IS NULL", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/lifecycle-lead-backfill.ts"), "utf8");
  assert.match(script, /if \(!url\.includes\(TEST_PROJECT_REF\) \|\| url\.includes\(PRODUCTION_PROJECT_REF\)\)/);
  assert.match(script, /const execute = process\.argv\.includes\("--execute-test"\);/);
  assert.match(script, /if \(!execute\) process\.exit\(0\);/);
  assert.equal([...script.matchAll(/\.update\(\{ lead_id: update\.lead_id \}\)\.eq\("id", update\.id\)\.is\("lead_id", null\)/g)].length, 2);
});
