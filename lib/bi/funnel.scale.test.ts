/**
 * Phase 2F: response-time and stage-timing reads at scale, against a fake
 * Supabase client - every read paged through readAllPages, no id lists,
 * newest replies kept, older messages ignored, and a failed read reported
 * as failed (unavailable) rather than as zeros, down to the snapshot's
 * funnelUnavailable flags, the unavailable comparisons the AI observations
 * see, and partialData semantics left as they were. The same cases run at
 * real volume against TEST in funnel.scale.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/funnel.scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const funnel: typeof import("./funnel") = require(path.join(ROOT, "lib/bi/funnel.ts"));
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(ROOT, "lib/bi/metrics.ts"));
const { resolveDateRange }: typeof import("./queries") = require(path.join(ROOT, "lib/bi/queries.ts"));
const { buildAiInsightsInput }: typeof import("./insights") = require(path.join(ROOT, "lib/bi/insights.ts"));
const { MAX_ATTRIBUTION_ROWS }: typeof import("./revenue-attribution") = require(path.join(ROOT, "lib/bi/revenue-attribution.ts"));

type Query = { table: string; calls: string[] };
type Answer = { rows?: unknown[]; error?: boolean; count?: number };

/**
 * A fake client: every builder method is recorded and chainable; a paged
 * read resolves through range(), any other read when awaited. `answer`
 * decides each read's result from its table and recorded calls.
 */
function fakeSupabase(answer: (query: Query) => Answer = () => ({})) {
  const queries: Query[] = [];
  const supabase = {
    from(table: string) {
      const query: Query = { table, calls: [] };
      queries.push(query);
      const resolve = (from?: number, to?: number) => {
        const result = answer(query);
        if (result.error) return Promise.resolve({ data: null, error: { message: "boom" }, count: null });
        const rows = result.rows ?? [];
        return Promise.resolve({ data: from === undefined ? rows : rows.slice(from, to! + 1), error: null, count: result.count ?? rows.length });
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

const isUnavailable = (comparison: object) => "unavailable" in comparison && comparison.unavailable === true;
const has = (query: Query, prefix: string) => query.calls.some((call) => call.startsWith(prefix));
const isMessagesRead = (q: Query) => q.table === "messages" && has(q, "select created_at, conversation:");
const isSharedLeadsRead = (q: Query) => q.table === "leads" && has(q, "select id, contact_id, created_at");
const isStageEventsRead = (q: Query) => q.table === "automation_events" && has(q, "select entity_id, payload, created_at");
const MIN = 60_000;
const at = (base: string, minutes: number) => new Date(Date.parse(base) + minutes * MIN).toISOString().replace("Z", "+00:00");

const lead = (i: number, createdAt: string) => ({ id: `lead-${i}`, contact_id: `contact-${i}`, created_at: createdAt });
const outbound = (contact: string, createdAt: string) => ({ created_at: createdAt, conversation: { contact_id: contact } });

// ---------------------------------------------------------------------------
// Response time
// ---------------------------------------------------------------------------

test("response time: one paged messages read joined to the contact - no contact or conversation id list, however many leads", async () => {
  const leads = Array.from({ length: 450 }, (_, i) => lead(i, at("2026-09-10T00:00:00Z", i)));
  const { supabase, queries } = fakeSupabase((q) => (isMessagesRead(q) ? { rows: leads.map((l) => outbound(l.contact_id!, at(l.created_at, 5))) } : {}));
  const metrics = await funnel.getLeadResponseTimeMetrics(supabase, "org-1", leads);
  assert.deepEqual(queries.map((q) => q.table), ["messages"], "no conversations read, no per-lead read");
  const [messages] = queries;
  assert.deepEqual(messages.calls.filter((c) => !c.startsWith("range")), [
    "select created_at, conversation:conversations!messages_conversation_id_fkey!inner(contact_id)",
    "eq organization_id org-1",
    "eq conversation.organization_id org-1",
    "eq direction outbound",
    'in status ["sent","delivered"]',
    "gte created_at 2026-09-10T00:00:00.000Z",
    "order id",
  ]);
  assert.deepEqual([metrics.failed, metrics.leadsContacted, metrics.leadsNeverContacted, metrics.contactRate], [false, 450, 0, 100]);
});

test("response time: more than 1,000 messages are all read, and the newest lead's reply - message #1,500, oldest first - still counts", async () => {
  const leads = Array.from({ length: 500 }, (_, i) => lead(i, at("2026-09-01T00:00:00Z", i * 60)));
  // Two earlier replies per contact, then each lead's own reply; the newest lead's reply is the very last message.
  const rows = [
    ...leads.flatMap((l) => [outbound(l.contact_id!, at(l.created_at, -120)), outbound(l.contact_id!, at(l.created_at, -60))]),
    ...leads.map((l) => outbound(l.contact_id!, at(l.created_at, 7))),
  ];
  assert.equal(rows.length, 1500);
  const { supabase, queries } = fakeSupabase((q) => (isMessagesRead(q) ? { rows } : {}));
  const metrics = await funnel.getLeadResponseTimeMetrics(supabase, "org-1", leads);
  // readAllPages rebuilds the query for every page.
  assert.deepEqual(queries.flatMap((q) => q.calls.filter((c) => c.startsWith("range"))), ["range 0 999", "range 1000 1999"]);
  assert.deepEqual([metrics.failed, metrics.leadsContacted, metrics.leadsNeverContacted], [false, 500, 0]);
  assert.equal(metrics.averageResponseTimeMs, 7 * MIN, "every lead's first reply after its own creation - 7 minutes - never an earlier message");
});

test("response time: replies from before a lead was created - an older period's conversation with the same contact - never count", async () => {
  const leads = [lead(1, "2026-09-20T12:00:00+00:00"), lead(2, "2026-09-20T12:00:00+00:00")];
  const rows = [outbound("contact-1", "2026-08-15T09:00:00+00:00"), outbound("contact-1", "2026-09-20T11:59:59+00:00"), outbound("contact-2", "2026-09-20T12:03:00+00:00")];
  const metrics = await funnel.getLeadResponseTimeMetrics(fakeSupabase((q) => (isMessagesRead(q) ? { rows } : {})).supabase, "org-1", leads);
  assert.deepEqual([metrics.leadsContacted, metrics.leadsNeverContacted, metrics.averageResponseTimeMs], [1, 1, 3 * MIN]);
});

test("response time: messages for contacts outside the population, and unsorted pages, change nothing", async () => {
  const leads = [lead(1, "2026-09-20T12:00:00+00:00")];
  const rows = [outbound("contact-1", "2026-09-20T12:30:00+00:00"), outbound("someone-else", "2026-09-20T12:01:00+00:00"), outbound("contact-1", "2026-09-20T12:10:00+00:00")];
  const metrics = await funnel.getLeadResponseTimeMetrics(fakeSupabase((q) => (isMessagesRead(q) ? { rows } : {})).supabase, "org-1", leads);
  assert.equal(metrics.averageResponseTimeMs, 10 * MIN, "the earliest qualifying reply, whatever order the pages arrive in");
});

test("response time: a failed read - or one past the row limit - is failed, never 'every lead never contacted'", async () => {
  const leads = Array.from({ length: 10 }, (_, i) => lead(i, "2026-09-20T12:00:00+00:00"));
  for (const answer of [() => ({ error: true }), () => ({ rows: Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, () => outbound("contact-1", "2026-09-21T00:00:00+00:00")) })]) {
    const metrics = await funnel.getLeadResponseTimeMetrics(fakeSupabase((q) => (isMessagesRead(q) ? answer() : {})).supabase, "org-1", leads);
    assert.deepEqual([metrics.failed, metrics.leadsContacted, metrics.leadsNeverContacted, metrics.contactRate], [true, 0, 0, null]);
  }
});

test("response time below scale is unchanged: no leads → null rate, leads without contacts → 0%, no read issued for either", async () => {
  const none = fakeSupabase();
  assert.deepEqual(await funnel.getLeadResponseTimeMetrics(none.supabase, "org-1", []), { totalLeadsInPopulation: 0, leadsContacted: 0, leadsNeverContacted: 0, contactRate: null, averageResponseTimeMs: null, medianResponseTimeMs: null, bucketCounts: { under_1_min: 0, "1_to_5_min": 0, "5_to_15_min": 0, "15_to_60_min": 0, "1_to_24_hours": 0, over_24_hours: 0 }, failed: false });
  const noContacts = await funnel.getLeadResponseTimeMetrics(none.supabase, "org-1", [{ id: "l", contact_id: null, created_at: "2026-09-20T12:00:00+00:00" }]);
  assert.deepEqual([noContacts.leadsNeverContacted, noContacts.contactRate, noContacts.failed], [1, 0, false]);
  assert.equal(none.queries.length, 0);
});

// ---------------------------------------------------------------------------
// Shared leads and stage events
// ---------------------------------------------------------------------------

test("shared leads: paged past 1,000 rows; a failed read is failed with no leads", async () => {
  const rows = Array.from({ length: 1234 }, (_, i) => lead(i, "2026-09-20T12:00:00+00:00"));
  const range = { label: "custom", from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
  const ok = await funnel.getLeadsForRangeResult(fakeSupabase((q) => (isSharedLeadsRead(q) ? { rows } : {})).supabase, "org-1", range);
  assert.deepEqual([ok.failed, ok.leads.length], [false, 1234]);
  const failed = await funnel.getLeadsForRangeResult(fakeSupabase(() => ({ error: true })).supabase, "org-1", range);
  assert.deepEqual(failed, { leads: [], failed: true });
});

const stageEvent = (leadId: string, previous: string | null, next: string, createdAt: string) => ({ entity_id: leadId, payload: { previous_status: previous, new_status: next }, created_at: createdAt });

test("stage timing: more than 1,000 events read across pages with no lead id list; each lead's earliest transition wins whatever the page order", async () => {
  const leads = Array.from({ length: 450 }, (_, i) => lead(i, at("2026-09-01T00:00:00Z", i)));
  const rows = leads.flatMap((l) => [stageEvent(l.id, "qualified", "won", at(l.created_at, 120)), stageEvent(l.id, "contacted", "qualified", at(l.created_at, 90)), stageEvent(l.id, "new", "qualified", at(l.created_at, 60))]);
  rows.push(stageEvent("lead-from-another-period", "new", "qualified", "2026-09-05T00:00:00+00:00"));
  const { supabase, queries } = fakeSupabase((q) => (isStageEventsRead(q) ? { rows } : {}));
  const timing = await funnel.getLeadStageTimingMetrics(supabase, "org-1", leads);
  assert.ok(!queries.some((q) => q.calls.some((c) => c.startsWith("in "))), "no id list");
  assert.ok(queries.every((q) => q.calls.includes("gte created_at 2026-09-01T00:00:00.000Z")));
  assert.equal(queries.flatMap((q) => q.calls.filter((c) => c.startsWith("range"))).length, 2);
  assert.deepEqual([timing.failed, timing.leadsInRange, timing.leadsWithRecordedHistory, timing.leadsWithQualifiedTiming, timing.leadsWithWonTiming], [false, 450, 450, 450, 450]);
  assert.deepEqual([timing.averageTimeToQualifiedMs, timing.averageTimeToWonMs], [60 * MIN, 120 * MIN]);
});

test("stage timing: a failed read is failed with no timing - the population is still reported", async () => {
  const timing = await funnel.getLeadStageTimingMetrics(fakeSupabase(() => ({ error: true })).supabase, "org-1", [lead(1, "2026-09-20T12:00:00+00:00")]);
  assert.deepEqual([timing.failed, timing.leadsInRange, timing.leadsWithRecordedHistory, timing.averageTimeToQualifiedMs], [true, 1, 0, null]);
});

test("stage transitions: more than 1,000 events in the period all counted; a failed read is failed with zero counts", async () => {
  const rows = Array.from({ length: 1300 }, (_, i) => stageEvent(`lead-${i}`, "new", i % 2 ? "qualified" : "won", "2026-09-20T12:00:00+00:00"));
  const range = { label: "custom", from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
  const ok = await funnel.getLeadStageTransitionMetrics(fakeSupabase((q) => (isStageEventsRead(q) ? { rows } : {})).supabase, "org-1", range);
  assert.deepEqual([ok.failed, ok.totalTransitions, ok.leadsTransitionedToQualified, ok.leadsTransitionedToWon], [false, 1300, 650, 650]);
  const failed = await funnel.getLeadStageTransitionMetrics(fakeSupabase(() => ({ error: true })).supabase, "org-1", range);
  assert.deepEqual([failed.failed, failed.totalTransitions, failed.leadsTransitionedToQualified], [true, 0, 0]);
});

test("stage history check: a failed count is failed, not 'no history'; the boolean form is unchanged", async () => {
  const range = { label: "all time", from: null, to: null };
  assert.deepEqual(await funnel.hasAnyLeadStageHistoryResult(fakeSupabase(() => ({ error: true })).supabase, "org-1", range), { exists: false, failed: true });
  assert.deepEqual(await funnel.hasAnyLeadStageHistoryResult(fakeSupabase(() => ({ count: 3 })).supabase, "org-1", range), { exists: true, failed: false });
  assert.equal(await funnel.hasAnyLeadStageHistory(fakeSupabase(() => ({ count: 3 })).supabase, "org-1", range), true);
});

// ---------------------------------------------------------------------------
// The snapshot: unavailable states, AI comparisons, partialData unchanged
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-25T12:00:00Z");
const CURRENT = resolveDateRange("last30Days", NOW);
const isCurrent = (q: Query) => has(q, `gte created_at ${CURRENT.from}`);
const LEAD_IN_CURRENT = lead(1, "2026-09-20T12:00:00+00:00");
const LEAD_IN_PREVIOUS = lead(2, "2026-08-10T12:00:00+00:00");

/** A snapshot over an otherwise empty organization with one lead per period and one reply each - `fail` picks which reads error. */
async function snapshotWith(fail: (q: Query) => boolean = () => false) {
  const { supabase } = fakeSupabase((q) => {
    if (fail(q)) return { error: true };
    if (isSharedLeadsRead(q)) return { rows: [isCurrent(q) ? LEAD_IN_CURRENT : LEAD_IN_PREVIOUS] };
    if (isMessagesRead(q)) return { rows: [outbound("contact-1", "2026-09-20T12:05:00+00:00"), outbound("contact-2", "2026-08-10T12:05:00+00:00")] };
    return {};
  });
  return getBusinessMetricsSnapshot(supabase, "org-1", "last30Days", { now: NOW });
}

test("snapshot: with every read succeeding, nothing is unavailable and the contacted comparison is a real one", async () => {
  const snapshot = await snapshotWith();
  assert.deepEqual(snapshot.funnelUnavailable, { responseTime: false, stageTransitions: false, stageTiming: false });
  assert.deepEqual(snapshot.comparisons.leadsContacted, { current: 1, previous: 1, change: 0, percentageChange: 0 });
  assert.equal(snapshot.partialData, false);
});

test("snapshot: a failed current messages read → response time unavailable, the AI's contacted comparison unavailable, partialData as before", async () => {
  const snapshot = await snapshotWith((q) => isMessagesRead(q) && has(q, "gte created_at 2026-09-20"));
  assert.equal(snapshot.funnelUnavailable.responseTime, true);
  assert.deepEqual(snapshot.comparisons.leadsContacted, { unavailable: true, current: null, previous: null, change: null, percentageChange: null });
  assert.deepEqual(buildAiInsightsInput(snapshot).comparisons.leadsContacted, { unavailable: true, current: null, previous: null, change: null, percentageChange: null });
  assert.equal(snapshot.partialData, true, "a current response-time failure already counted toward partialData - unchanged");
});

test("snapshot: a failed PREVIOUS-period read makes only the comparison unavailable - the current figures stand, partialData unchanged (false)", async () => {
  for (const failPrevious of [(q: Query) => isSharedLeadsRead(q) && !isCurrent(q), (q: Query) => isMessagesRead(q) && has(q, "gte created_at 2026-08-10")]) {
    const snapshot = await snapshotWith(failPrevious);
    assert.equal(snapshot.funnelUnavailable.responseTime, false);
    assert.equal(snapshot.responseTime.leadsContacted, 1);
    assert.ok(isUnavailable(snapshot.comparisons.leadsContacted));
    assert.equal(snapshot.partialData, false, "previous-period reads were never part of partialData");
  }
});

test("snapshot: a failed current shared-leads read makes response time and stage timing unavailable (their population is unknown)", async () => {
  const snapshot = await snapshotWith((q) => isSharedLeadsRead(q) && isCurrent(q));
  assert.deepEqual(snapshot.funnelUnavailable, { responseTime: true, stageTransitions: false, stageTiming: true });
  assert.ok(isUnavailable(snapshot.comparisons.leadsContacted));
});

test("snapshot: failed stage reads → transitions unavailable, their AI comparisons unavailable, and the AI's note says unread - never 'no history'", async () => {
  const snapshot = await snapshotWith((q) => isStageEventsRead(q));
  assert.deepEqual(snapshot.funnelUnavailable, { responseTime: false, stageTransitions: true, stageTiming: true });
  assert.ok(isUnavailable(snapshot.comparisons.leadsTransitionedToQualified));
  assert.ok(isUnavailable(snapshot.comparisons.leadsTransitionedToWon));
  assert.equal(snapshot.dataQuality.stageHistoryUnavailable, true);
  assert.ok(snapshot.dataQuality.notes.some((note) => note.startsWith("Lead stage history could not be read for this snapshot")));
  assert.ok(!snapshot.dataQuality.notes.some((note) => note.startsWith("No lead.stage_changed event exists")));
});

test("snapshot: a failed stage-history count alone is reported as unread, and - as before - does not set partialData", async () => {
  const snapshot = await snapshotWith((q) => q.table === "automation_events" && has(q, "select id"));
  assert.ok(snapshot.dataQuality.notes.some((note) => note.startsWith("Lead stage history could not be read")));
  assert.equal(snapshot.partialData, false);
});
