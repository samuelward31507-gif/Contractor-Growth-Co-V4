/**
 * Trackpr 2.0, Phase 2B: unit tests for DashboardData.partialData, against a
 * hand-built mocked Supabase client - no real database, no production
 * fixtures. Mirrors this codebase's own established mocked-client pattern
 * (see lib/automation/executions.test.ts) rather than inventing a new test
 * approach or testing framework.
 *
 * These tests exercise the real getDashboardData() query path - the mock
 * only replaces what a real PostgREST response would be at the wire
 * boundary (`{ data, error }`), never the function's own logic. This proves
 * the exact contract the Phase 2B audit required: a genuinely empty,
 * successful read (`{ data: [], error: null }`) must never set
 * partialData, while a real error (`{ data: null, error: {...} }`) on one of
 * getDashboardData's own 5 direct reads must.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/dashboard/queries.partial-data.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { getDashboardData }: typeof import("./queries") = require("./queries.ts");

type MockResult = { data: unknown; error: { message: string; code?: string } | null };

/**
 * One default per table getDashboardData (directly, or via
 * getCalendarConnection/getConversations/getLastMessagesByConversation/
 * getOpenOpportunities) reads from - a genuinely empty, successful response,
 * matching each table's own real shape (calendar_connections is the one
 * `.maybeSingle()` read, so its "no row" default is `null`, not `[]`).
 */
const DEFAULT_RESULTS: Record<string, MockResult> = {
  leads: { data: [], error: null },
  appointments: { data: [], error: null },
  estimates: { data: [], error: null },
  audit_log: { data: [], error: null },
  automation_incidents: { data: [], error: null },
  calendar_connections: { data: null, error: null },
  conversations: { data: [], error: null },
  messages: { data: [], error: null },
  opportunities: { data: [], error: null },
};

/**
 * A minimal, generic chainable query-builder stub - every filter/sort method
 * returns the same builder so any real call sequence (select/eq/in/not/
 * order/limit/maybeSingle, in any combination) works without needing a
 * table-specific chain, and the two real terminal calls this codebase's
 * dashboard reads ever use (`.limit()`, `.maybeSingle()`) resolve directly
 * to the configured `{ data, error }` result - exactly what a real
 * Supabase/PostgREST response looks like at the boundary these tests target.
 */
function makeQueryBuilder(result: MockResult) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    not: () => builder,
    order: () => builder,
    limit: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
  };
  return builder;
}

function makeMockSupabase(overrides: Partial<Record<string, MockResult>> = {}): SupabaseClient {
  const results: Partial<Record<string, MockResult>> = { ...DEFAULT_RESULTS, ...overrides };
  return {
    from: (table: string) => makeQueryBuilder(results[table] ?? { data: [], error: null }),
  } as unknown as SupabaseClient;
}

test("1. a genuinely empty, successful result on every read never sets partialData - 'no data' and 'the read failed' remain two different things", async () => {
  const supabase = makeMockSupabase();

  const data = await getDashboardData(supabase, "org-1");

  assert.equal(data.partialData, false);
  assert.equal(data.partialDataSourceCount, 0);
  // Confirms genuine emptiness still behaves exactly as before this change.
  assert.equal(data.attentionItems.length, 0);
  assert.equal(data.overview.newLeads, 0);
  assert.equal(data.recentActivity.length, 0);
});

test("2. a real PostgREST error on one of getDashboardData's own direct reads (leads) sets partialData, injected at the actual Supabase query boundary", async () => {
  const supabase = makeMockSupabase({
    leads: { data: null, error: { message: "connection reset by peer", code: "57P01" } },
  });

  const data = await getDashboardData(supabase, "org-1");

  assert.equal(data.partialData, true);
  assert.equal(data.partialDataSourceCount, 1);
  // The failure must never surface the raw error to the returned shape.
  assert.equal(JSON.stringify(data).includes("57P01"), false);
  assert.equal(JSON.stringify(data).includes("connection reset"), false);
});

test("3. a partial failure does not erase valid data from the other, successful reads", async () => {
  const supabase = makeMockSupabase({
    leads: { data: null, error: { message: "timeout" } },
    appointments: {
      data: [
        {
          id: "apt-1",
          lead_id: null,
          title: "Roof inspection",
          status: "scheduled",
          start_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          created_at: new Date().toISOString(),
          confirmed_at: null,
          confirmation_requested_at: null,
          contacts: null,
        },
      ],
      error: null,
    },
  });

  const data = await getDashboardData(supabase, "org-1");

  assert.equal(data.partialData, true);
  assert.equal(data.partialDataSourceCount, 1);
  // The appointments read succeeded and must still be fully reflected.
  const overdueItem = data.attentionItems.find((item) => item.kind === "overdue_appointment" && item.id === "apt-apt-1");
  assert.ok(overdueItem, "a successful read's real data must survive a sibling read's failure");
  assert.equal(overdueItem!.title, "Roof inspection");
});

test("4. multiple simultaneous failures on getDashboardData's own direct reads are all counted", async () => {
  const supabase = makeMockSupabase({
    leads: { data: null, error: { message: "err" } },
    estimates: { data: null, error: { message: "err" } },
    audit_log: { data: null, error: { message: "err" } },
  });

  const data = await getDashboardData(supabase, "org-1");

  assert.equal(data.partialData, true);
  assert.equal(data.partialDataSourceCount, 3);
});

test("5. documents the disclosed scope boundary: an error on a helper-owned read (opportunities) is NOT reflected in partialData, since getOpenOpportunities already discards its own error internally, outside this change's file scope", async () => {
  const supabase = makeMockSupabase({
    opportunities: { data: null, error: { message: "err" } },
  });

  const data = await getDashboardData(supabase, "org-1");

  // This is the documented, disclosed limitation - not a regression this
  // test is meant to catch. It exists so a future phase that closes this
  // gap has a failing test to flip, rather than silent, undocumented scope.
  assert.equal(data.partialData, false);
  assert.equal(data.partialDataSourceCount, 0);
});
