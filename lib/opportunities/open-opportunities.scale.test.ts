/**
 * Phase 3A-4: getOpenOpportunitiesResult - the open-opportunity read behind
 * the /opportunities summary and list, Today's attention queue, Contacts and
 * People, opportunity intelligence and Agency Expansion - against a fake
 * Supabase client that, like the real API, returns at most 1,000 rows to a
 * request that isn't paged and applies a query's .order() calls. Every open
 * opportunity must be returned at 999, exactly 1,000 and 2,500 rows (the
 * oldest - past row 1,000 in newest-first order - carry the values and
 * contacts a capped read dropped), newest first, in any source order; the
 * summary totals must be complete; a failed page or the row limit is
 * `failed` with no rows, and a genuinely empty result a real zero.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/opportunities/open-opportunities.scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { getOpenOpportunitiesResult, getOpenOpportunities, summarizeOpportunities }: typeof import("./queries") = require(path.join(ROOT, "lib/opportunities/queries.ts"));
const { MAX_ATTRIBUTION_ROWS }: typeof import("@/lib/bi/revenue-attribution") = require(path.join(ROOT, "lib/bi/revenue-attribution.ts"));

type Query = { table: string; calls: string[] };
type Row = Record<string, unknown>;
type Answer = { rows?: Row[]; error?: boolean; failOnPage?: number };

/** Applies the query's recorded .order(column, { ascending }) calls, as the database would. */
function ordered(rows: Row[], calls: string[]): Row[] {
  const keys = calls.filter((c) => c.startsWith("order ")).map((c) => {
    const [, column, options] = c.match(/^order (\S+)(?: (.*))?$/)!;
    return { column, ascending: options ? JSON.parse(options).ascending !== false : true };
  });
  if (keys.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of keys) {
      const x = String(a[column]);
      const y = String(b[column]);
      if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
    }
    return 0;
  });
}

/** The Phase 2F-3A fake client, plus .order() handling: a request that isn't paged gets at most 1,000 rows. */
function fakeSupabase(answer: (query: Query) => Answer = () => ({})) {
  const queries: Query[] = [];
  const supabase = {
    from(table: string) {
      const query: Query = { table, calls: [] };
      queries.push(query);
      const resolve = (from?: number, to?: number) => {
        const result = answer(query);
        const page = from === undefined ? 1 : from / 1000 + 1;
        if (result.error || result.failOnPage === page) return Promise.resolve({ data: null, error: { message: "boom" }, count: null });
        const rows = ordered(result.rows ?? [], query.calls);
        return Promise.resolve({ data: from === undefined ? rows.slice(0, 1000) : rows.slice(from, to! + 1), error: null, count: rows.length });
      };
      const builder: object = new Proxy(
        {},
        {
          get(_target, prop: string) {
            if (prop === "then") return (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => resolve().then(onFulfilled, onRejected);
            if (prop === "range") return (from: number, to: number) => (query.calls.push(`range ${from} ${to}`), resolve(from, to));
            return (...args: unknown[]) => (query.calls.push(`${prop} ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`), builder);
          },
        },
      );
      return builder;
    },
  } as unknown as SupabaseClient;
  return { supabase, queries };
}

const isOpportunities = (q: Query) => q.table === "opportunities";
const pagesOf = (queries: Query[]) => queries.filter(isOpportunities).flatMap((q) => q.calls.filter((c) => c.startsWith("range")));
const EXPECTED_PAGES: Record<number, string[]> = {
  999: ["range 0 999"],
  1000: ["range 0 999", "range 1000 1999"],
  2500: ["range 0 999", "range 1000 1999", "range 2000 2999"],
};
const SIZES = [999, 1000, 2500];
const pad = (i: number) => String(i).padStart(6, "0");

/** Deterministic shuffle (a fixed-seed LCG) - same input, same output, every run. */
function shuffled<T>(rows: T[]): T[] {
  const out = [...rows];
  let seed = 31;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * n open opportunities, newest first by index: row i is i minutes older than
 * row 0. The newest 1,000 are stale estimates with no value and no contact;
 * every older one (past row 1,000 newest first) is a valued dormant-customer
 * or invoice-overdue opportunity with a contact - all of it invisible to a
 * capped read.
 */
const opportunities = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const old = i >= 1000;
    return {
      id: `opp-${pad(i)}`,
      type: old ? (i % 2 === 0 ? "dormant_customer" : "invoice_overdue") : "stale_estimate",
      status: "open",
      source_entity_type: old ? "contact" : "estimate",
      source_entity_id: `src-${pad(i)}`,
      contact_id: old ? `contact-${i % 50}` : null,
      title: "t",
      description: null,
      estimated_value: old ? 100 : null,
      value_basis: old ? "jobs.amount" : null,
      created_at: new Date(Date.UTC(2026, 8, 1) - i * 60_000).toISOString(),
      updated_at: new Date(Date.UTC(2026, 8, 1) - i * 60_000).toISOString(),
      resolved_at: null,
      resolution_reason: null,
      metadata: {},
    };
  });

test("getOpenOpportunitiesResult: every open opportunity at 999, exactly 1,000 and 2,500 rows, newest first, in any source order - the oldest (past row 1,000) included", async () => {
  for (const n of SIZES) {
    for (const rows of [opportunities(n), shuffled(opportunities(n))]) {
      const { supabase, queries } = fakeSupabase((q) => (isOpportunities(q) ? { rows } : {}));
      const result = await getOpenOpportunitiesResult(supabase, "org-1");
      assert.equal(result.failed, false, `${n}`);
      assert.deepEqual(pagesOf(queries), EXPECTED_PAGES[n], `${n} pages`);
      assert.equal(result.data.length, n);
      assert.deepEqual(result.data.map((o) => o.id), opportunities(n).map((o) => o.id), `${n}: newest first`);
      assert.ok(queries.filter(isOpportunities).every((q) => q.calls.includes("eq organization_id org-1") && q.calls.includes("eq status open")), "organization-scoped, open only");
    }
  }
});

test("summary totals are complete: per-class value, unknown-value and per-type counts include every opportunity past row 1,000", async () => {
  for (const n of SIZES) {
    const { supabase } = fakeSupabase((q) => (isOpportunities(q) ? { rows: shuffled(opportunities(n)) } : {}));
    const summary = summarizeOpportunities((await getOpenOpportunitiesResult(supabase, "org-1")).data);
    const old = Math.max(0, n - 1000);
    // Phase 2-13: invoice_overdue is committed money, stale_estimate potential, dormant_customer non-monetary.
    assert.deepEqual(
      [summary.count, summary.committed, summary.potential, summary.nonMonetaryCount],
      [n, { value: Math.floor(old / 2) * 100, count: Math.floor(old / 2), unknownValueCount: 0 }, { value: 0, count: Math.min(n, 1000), unknownValueCount: Math.min(n, 1000) }, Math.ceil(old / 2)],
      `${n}`,
    );
    assert.deepEqual([summary.byType.stale_estimate, summary.byType.dormant_customer, summary.byType.invoice_overdue], [Math.min(n, 1000), Math.ceil(old / 2), Math.floor(old / 2)], `${n}`);
  }
});

test("per-contact views see an old opportunity: getOpenOpportunities returns opportunities past row 1,000 for their contact", async () => {
  const { supabase } = fakeSupabase((q) => (isOpportunities(q) ? { rows: opportunities(2500) } : {}));
  const all = await getOpenOpportunities(supabase, "org-1");
  const forContact = all.filter((o) => o.contactId === "contact-7");
  assert.equal(forContact.length, 30, "every opportunity for this contact sits past row 1,000");
  assert.ok(forContact.every((o) => o.type === "invoice_overdue" && o.estimatedValue === 100));
});

test("a page-1 error, a page-2 error or the row limit is failed with no rows; a genuinely empty result is a real zero", async () => {
  for (const failure of [{ error: true, rows: opportunities(2500) }, { failOnPage: 2, rows: opportunities(2500) }, { rows: opportunities(MAX_ATTRIBUTION_ROWS + 1) }]) {
    const result = await getOpenOpportunitiesResult(fakeSupabase((q) => (isOpportunities(q) ? failure : {})).supabase, "org-1");
    assert.deepEqual(result, { data: [], failed: true });
  }
  assert.deepEqual(await getOpenOpportunitiesResult(fakeSupabase().supabase, "org-1"), { data: [], failed: false });
  assert.deepEqual(await getOpenOpportunities(fakeSupabase((q) => (isOpportunities(q) ? { failOnPage: 2, rows: opportunities(2500) } : {})).supabase, "org-1"), [], "the failure-swallowing wrapper never returns a partial list");
});

test("guard: the open-opportunities read is paged newest first with an id tie-break and no capped read", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib/opportunities/queries.ts"), "utf8");
  // Phase 2-4: the read is wrapped in React.cache, so its body ends at "\n});\n".
  const start = source.indexOf("export const getOpenOpportunitiesResult = cache(async (");
  assert.ok(start !== -1, "getOpenOpportunitiesResult declaration not found");
  const body = source.slice(start, source.indexOf("\n});\n", start));
  assert.match(body, /readAllPages<OpportunityRow>/);
  assert.match(body, /\.order\("created_at", \{ ascending: false \}\)\.order\("id"\)/);
  assert.doesNotMatch(body, /\.limit\(/);
});
