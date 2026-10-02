/**
 * Phase 2K: automation event, workflow execution and leads-touched counts -
 * getAutomationAndFollowUpMetrics and getLeadsTouchedByAutomation (via the
 * snapshot) and what Analytics, Agency and the AI see when they can't be
 * read - against a fake Supabase client that, like the real API, returns at
 * most 1,000 rows to a request that isn't paged. Every read must be complete
 * past 1,000 rows (failed executions past row 1,000 included); a failed page
 * or the row limit is unavailable - never zeros presented as data - in the
 * AI's dataQuality notes and Agency health/usage; partialData and the AI
 * field set are unchanged. The same counts run against TEST in
 * automation.scale.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/automation.scale.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { getAutomationAndFollowUpMetrics }: typeof import("./queries") = require(path.join(ROOT, "lib/bi/queries.ts"));
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(ROOT, "lib/bi/metrics.ts"));
const { buildAiInsightsInput }: typeof import("./insights") = require(path.join(ROOT, "lib/bi/insights.ts"));
const { MAX_ATTRIBUTION_ROWS }: typeof import("./revenue-attribution") = require(path.join(ROOT, "lib/bi/revenue-attribution.ts"));
const { getAgencyOrganizationSnapshots }: typeof import("@/lib/agency/queries") = require(path.join(ROOT, "lib/agency/queries.ts"));
const { getAgencyHealth }: typeof import("@/lib/agency/health") = require(path.join(ROOT, "lib/agency/health.ts"));
const { getAgencyUsageSummary }: typeof import("@/lib/agency/usage") = require(path.join(ROOT, "lib/agency/usage.ts"));

type Query = { table: string; calls: string[] };
type Answer = { rows?: unknown[]; error?: boolean; failOnPage?: number };

/** The Phase 2F-2J fake client with the API's cap: a request that isn't paged gets at most 1,000 rows. */
function fakeSupabase(answer: (query: Query) => Answer = () => ({})) {
  const queries: Query[] = [];
  const supabase = {
    auth: { getUser: async () => ({ data: { user: { id: "agency-admin" } }, error: null }) },
    // Phase 3E: organization_health_inputs answers like the real function (an object, even when empty) - a null answer now reads as a failed incident read.
    rpc: async (name: string) => ({ data: name === "is_agency_admin" ? true : name === "organization_health_inputs" ? {} : null, error: null }),
    from(table: string) {
      const query: Query = { table, calls: [] };
      queries.push(query);
      const resolve = (from?: number, to?: number) => {
        const result = answer(query);
        const page = from === undefined ? 1 : from / 1000 + 1;
        if (result.error || result.failOnPage === page) return Promise.resolve({ data: null, error: { message: "boom" }, count: null });
        const rows = result.rows ?? [];
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

const isEvents = (q: Query) => q.table === "automation_events" && q.calls.includes("select event_type, entity_type, status");
const isExecutions = (q: Query) => q.table === "workflow_executions" && q.calls.includes("select workflow_name, status");
const isLeadsTouched = (q: Query) => q.table === "automation_events" && q.calls.includes("select entity_id");
const pagesOf = (queries: Query[], match: (q: Query) => boolean) => queries.filter(match).flatMap((q) => q.calls.filter((c) => c.startsWith("range")));

const EVENT_TYPES = ["lead.lost_nurture", "lead.reactivation", "estimate.followup", "job.post_followup", "appointment.reminder"];
/**
 * 2,500 automation events: types cycle, every fifth an appointment entity.
 * The first 1,000 are all completed; rows 1,000+ hold 120 failed and 30
 * pending - exactly what a capped read lost.
 */
function events() {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ event_type: EVENT_TYPES[i % 5], entity_type: i % 5 === 4 ? "appointment" : "lead", status: "completed" }));
  for (let i = 0; i < 120; i++) rows[1000 + i * 3].status = "failed";
  for (let i = 0; i < 30; i++) rows[1001 + i * 3].status = "pending";
  return rows;
}
/** 1,800 workflow executions. The first 1,000 all completed; rows 1,000+ hold 150 failed, 20 running and 30 cancelled. */
function executions() {
  const rows = Array.from({ length: 1800 }, (_, i) => ({ workflow_name: ["lead-nurture", "estimate-followup", "appointment-reminder"][i % 3], status: "completed" }));
  for (let i = 0; i < 150; i++) rows[1000 + i * 4].status = "failed";
  for (let i = 0; i < 20; i++) rows[1001 + i * 4].status = "running";
  for (let i = 0; i < 30; i++) rows[1002 + i * 4].status = "cancelled";
  return rows;
}
/** 1,500 lead-entity events over 1,200 distinct leads (the last 300 repeat leads seen before row 1,000), plus 20 with no entity id. */
const leadEvents = () => [...Array.from({ length: 1500 }, (_, i) => ({ entity_id: `lead-${i < 1200 ? i : i - 1200}` })), ...Array.from({ length: 20 }, () => ({ entity_id: null }))];
const count = <T>(rows: T[], match: (row: T) => boolean) => rows.filter(match).length;
const ALL_TIME = { label: "all time", from: null, to: null };
const baseAnswer = (q: Query): Answer => (isEvents(q) ? { rows: events() } : isExecutions(q) ? { rows: executions() } : isLeadsTouched(q) ? { rows: leadEvents() } : {});

// ---------------------------------------------------------------------------
// getAutomationAndFollowUpMetrics
// ---------------------------------------------------------------------------

test("automation events and workflow executions page past 1,000 rows under a stable order, with no cap and no id list", async () => {
  const { supabase, queries } = fakeSupabase(baseAnswer);
  const result = await getAutomationAndFollowUpMetrics(supabase, "org-1", ALL_TIME);
  assert.equal(result.failed, false);
  assert.deepEqual(pagesOf(queries, isEvents), ["range 0 999", "range 1000 1999", "range 2000 2999"]);
  assert.deepEqual(pagesOf(queries, isExecutions), ["range 0 999", "range 1000 1999"]);
  for (const q of queries) {
    assert.ok(q.calls.includes("order id"));
    assert.ok(!q.calls.some((c) => c.startsWith("limit ")), "no capped read");
    assert.ok(!q.calls.some((c) => c.startsWith("in ")), "no id list");
  }
});

test("exact counts across 2,500 events and 1,800 executions - every status (failed executions past row 1,000 included), type and workflow", async () => {
  const evts = events();
  const { supabase } = fakeSupabase(baseAnswer);
  const { automation: a, followUp: f } = await getAutomationAndFollowUpMetrics(supabase, "org-1", ALL_TIME);
  assert.deepEqual([a.totalAutomationEvents, a.completedAutomationEvents, a.failedAutomationEvents, a.pendingAutomationEvents], [2500, 2350, 120, 30]);
  assert.deepEqual([a.totalWorkflowExecutions, a.completedWorkflows, a.failedWorkflows, a.runningWorkflows, a.cancelledWorkflows], [1800, 1600, 150, 20, 30], "failed executions past row 1,000 are counted");
  assert.deepEqual(a.automationEventsByType, Object.fromEntries(EVENT_TYPES.map((t) => [t, 500])));
  assert.deepEqual(a.workflowExecutionsByName, { "lead-nurture": 600, "estimate-followup": 600, "appointment-reminder": 600 });
  assert.deepEqual([f.leadLostNurtureEvents, f.leadReactivationEvents, f.estimateFollowupEvents, f.postJobFollowupEvents], [500, 500, 500, 500]);
  assert.equal(f.appointmentAutomationEvents, count(evts, (r) => r.entity_type === "appointment"));
});

test("a page-2 failure or the row limit on either read is failed, and that read contributes nothing - never partial counts", async () => {
  for (const [name, failing] of [["events", isEvents], ["executions", isExecutions]] as const) {
    for (const failure of [{ failOnPage: 2 }, { rows: Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, () => ({ event_type: "lead.reactivation", entity_type: "lead", workflow_name: "x", status: "failed" })) }]) {
      const { supabase } = fakeSupabase((q) => (failing(q) ? { ...baseAnswer(q), ...failure } : baseAnswer(q)));
      const { automation: a, followUp: f, failed } = await getAutomationAndFollowUpMetrics(supabase, "org-1", ALL_TIME);
      assert.equal(failed, true, name);
      if (name === "events") assert.deepEqual([a.totalAutomationEvents, a.failedAutomationEvents, f.leadReactivationEvents, a.failedWorkflows], [0, 0, 0, 150]);
      else assert.deepEqual([a.totalWorkflowExecutions, a.failedWorkflows, a.completedWorkflows, a.totalAutomationEvents], [0, 0, 0, 2500]);
    }
  }
});

test("a genuinely empty result is a genuine zero, not a failure", async () => {
  const { supabase } = fakeSupabase();
  const { automation: a, failed } = await getAutomationAndFollowUpMetrics(supabase, "org-1", ALL_TIME);
  assert.equal(failed, false);
  assert.deepEqual([a.totalAutomationEvents, a.totalWorkflowExecutions, a.failedWorkflows], [0, 0, 0]);
});

// ---------------------------------------------------------------------------
// The snapshot: leads touched, automationUnavailable, the AI note, partialData
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-25T12:00:00Z");
const snapshotWith = (answer: (q: Query) => Answer) => getBusinessMetricsSnapshot(fakeSupabase(answer).supabase, "org-1", "last30Days", { now: NOW });
const AI_NOTE = "Automation and follow-up counts could not be read for this snapshot";

test("snapshot: leads touched de-duplicates 1,500 lead events into 1,200 distinct leads; complete automation figures; nothing unavailable, no AI note", async () => {
  const s = await snapshotWith(baseAnswer);
  assert.equal(s.followUpMetrics.leadsTouchedByAutomation, 1200);
  assert.deepEqual([s.automationMetrics.workflowExecutions, s.automationMetrics.failedWorkflowExecutions, s.automationMetrics.automationSuccessRate], [1800, 150, (1600 / 1750) * 100]);
  assert.equal(s.followUpMetrics.appointmentReminderEvents, 500);
  assert.equal(s.automationUnavailable, false);
  assert.ok(!s.dataQuality.notes.some((n) => n.startsWith(AI_NOTE)));
});

test("snapshot: a genuinely empty organization has zero automation activity and is not unavailable", async () => {
  const s = await snapshotWith(() => ({}));
  assert.deepEqual([s.automationMetrics.workflowExecutions, s.followUpMetrics.leadsTouchedByAutomation, s.automationUnavailable], [0, 0, false]);
  assert.ok(!s.dataQuality.notes.some((n) => n.startsWith(AI_NOTE)));
});

test("snapshot: a failed event, execution or leads-touched read (page 1, page 2 or row limit) is unavailable, tells the AI so, and leaves partialData and the AI field set unchanged", async () => {
  for (const failing of [isEvents, isExecutions, isLeadsTouched]) {
    for (const failure of [{ error: true }, { failOnPage: 2 }, { rows: Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, (_, i) => ({ entity_id: `lead-${i}`, event_type: "lead.reactivation", entity_type: "lead", workflow_name: "x", status: "completed" })) }]) {
      const s = await snapshotWith((q) => (failing(q) ? { ...baseAnswer(q), ...failure } : baseAnswer(q)));
      assert.equal(s.automationUnavailable, true);
      assert.equal(s.partialData, false, "automation never feeds partialData");
      if (failing === isLeadsTouched) assert.equal(s.followUpMetrics.leadsTouchedByAutomation, 0, "never a partial distinct count");
      const ai = buildAiInsightsInput(s);
      assert.ok(ai.dataQuality.notes.some((n) => n.startsWith(AI_NOTE)), "the AI is told the counts are unavailable");
      assert.deepEqual(Object.keys(ai).sort(), ["aiMetrics", "appointmentMetrics", "automationMetrics", "billingMetrics", "communicationMetrics", "comparisons", "dataQuality", "estimateMetrics", "followUpMetrics", "jobMetrics", "leadMetrics", "period", "pipelineMetrics"]);
      assert.ok(!("automationUnavailable" in ai));
    }
  }
});

// ---------------------------------------------------------------------------
// Agency: complete counts, and unavailable never read as a healthy zero
// ---------------------------------------------------------------------------

const AGENCY_ORG = { organization_id: "org-1", created_at: "2026-01-01T00:00:00Z", organizations: { name: "Client One" } };
const agencyAnswer = (failing?: (q: Query) => boolean) => (q: Query): Answer => {
  if (q.table === "agency_organizations") return { rows: [AGENCY_ORG] };
  const base = baseAnswer(q);
  return failing?.(q) ? { ...base, failOnPage: 2 } : base;
};

test("Agency: failed executions past row 1,000 reach health and make the organization need attention", async () => {
  const { supabase } = fakeSupabase(agencyAnswer());
  const snapshots = await getAgencyOrganizationSnapshots(supabase, supabase);
  assert.ok(snapshots.ok);
  assert.deepEqual([snapshots.organizations[0].metrics.automationMetrics.failedWorkflowExecutions, snapshots.organizations[0].automationFailed], [150, false]);
  const health = await getAgencyHealth(supabase, supabase);
  assert.ok(health.ok);
  const [orgHealth] = health.organizations;
  assert.deepEqual([orgHealth.failedWorkflowExecutions, orgHealth.automationUnavailable, orgHealth.needsAttention, health.partialData], [150, false, true, false]);
});

test("Agency: genuine zero automation activity stays healthy; an unreadable automation read is disclosed (partialData, usage note) and fails closed", async () => {
  // Genuine zero: no automation activity at all.
  const quiet = fakeSupabase((q) => (q.table === "agency_organizations" ? { rows: [AGENCY_ORG] } : {}));
  const quietHealth = await getAgencyHealth(quiet.supabase, quiet.supabase);
  assert.ok(quietHealth.ok);
  assert.deepEqual([quietHealth.organizations[0].automationUnavailable, quietHealth.organizations[0].needsAttention, quietHealth.partialData], [false, false, false]);
  const quietUsage = await getAgencyUsageSummary(quiet.supabase, quiet.supabase);
  assert.ok(quietUsage.ok);
  assert.ok(!quietUsage.clients[0].dataQuality.notes.includes("Automation counts temporarily unavailable."));

  // Unreadable: each automation read failing on page 2, with no other problem present.
  for (const failing of [isEvents, isExecutions, isLeadsTouched]) {
    const broken = fakeSupabase((q) => {
      if (q.table === "agency_organizations") return { rows: [AGENCY_ORG] };
      return failing(q) ? { rows: failing === isLeadsTouched ? leadEvents() : failing === isEvents ? events().map((e) => ({ ...e, status: "completed" })) : executions().map((e) => ({ ...e, status: "completed" })), failOnPage: 2 } : {};
    });
    const health = await getAgencyHealth(broken.supabase, broken.supabase);
    assert.ok(health.ok);
    const [orgHealth] = health.organizations;
    assert.deepEqual([orgHealth.failedWorkflowExecutions, orgHealth.automationUnavailable, orgHealth.needsAttention, health.partialData], [0, true, true, true]);
    const usage = await getAgencyUsageSummary(broken.supabase, broken.supabase);
    assert.ok(usage.ok);
    assert.equal(usage.clients[0].dataQuality.partialData, true);
    assert.ok(usage.clients[0].dataQuality.notes.includes("Automation counts temporarily unavailable."));
    assert.equal(usage.partialData, true);
  }
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("guards: the three affected reads use readAllPages with a stable order and no cap; partialData inputs are byte-identical to main", () => {
  const body = (file: string, fn: string) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const start = source.indexOf(`async function ${fn}(`);
    return source.slice(start, source.indexOf("\n}\n", start));
  };
  const automation = body("lib/bi/queries.ts", "getAutomationAndFollowUpMetrics");
  assert.equal(automation.match(/readAllPages</g)?.length, 2);
  assert.equal(automation.match(/\.order\("id"\)/g)?.length, 2);
  assert.doesNotMatch(automation, /\.limit\(/);
  const leadsTouched = body("lib/bi/metrics.ts", "getLeadsTouchedByAutomation");
  assert.match(leadsTouched, /readAllPages</);
  assert.match(leadsTouched, /\.order\("id"\)/);
  assert.doesNotMatch(leadsTouched, /\.limit\(/);
  const partialData = (source: string) => source.slice(source.indexOf("const partialDataSourceCount"), source.indexOf(".length;", source.indexOf("const partialDataSourceCount")));
  const main = execFileSync("git", ["show", "c0332258c3a26032c0e4ec3da9b38161abb5c011:lib/bi/metrics.ts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(partialData(fs.readFileSync(path.join(ROOT, "lib/bi/metrics.ts"), "utf8")), partialData(main));
});
