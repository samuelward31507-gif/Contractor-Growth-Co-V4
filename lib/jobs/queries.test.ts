/**
 * Unit tests for filterJobs()/summarizeJobs() - the pure, already-fetched-
 * list logic behind the Jobs list page's search/status filter and overview
 * strip. Mirrors lib/estimates/queries.test.ts's shape and needs the same
 * "@/"-alias resolution bridge - see lib/automation/test-loader.mjs. Run
 * with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/jobs/queries.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { filterJobs, summarizeJobs }: typeof import("./queries") = require("./queries.ts");

type Job = import("./queries").Job;

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: overrides.id ?? "job-1",
    organization_id: "org-1",
    contact_id: "contact-1",
    lead_id: null,
    estimate_id: "est-1",
    title: "AC Replacement",
    amount: 4500,
    status: "scheduled",
    started_at: null,
    completed_at: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    contact: { id: "contact-1", first_name: "Jane", last_name: "Doe", company_name: "Doe LLC", phone: "555-1000", email: "jane@example.com" },
    lead: null,
    estimate: null,
    ...overrides,
  };
}

test("filterJobs: no filters returns every job", () => {
  const jobs = [makeJob({ id: "a" }), makeJob({ id: "b", status: "in_progress" })];
  assert.equal(filterJobs(jobs, {}).length, 2);
});

test("filterJobs: status filter narrows to matching status only", () => {
  const jobs = [makeJob({ id: "a", status: "scheduled" }), makeJob({ id: "b", status: "completed" })];
  const result = filterJobs(jobs, { status: "completed" });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "b");
});

test("filterJobs: status 'all' is a no-op", () => {
  const jobs = [makeJob({ id: "a", status: "scheduled" }), makeJob({ id: "b", status: "cancelled" })];
  assert.equal(filterJobs(jobs, { status: "all" }).length, 2);
});

test("filterJobs: query matches the job title", () => {
  const jobs = [makeJob({ id: "a", title: "Roof Repair" }), makeJob({ id: "b", title: "AC Replacement" })];
  const result = filterJobs(jobs, { query: "roof" });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "a");
});

test("filterJobs: query matches contact full name, split across first/last", () => {
  const jobs = [
    makeJob({ id: "a", contact: { id: "c1", first_name: "Jane", last_name: "Doe", company_name: null, phone: null, email: null } }),
    makeJob({ id: "b", contact: { id: "c2", first_name: "John", last_name: "Smith", company_name: null, phone: null, email: null } }),
  ];
  const result = filterJobs(jobs, { query: "jane doe" });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "a");
});

test("filterJobs: job with no contact never throws and is excluded by a name search", () => {
  const jobs = [makeJob({ id: "a", contact: null })];
  assert.doesNotThrow(() => filterJobs(jobs, { query: "jane" }));
  assert.equal(filterJobs(jobs, { query: "jane" }).length, 0);
});

test("filterJobs: query and status combine with AND semantics", () => {
  const jobs = [
    makeJob({ id: "a", status: "scheduled", title: "Roof Repair" }),
    makeJob({ id: "b", status: "in_progress", title: "Roof Repair" }),
  ];
  const result = filterJobs(jobs, { query: "roof", status: "in_progress" });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "b");
});

test("summarizeJobs: totals and per-status counts on an empty list", () => {
  const summary = summarizeJobs([]);
  assert.deepEqual(summary, { total: 0, scheduledCount: 0, inProgressCount: 0, completedValue: 0 });
});

test("summarizeJobs: counts scheduled and in_progress separately from other statuses", () => {
  const jobs = [
    makeJob({ id: "a", status: "scheduled" }),
    makeJob({ id: "b", status: "scheduled" }),
    makeJob({ id: "c", status: "in_progress" }),
    makeJob({ id: "d", status: "cancelled" }),
  ];
  const summary = summarizeJobs(jobs);
  assert.equal(summary.total, 4);
  assert.equal(summary.scheduledCount, 2);
  assert.equal(summary.inProgressCount, 1);
});

test("summarizeJobs: completedValue sums only completed jobs' amounts, treating null as zero", () => {
  const jobs = [
    makeJob({ id: "a", status: "completed", amount: 1000 }),
    makeJob({ id: "b", status: "completed", amount: null }),
    makeJob({ id: "c", status: "completed", amount: 500 }),
    makeJob({ id: "d", status: "in_progress", amount: 9999 }),
  ];
  assert.equal(summarizeJobs(jobs).completedValue, 1500);
});
