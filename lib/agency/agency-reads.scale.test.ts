/**
 * Phase 3A-3a: the Agency aggregate loaders - loadRevenueEvents (through
 * getAgencyRevenue), loadMissedCallCounts and loadAiTokenBreakdown - against
 * a fake Supabase client that, like the real API, returns at most 1,000 rows
 * to a request that isn't paged and applies a query's .order() calls. Every
 * read must be complete at 999, exactly 1,000 and 2,500 rows across two
 * client organizations (meaningful rows placed after row 1,000), in any
 * source order; a failed page or the row limit must be a failure with no
 * partial rows, and a genuinely empty result a real zero. Agency Revenue's
 * recent events stay the 100 newest, newest first, after paging. The cost
 * loaders (Phase 3A-3b) and intentionally bounded lists are not covered.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/agency-reads.scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { getAgencyRevenue, loadRevenueEvents }: typeof import("./revenue") = require(path.join(ROOT, "lib/agency/revenue.ts"));
const { loadMissedCallCounts }: typeof import("./usage") = require(path.join(ROOT, "lib/agency/usage.ts"));
const { loadAiTokenBreakdown }: typeof import("./cost-readiness") = require(path.join(ROOT, "lib/agency/cost-readiness.ts"));
const { MAX_ATTRIBUTION_ROWS }: typeof import("@/lib/bi/revenue-attribution") = require(path.join(ROOT, "lib/bi/revenue-attribution.ts"));

type Query = { table: string; calls: string[] };
type Answer = { rows?: Record<string, unknown>[]; error?: boolean; failOnPage?: number };

/** Applies the query's recorded .order(column, { ascending }) calls, as the database would. */
function ordered(rows: Record<string, unknown>[], calls: string[]): Record<string, unknown>[] {
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
    auth: { getUser: async () => ({ data: { user: { id: "agency-admin" } }, error: null }) },
    rpc: async (name: string) => ({ data: name === "is_agency_admin" ? true : null, error: null }),
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
            if (prop === "single" || prop === "maybeSingle") return () => resolve().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }));
            return (...args: unknown[]) => (query.calls.push(`${prop} ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`), builder);
          },
        },
      );
      return builder;
    },
  } as unknown as SupabaseClient;
  return { supabase, queries };
}

const isRevenue = (q: Query) => q.table === "revenue_events";
const isMissedCalls = (q: Query) => q.table === "automation_events" && q.calls.includes("eq event_type call.missed");
const isTokens = (q: Query) => q.table === "ai_interactions" && q.calls.includes("select organization_id, output");
const pagesOf = (queries: Query[], match: (q: Query) => boolean) => queries.filter(match).flatMap((q) => q.calls.filter((c) => c.startsWith("range")));
const EXPECTED_PAGES: Record<number, string[]> = {
  999: ["range 0 999"],
  1000: ["range 0 999", "range 1000 1999"],
  2500: ["range 0 999", "range 1000 1999", "range 2000 2999"],
};
const SIZES = [999, 1000, 2500];
const ORGS = ["org-a", "org-b"];
const ALL_TIME = { label: "all time", from: null, to: null };

/** Deterministic shuffle (a fixed-seed LCG) - same input, same output, every run. */
function shuffled<T>(rows: T[]): T[] {
  const out = [...rows];
  let seed = 11;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const pad = (i: number) => String(i).padStart(6, "0");

/**
 * Revenue events: ids and occurred_at both increase with i, so the newest
 * events are the ones past row 1,000. The first 1,000 are small org-a
 * payments; past 1,000 they alternate orgs and mix refunds and failures.
 */
const revenueEvents = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `ev-${pad(i)}`,
    organization_id: i < 1000 ? "org-a" : ORGS[i % 2],
    event_type: i < 1000 ? "payment_succeeded" : (["payment_succeeded", "refund", "payment_failed"] as const)[i % 3],
    revenue_category: i % 2 === 0 ? "setup" : "recurring",
    amount: i < 1000 ? 100 : 1000,
    currency: "usd",
    occurred_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
  }));
const missedCalls = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `mc-${pad(i)}`, organization_id: i < 1000 ? "org-a" : "org-b" }));
const tokenRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `ai-${pad(i)}`, organization_id: i < 1000 ? "org-a" : "org-b", output: { usage: { input_tokens: 10, output_tokens: i < 1000 ? 1 : 5 } } }));
const AGENCY_ORGS = ORGS.map((id, i) => ({ organization_id: id, created_at: `2026-01-0${i + 1}T00:00:00Z`, organizations: { name: id } }));

// ---------------------------------------------------------------------------
// Agency Revenue: complete totals, newest-first recent events
// ---------------------------------------------------------------------------

test("Agency Revenue: complete totals at 999, exactly 1,000 and 2,500 events (refunds and org-b only past row 1,000), in any order; recent events are the 100 newest, newest first", async () => {
  for (const n of SIZES) {
    for (const rows of [revenueEvents(n), shuffled(revenueEvents(n))]) {
      const { supabase, queries } = fakeSupabase((q) => (q.table === "agency_organizations" ? { rows: AGENCY_ORGS } : isRevenue(q) ? { rows } : {}));
      const result = await getAgencyRevenue(supabase, supabase, "allTime");
      assert.ok(result.ok);
      assert.equal(result.partialData, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isRevenue), EXPECTED_PAGES[n], `${n} pages`);
      const sum = (match: (r: (typeof rows)[number]) => boolean) => rows.filter(match).reduce((s, r) => s + r.amount, 0);
      assert.deepEqual(result.totals.collected, [{ currency: "usd", amount: sum((r) => r.event_type === "payment_succeeded") }]);
      const refunded = sum((r) => r.event_type === "refund");
      assert.deepEqual(result.totals.refunded, refunded ? [{ currency: "usd", amount: refunded }] : []);
      assert.deepEqual(result.clients.map((c) => c.eventCount), ORGS.map((o) => rows.filter((r) => r.organization_id === o).length));
      const newest = [...rows].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1)).slice(0, 100).map((r) => r.id);
      assert.deepEqual(result.recentEvents.map((e) => e.id), newest, `${n}: the 100 newest, newest first`);
    }
  }
});

test("Agency Revenue: events sharing an occurred_at are tie-broken by id, so pages stay stable", async () => {
  const sameTime = Array.from({ length: 1500 }, (_, i) => ({ ...revenueEvents(1)[0], id: `ev-${pad(i)}`, occurred_at: "2026-05-01T00:00:00.000Z" }));
  const { supabase, queries } = fakeSupabase((q) => (isRevenue(q) ? { rows: shuffled(sameTime) } : {}));
  const { rows, failed } = await loadRevenueEvents(supabase, ORGS, ALL_TIME);
  assert.equal(failed, false);
  assert.deepEqual(rows.map((r) => r.id), sameTime.map((r) => r.id));
  assert.ok(queries.filter(isRevenue).every((q) => q.calls.includes('order occurred_at {"ascending":false}') && q.calls.includes("order id")));
});

// ---------------------------------------------------------------------------
// Missed calls and AI token breakdown
// ---------------------------------------------------------------------------

test("loadMissedCallCounts: exact per-organization counts at 999, exactly 1,000 and 2,500 rows (org-b only past row 1,000), in any order, paged by id", async () => {
  for (const n of SIZES) {
    for (const rows of [missedCalls(n), shuffled(missedCalls(n))]) {
      const { supabase, queries } = fakeSupabase((q) => (isMissedCalls(q) ? { rows } : {}));
      const { byOrganization, failed } = await loadMissedCallCounts(supabase, ORGS, ALL_TIME);
      assert.equal(failed, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isMissedCalls), EXPECTED_PAGES[n], `${n} pages`);
      assert.deepEqual([byOrganization.get("org-a") ?? 0, byOrganization.get("org-b") ?? 0], [Math.min(n, 1000), Math.max(0, n - 1000)]);
    }
  }
});

test("loadAiTokenBreakdown: exact per-organization input/output tokens at 999, exactly 1,000 and 2,500 rows (org-b only past row 1,000), in any order, paged by id", async () => {
  for (const n of SIZES) {
    for (const rows of [tokenRows(n), shuffled(tokenRows(n))]) {
      const { supabase, queries } = fakeSupabase((q) => (isTokens(q) ? { rows } : {}));
      const { byOrganization, failed } = await loadAiTokenBreakdown(supabase, ORGS, ALL_TIME);
      assert.equal(failed, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isTokens), EXPECTED_PAGES[n], `${n} pages`);
      const a = Math.min(n, 1000);
      const b = Math.max(0, n - 1000);
      assert.deepEqual(byOrganization.get("org-a"), { inputTokens: a * 10, outputTokens: a });
      assert.deepEqual(byOrganization.get("org-b"), b ? { inputTokens: b * 10, outputTokens: b * 5 } : { inputTokens: null, outputTokens: null });
    }
  }
});

// ---------------------------------------------------------------------------
// Failure vs genuine empty
// ---------------------------------------------------------------------------

test("a page-1 error, a page-2 error or the row limit is failed with no partial rows used; a genuinely empty result is a real zero", async () => {
  const runs: [string, (s: SupabaseClient) => Promise<{ failed: boolean; total: number }>, (q: Query) => boolean, (n: number) => Record<string, unknown>[]][] = [
    ["revenue events", async (s) => { const r = await loadRevenueEvents(s, ORGS, ALL_TIME); return { failed: r.failed, total: r.rows.length }; }, isRevenue, revenueEvents],
    ["missed calls", async (s) => { const r = await loadMissedCallCounts(s, ORGS, ALL_TIME); return { failed: r.failed, total: [...r.byOrganization.values()].reduce((x, y) => x + y, 0) }; }, isMissedCalls, missedCalls],
    ["AI tokens", async (s) => { const r = await loadAiTokenBreakdown(s, ORGS, ALL_TIME); return { failed: r.failed, total: [...r.byOrganization.values()].reduce((x, u) => x + (u.inputTokens ?? 0) + (u.outputTokens ?? 0), 0) }; }, isTokens, tokenRows],
  ];
  for (const [name, run, match, build] of runs) {
    for (const failure of [{ error: true, rows: build(2500) }, { failOnPage: 2, rows: build(2500) }, { rows: build(MAX_ATTRIBUTION_ROWS + 1) }]) {
      const result = await run(fakeSupabase((q) => (match(q) ? failure : {})).supabase);
      assert.deepEqual(result, { failed: true, total: 0 }, `${name}: failed with no partial rows`);
    }
    assert.deepEqual(await run(fakeSupabase().supabase), { failed: false, total: 0 }, `${name}: genuine empty`);
  }
});

test("Agency Revenue: a failed revenue read is disclosed through the existing partialData and shows no partial totals", async () => {
  const { supabase } = fakeSupabase((q) => (q.table === "agency_organizations" ? { rows: AGENCY_ORGS } : isRevenue(q) ? { rows: revenueEvents(2500), failOnPage: 2 } : {}));
  const result = await getAgencyRevenue(supabase, supabase, "allTime");
  assert.ok(result.ok);
  assert.deepEqual([result.partialData, result.totals.collected, result.recentEvents.length], [true, [], 0]);
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("guards: the three loaders page with a stable order and no capped read; the intentionally bounded stuck-execution list keeps its limit", () => {
  const body = (file: string, fn: string) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const start = source.indexOf(`async function ${fn}(`);
    assert.ok(start >= 0, fn);
    return source.slice(start, source.indexOf("\n}\n", start));
  };
  for (const [file, fn] of [["lib/agency/revenue.ts", "loadRevenueEvents"], ["lib/agency/usage.ts", "loadMissedCallCounts"], ["lib/agency/cost-readiness.ts", "loadAiTokenBreakdown"]]) {
    const code = body(file, fn);
    assert.match(code, /readAllPages</, fn);
    assert.match(code, /\.order\("id"\)/, fn);
    assert.doesNotMatch(code, /\.limit\(/, fn);
  }
  assert.match(body("lib/agency/revenue.ts", "loadRevenueEvents"), /\.order\("occurred_at", \{ ascending: false \}\)\.order\("id"\)/);
  assert.match(fs.readFileSync(path.join(ROOT, "lib/agency/health.ts"), "utf8"), /\.limit\(MAX_STUCK_ROWS\)/, "the stuck-execution list stays a bounded list");
});
