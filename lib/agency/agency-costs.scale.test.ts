/**
 * Phase 3A-3b: the Agency cost loaders - loadCostEvents, loadInteractions,
 * loadSmsCostEvents and loadMessagesForCost, through getAgencyAiCosts and
 * getAgencySmsCosts - against a fake Supabase client that, like the real API,
 * returns at most 1,000 rows to a request that isn't paged and applies a
 * query's .order() calls. Every read must be complete at 999, exactly 1,000
 * and 2,500 rows across two client organizations, in any source order, with
 * known / unpriced / unknown classification exact at scale. Known-cost
 * membership comes from the embedded cost-event link (the unique
 * source_interaction_id / source_message_id foreign keys), never a separate
 * .in(source_*_id, ids) lookup; a failed page or the row limit is a failure
 * with no partial rows, disclosed through the existing partialData; a
 * genuinely empty result is a real zero.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/agency-costs.scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { getAgencyAiCosts, getAgencySmsCosts, loadCostEvents, loadInteractions, loadSmsCostEvents, loadMessagesForCost }: typeof import("./costs") = require(path.join(ROOT, "lib/agency/costs.ts"));
const { MAX_ATTRIBUTION_ROWS }: typeof import("@/lib/bi/revenue-attribution") = require(path.join(ROOT, "lib/bi/revenue-attribution.ts"));

type Query = { table: string; calls: string[] };
type Row = Record<string, unknown>;
type Answer = { rows?: Row[]; error?: boolean; failOnPage?: number };

/** Applies the query's recorded .order(column) calls, as the database would. */
function ordered(rows: Row[], calls: string[]): Row[] {
  const columns = calls.filter((c) => c.startsWith("order ")).map((c) => c.split(" ")[1]);
  if (columns.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const column of columns) {
      const x = String(a[column]);
      const y = String(b[column]);
      if (x !== y) return x < y ? -1 : 1;
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

const AI_INTERACTIONS_SELECT = "select id, organization_id, interaction_type, output, ai_cost_events(source_interaction_id)";
const MESSAGES_SELECT = "select id, organization_id, sms_cost_events(source_message_id)";
const isAiCostEvents = (q: Query) => q.table === "ai_cost_events";
const isInteractions = (q: Query) => q.table === "ai_interactions";
const isSmsCostEvents = (q: Query) => q.table === "sms_cost_events";
const isMessages = (q: Query) => q.table === "messages";
const pagesOf = (queries: Query[], match: (q: Query) => boolean) => queries.filter(match).flatMap((q) => q.calls.filter((c) => c.startsWith("range")));
const EXPECTED_PAGES: Record<number, string[]> = {
  999: ["range 0 999"],
  1000: ["range 0 999", "range 1000 1999"],
  2500: ["range 0 999", "range 1000 1999", "range 2000 2999"],
};
const SIZES = [999, 1000, 2500];
const ORGS = ["org-a", "org-b"];
const ALL_TIME = { label: "all time", from: null, to: null };
const AGENCY_ORGS = ORGS.map((id, i) => ({ organization_id: id, created_at: `2026-01-0${i + 1}T00:00:00Z`, organizations: { name: id } }));
const pad = (i: number) => String(i).padStart(6, "0");

/** Deterministic shuffle (a fixed-seed LCG) - same input, same output, every run. */
function shuffled<T>(rows: T[]): T[] {
  const out = [...rows];
  let seed = 23;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Rows: the first 1,000 belong to org-a and are known (an embedded cost-event
// link, in the object shape); past row 1,000 they belong to org-b and cycle
// known (array shape) / unpriced / unknown - every unresolved row sits where a
// capped read never looked.
const costEvent = (i: number) => ({ id: `ce-${pad(i)}`, organization_id: i < 1000 ? "org-a" : "org-b", currency: "usd", total_cost: 2, price: 2 });
const costEvents = (n: number) => Array.from({ length: n }, (_, i) => costEvent(i));
type Kind = "known" | "unpriced" | "unknown";
const kindOf = (i: number): Kind => (i < 1000 ? "known" : (["known", "unpriced", "unknown"] as const)[i % 3]);
const interactions = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const kind = kindOf(i);
    return {
      id: `ai-${pad(i)}`,
      organization_id: i < 1000 ? "org-a" : "org-b",
      interaction_type: kind === "unknown" ? "lead_followup" : "business_insights",
      output: { usage: { input_tokens: 10, output_tokens: 5 } },
      ai_cost_events: kind !== "known" ? (i % 2 ? null : []) : i < 1000 ? { source_interaction_id: `ai-${pad(i)}` } : [{ source_interaction_id: `ai-${pad(i)}` }],
    };
  });
const messages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `msg-${pad(i)}`,
    organization_id: i < 1000 ? "org-a" : "org-b",
    sms_cost_events: i < 1000 ? { source_message_id: `msg-${pad(i)}` } : i % 2 === 0 ? [{ source_message_id: `msg-${pad(i)}` }] : i % 4 === 1 ? null : [],
  }));
const perOrg = <T extends { organization_id: unknown }>(rows: T[], match: (r: T) => boolean) => ORGS.map((o) => rows.filter((r) => r.organization_id === o && match(r)).length);

// ---------------------------------------------------------------------------
// AI cost: complete known cost and exact classification at scale
// ---------------------------------------------------------------------------

test("getAgencyAiCosts: complete known cost and exact known/unpriced/unknown counts at 999, exactly 1,000 and 2,500 rows, in any order, with known-cost membership from the embedded link", async () => {
  for (const n of SIZES) {
    for (const order of [<T,>(r: T[]) => r, shuffled]) {
      const events = order(costEvents(n));
      const rows = order(interactions(n));
      const { supabase, queries } = fakeSupabase((q) => (q.table === "agency_organizations" ? { rows: AGENCY_ORGS } : isAiCostEvents(q) ? { rows: events } : isInteractions(q) ? { rows } : {}));
      const result = await getAgencyAiCosts(supabase, supabase, "allTime");
      assert.ok(result.ok);
      assert.equal(result.partialData, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isAiCostEvents), EXPECTED_PAGES[n], `${n} cost-event pages`);
      assert.deepEqual(pagesOf(queries, isInteractions), EXPECTED_PAGES[n], `${n} interaction pages`);
      assert.deepEqual(result.totals.knownCost, [{ currency: "usd", amount: n * 2 }]);
      const unpriced = rows.filter((r) => kindOf(Number(r.id.slice(3))) === "unpriced");
      const unknown = rows.filter((r) => kindOf(Number(r.id.slice(3))) === "unknown");
      assert.deepEqual([result.totals.knownInteractionCount, result.totals.unpricedInteractionCount, result.totals.unknownInteractionCount], [n, unpriced.length, unknown.length]);
      assert.deepEqual(result.clients.map((c) => [c.knownInteractionCount, c.unpricedInteractionCount, c.unknownInteractionCount]), ORGS.map((o, i) => [perOrg(events, () => true)[i], perOrg(unpriced, () => true)[i], perOrg(unknown, () => true)[i]]));
      assert.ok(queries.filter(isInteractions).every((q) => q.calls.includes(AI_INTERACTIONS_SELECT)), "the known-cost link is embedded");
      assert.equal(queries.filter(isAiCostEvents).length, pagesOf(queries, isAiCostEvents).length, "no separate ai_cost_events lookup beyond the paged cost read");
      assert.ok(!queries.some((q) => q.calls.some((c) => c.startsWith("in source_interaction_id"))), "no .in(source_interaction_id, ids)");
    }
  }
});

// ---------------------------------------------------------------------------
// SMS cost: complete known cost and exact unknown counts at scale
// ---------------------------------------------------------------------------

test("getAgencySmsCosts: complete known cost and exact known/unknown counts at 999, exactly 1,000 and 2,500 rows, in any order, with known-cost membership from the embedded link", async () => {
  for (const n of SIZES) {
    for (const order of [<T,>(r: T[]) => r, shuffled]) {
      const events = order(costEvents(n));
      const rows = order(messages(n));
      const { supabase, queries } = fakeSupabase((q) => (q.table === "agency_organizations" ? { rows: AGENCY_ORGS } : isSmsCostEvents(q) ? { rows: events } : isMessages(q) ? { rows } : {}));
      const result = await getAgencySmsCosts(supabase, supabase, "allTime");
      assert.ok(result.ok);
      assert.equal(result.partialData, false, `${n}`);
      assert.deepEqual(pagesOf(queries, isSmsCostEvents), EXPECTED_PAGES[n], `${n} cost-event pages`);
      assert.deepEqual(pagesOf(queries, isMessages), EXPECTED_PAGES[n], `${n} message pages`);
      assert.deepEqual(result.totals.knownCost, [{ currency: "usd", amount: n * 2 }]);
      const unknown = rows.filter((r) => r.sms_cost_events == null || (Array.isArray(r.sms_cost_events) && r.sms_cost_events.length === 0));
      assert.deepEqual([result.totals.knownMessageCount, result.totals.unknownMessageCount], [n, unknown.length]);
      assert.deepEqual(result.clients.map((c) => [c.knownMessageCount, c.unknownMessageCount]), ORGS.map((_, i) => [perOrg(events, () => true)[i], perOrg(unknown, () => true)[i]]));
      assert.ok(queries.filter(isMessages).every((q) => q.calls.includes(MESSAGES_SELECT)), "the known-cost link is embedded");
      assert.equal(queries.filter(isSmsCostEvents).length, pagesOf(queries, isSmsCostEvents).length, "no separate sms_cost_events lookup beyond the paged cost read");
      assert.ok(!queries.some((q) => q.calls.some((c) => c.startsWith("in source_message_id"))), "no .in(source_message_id, ids)");
    }
  }
});

// ---------------------------------------------------------------------------
// Failure vs genuine empty
// ---------------------------------------------------------------------------

test("each loader: a page-1 error, a page-2 error or the row limit is failed with no partial rows; a genuinely empty result is a real zero", async () => {
  const loaders: [string, (s: SupabaseClient) => Promise<{ rows: unknown[]; failed: boolean }>, (q: Query) => boolean, (n: number) => Row[]][] = [
    ["loadCostEvents", (s) => loadCostEvents(s, ORGS, ALL_TIME), isAiCostEvents, costEvents],
    ["loadInteractions", (s) => loadInteractions(s, ORGS, ALL_TIME), isInteractions, interactions],
    ["loadSmsCostEvents", (s) => loadSmsCostEvents(s, ORGS, ALL_TIME), isSmsCostEvents, costEvents],
    ["loadMessagesForCost", (s) => loadMessagesForCost(s, ORGS, ALL_TIME), isMessages, messages],
  ];
  for (const [name, load, match, build] of loaders) {
    for (const failure of [{ error: true, rows: build(2500) }, { failOnPage: 2, rows: build(2500) }, { rows: build(MAX_ATTRIBUTION_ROWS + 1) }]) {
      assert.deepEqual(await load(fakeSupabase((q) => (match(q) ? failure : {})).supabase), { rows: [], failed: true }, name);
    }
    assert.deepEqual(await load(fakeSupabase().supabase), { rows: [], failed: false }, `${name}: genuine empty`);
  }
});

test("partialData: a failed cost-event or interaction/message read is disclosed, with no partial counts; a genuinely empty agency is clean", async () => {
  const base = (q: Query): Answer => (q.table === "agency_organizations" ? { rows: AGENCY_ORGS } : isAiCostEvents(q) || isSmsCostEvents(q) ? { rows: costEvents(2500) } : isInteractions(q) ? { rows: interactions(2500) } : isMessages(q) ? { rows: messages(2500) } : {});

  const interactionsFail = await getAgencyAiCosts(fakeSupabase((q) => (isInteractions(q) ? { ...base(q), failOnPage: 2 } : base(q))).supabase, fakeSupabase((q) => (isInteractions(q) ? { ...base(q), failOnPage: 2 } : base(q))).supabase, "allTime");
  assert.ok(interactionsFail.ok);
  assert.deepEqual([interactionsFail.partialData, interactionsFail.totals.unpricedInteractionCount, interactionsFail.totals.unknownInteractionCount, interactionsFail.totals.knownInteractionCount], [true, 0, 0, 2500]);

  const aiCostFail = fakeSupabase((q) => (isAiCostEvents(q) ? { ...base(q), error: true } : base(q))).supabase;
  const aiCost = await getAgencyAiCosts(aiCostFail, aiCostFail, "allTime");
  assert.ok(aiCost.ok);
  assert.deepEqual([aiCost.partialData, aiCost.totals.knownCost, aiCost.totals.knownInteractionCount], [true, [], 0]);

  const messagesFail = fakeSupabase((q) => (isMessages(q) ? { ...base(q), rows: messages(MAX_ATTRIBUTION_ROWS + 1) } : base(q))).supabase;
  const sms = await getAgencySmsCosts(messagesFail, messagesFail, "allTime");
  assert.ok(sms.ok);
  assert.deepEqual([sms.partialData, sms.totals.unknownMessageCount, sms.totals.knownMessageCount], [true, 0, 2500]);

  const smsCostFail = fakeSupabase((q) => (isSmsCostEvents(q) ? { ...base(q), failOnPage: 2 } : base(q))).supabase;
  const smsCost = await getAgencySmsCosts(smsCostFail, smsCostFail, "allTime");
  assert.ok(smsCost.ok);
  assert.deepEqual([smsCost.partialData, smsCost.totals.knownCost], [true, []]);

  const empty = fakeSupabase((q) => (q.table === "agency_organizations" ? { rows: AGENCY_ORGS } : {})).supabase;
  const emptyAi = await getAgencyAiCosts(empty, empty, "allTime");
  const emptySms = await getAgencySmsCosts(empty, empty, "allTime");
  assert.ok(emptyAi.ok && emptySms.ok);
  assert.deepEqual([emptyAi.partialData, emptyAi.totals.knownInteractionCount, emptyAi.totals.unknownInteractionCount, emptySms.partialData, emptySms.totals.unknownMessageCount], [false, 0, 0, false, 0]);
  assert.ok(emptyAi.clients.every((c) => c.dataQuality === "known") && emptySms.clients.every((c) => c.dataQuality === "known"), "a genuinely empty client is confirmed known, never unknown");
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("guards: the four cost loaders page with a stable id order and no capped read; no source-id .in() lookup remains; the bounded stuck-execution list keeps its limit", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib/agency/costs.ts"), "utf8");
  const body = (fn: string) => {
    const start = source.indexOf(`async function ${fn}(`);
    assert.ok(start >= 0, fn);
    return source.slice(start, source.indexOf("\n}\n", start));
  };
  for (const fn of ["loadCostEvents", "loadInteractions", "loadSmsCostEvents", "loadMessagesForCost"]) {
    const code = body(fn);
    assert.match(code, /readAllPages</, fn);
    assert.match(code, /\.order\("id"\)/, fn);
    assert.doesNotMatch(code, /\.limit\(/, fn);
  }
  assert.match(body("loadInteractions"), /ai_cost_events\(source_interaction_id\)/);
  assert.match(body("loadMessagesForCost"), /sms_cost_events\(source_message_id\)/);
  assert.doesNotMatch(source, /\.in\("source_(interaction|message)_id"/, "no unbounded source-id lookup");
  assert.match(fs.readFileSync(path.join(ROOT, "lib/agency/health.ts"), "utf8"), /\.limit\(MAX_STUCK_ROWS\)/, "the stuck-execution list stays a bounded list");
});
