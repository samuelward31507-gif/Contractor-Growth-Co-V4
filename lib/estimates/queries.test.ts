/**
 * Unit tests for filterEstimates()/summarizeEstimates() - the pure,
 * already-fetched-list logic behind the Estimates list page's search/status
 * filter and overview strip. Mirrors lib/leads/queries.ts's
 * filterLeads/summarizeLeads test shape and needs the same "@/"-alias
 * resolution bridge - see lib/automation/test-loader.mjs. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/estimates/queries.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { filterEstimates, summarizeEstimates }: typeof import("./queries") = require("./queries.ts");

type Estimate = import("./queries").Estimate;

function makeEstimate(overrides: Partial<Estimate>): Estimate {
  return {
    id: overrides.id ?? "est-1",
    organization_id: "org-1",
    contact_id: "contact-1",
    lead_id: null,
    title: "AC Replacement",
    amount: 4500,
    status: "draft",
    notes: null,
    sent_at: null,
    responded_at: null,
    expires_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    contact: { id: "contact-1", first_name: "Jane", last_name: "Doe", company_name: "Doe LLC", phone: "555-1000", email: "jane@example.com" },
    lead: null,
    ...overrides,
  };
}

test("filterEstimates: no filters returns every estimate", () => {
  const estimates = [makeEstimate({ id: "a" }), makeEstimate({ id: "b", status: "sent" })];
  assert.equal(filterEstimates(estimates, {}).length, 2);
});

test("filterEstimates: status filter narrows to matching status only", () => {
  const estimates = [makeEstimate({ id: "a", status: "draft" }), makeEstimate({ id: "b", status: "sent" })];
  const result = filterEstimates(estimates, { status: "sent" });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "b");
});

test("filterEstimates: status 'all' is a no-op", () => {
  const estimates = [makeEstimate({ id: "a", status: "draft" }), makeEstimate({ id: "b", status: "sent" })];
  assert.equal(filterEstimates(estimates, { status: "all" }).length, 2);
});

test("filterEstimates: query matches the estimate title", () => {
  const estimates = [makeEstimate({ id: "a", title: "Roof Repair" }), makeEstimate({ id: "b", title: "AC Replacement" })];
  const result = filterEstimates(estimates, { query: "roof" });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "a");
});

test("filterEstimates: query matches contact full name, split across first/last", () => {
  const estimates = [
    makeEstimate({ id: "a", contact: { id: "c1", first_name: "Jane", last_name: "Doe", company_name: null, phone: null, email: null } }),
    makeEstimate({ id: "b", contact: { id: "c2", first_name: "John", last_name: "Smith", company_name: null, phone: null, email: null } }),
  ];
  const result = filterEstimates(estimates, { query: "jane doe" });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "a");
});

test("filterEstimates: query matches company name", () => {
  const estimates = [makeEstimate({ id: "a", contact: { id: "c1", first_name: "Jane", last_name: "Doe", company_name: "Acme Roofing", phone: null, email: null } })];
  assert.equal(filterEstimates(estimates, { query: "acme" }).length, 1);
});

test("filterEstimates: estimate with no contact never throws and is excluded by a name search", () => {
  const estimates = [makeEstimate({ id: "a", contact: null })];
  assert.doesNotThrow(() => filterEstimates(estimates, { query: "jane" }));
  assert.equal(filterEstimates(estimates, { query: "jane" }).length, 0);
});

test("filterEstimates: query and status combine with AND semantics", () => {
  const estimates = [
    makeEstimate({ id: "a", status: "draft", title: "Roof Repair" }),
    makeEstimate({ id: "b", status: "sent", title: "Roof Repair" }),
  ];
  const result = filterEstimates(estimates, { query: "roof", status: "sent" });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "b");
});

test("summarizeEstimates: totals and per-status counts on an empty list", () => {
  const summary = summarizeEstimates([]);
  assert.deepEqual(summary, { total: 0, draftCount: 0, sentCount: 0, acceptedValue: 0 });
});

test("summarizeEstimates: counts drafts and sent separately from other statuses", () => {
  const estimates = [
    makeEstimate({ id: "a", status: "draft" }),
    makeEstimate({ id: "b", status: "draft" }),
    makeEstimate({ id: "c", status: "sent" }),
    makeEstimate({ id: "d", status: "cancelled" }),
  ];
  const summary = summarizeEstimates(estimates);
  assert.equal(summary.total, 4);
  assert.equal(summary.draftCount, 2);
  assert.equal(summary.sentCount, 1);
});

test("summarizeEstimates: acceptedValue sums only accepted estimates' amounts, treating null as zero", () => {
  const estimates = [
    makeEstimate({ id: "a", status: "accepted", amount: 1000 }),
    makeEstimate({ id: "b", status: "accepted", amount: null }),
    makeEstimate({ id: "c", status: "accepted", amount: 500 }),
    makeEstimate({ id: "d", status: "sent", amount: 9999 }),
  ];
  assert.equal(summarizeEstimates(estimates).acceptedValue, 1500);
});
