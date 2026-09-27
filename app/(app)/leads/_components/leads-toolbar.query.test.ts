/**
 * Regression coverage for the Active/Hot/Qualified Leads filter-persistence
 * bug: LeadsToolbar's debounced router.replace() rebuilt the URL from only
 * q/status/temperature/sort, silently dropping `from=lead` - the /customers
 * dispatcher's own page-identity marker (app/(app)/customers/page.tsx) -
 * about 300ms after any lead-derived view loaded, falling back to the
 * unfiltered ContactsPage. buildLeadsQueryString is the pure function
 * navigate() now delegates to; testing it directly needs no jsdom/RTL,
 * which this repo doesn't have set up for node:test.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/leads/_components/leads-toolbar.query.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLeadsQueryString } from "./leads-toolbar-query";

const BASE = { query: "", status: "all", temperature: "all", sort: "newest" as const };

test("1. from=lead alone survives a rebuild with no other filters set", () => {
  const qs = buildLeadsQueryString({ ...BASE, from: "lead" });
  assert.equal(qs, "from=lead");
});

test("2. from=lead + temperature both appear (Hot Leads)", () => {
  const qs = buildLeadsQueryString({ ...BASE, from: "lead", temperature: "hot" });
  const params = new URLSearchParams(qs);
  assert.equal(params.get("from"), "lead");
  assert.equal(params.get("temperature"), "hot");
});

test("3. from=lead + status both appear (Qualified Leads)", () => {
  const qs = buildLeadsQueryString({ ...BASE, from: "lead", status: "qualified" });
  const params = new URLSearchParams(qs);
  assert.equal(params.get("from"), "lead");
  assert.equal(params.get("status"), "qualified");
});

test("4. from=lead + q both appear (search stays within the lead-derived context)", () => {
  const qs = buildLeadsQueryString({ ...BASE, from: "lead", query: "marisol" });
  const params = new URLSearchParams(qs);
  assert.equal(params.get("from"), "lead");
  assert.equal(params.get("q"), "marisol");
});

test("5. from=lead + sort both appear", () => {
  const qs = buildLeadsQueryString({ ...BASE, from: "lead", sort: "hot_first" });
  const params = new URLSearchParams(qs);
  assert.equal(params.get("from"), "lead");
  assert.equal(params.get("sort"), "hot_first");
});

test("6. from=lead + every filter combined at once", () => {
  const qs = buildLeadsQueryString({ from: "lead", query: "marisol", status: "qualified", temperature: "hot", sort: "value_desc" });
  const params = new URLSearchParams(qs);
  assert.equal(params.get("from"), "lead");
  assert.equal(params.get("status"), "qualified");
  assert.equal(params.get("temperature"), "hot");
  assert.equal(params.get("q"), "marisol");
  assert.equal(params.get("sort"), "value_desc");
});

test("7. clearing filters drops q/status/temperature but from=lead is not a stale param left behind - it is the one param that must remain", () => {
  const qs = buildLeadsQueryString({ ...BASE, from: "lead" });
  const params = new URLSearchParams(qs);
  assert.equal(params.get("from"), "lead");
  assert.equal(params.has("q"), false);
  assert.equal(params.has("status"), false);
  assert.equal(params.has("temperature"), false);
});

test("8. no `from` (undefined) never adds the param - normal non-lead usage is unchanged", () => {
  const qs = buildLeadsQueryString({ ...BASE, temperature: "hot" });
  const params = new URLSearchParams(qs);
  assert.equal(params.has("from"), false);
  assert.equal(params.get("temperature"), "hot");
});

test("9. an empty-string `from` is treated the same as absent - never emits `from=`", () => {
  const qs = buildLeadsQueryString({ ...BASE, from: "" });
  const params = new URLSearchParams(qs);
  assert.equal(params.has("from"), false);
});

test("10. default state with from=lead and nothing else produces exactly `from=lead`, no stale defaults", () => {
  const qs = buildLeadsQueryString({ ...BASE, from: "lead" });
  assert.equal(qs, "from=lead");
});
