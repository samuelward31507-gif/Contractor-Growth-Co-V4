/**
 * Phase 3E: Agency consistency - the Agency UI never presents a failed or
 * unavailable read as healthy, empty or "never run". Covers:
 *   - open escalations paged past 1,000 rows, and a failed read disclosed;
 *   - a failed scheduler-heartbeat read vs a genuine "Never run";
 *   - an AI read failure vs genuinely no token usage (snapshot and the
 *     direct Agency AI breakdown read);
 *   - review/referral read failures disclosed in Usage;
 *   - getOrganizationHealth's incident read failure;
 *   - the distinct-client needs-attention set (header count and filter) and
 *     the newly itemized signals;
 *   - the overview/detail partial-data banners (source checks).
 *
 * Offline: a fake Supabase client that, like the real API, returns at most
 * 1,000 rows to a request that isn't paged. No network, no database, no
 * local environment file.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/agency-consistency.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { getAgencyEscalatedConversations }: typeof import("./communication") = require(path.join(ROOT, "lib/agency/communication.ts"));
const { getAgencyHealth }: typeof import("./health") = require(path.join(ROOT, "lib/agency/health.ts"));
const { getAgencyOrganizationSnapshots, getAgencyBusinessMetrics }: typeof import("./queries") = require(path.join(ROOT, "lib/agency/queries.ts"));
const { getAgencyUsageSummary }: typeof import("./usage") = require(path.join(ROOT, "lib/agency/usage.ts"));
const { getAgencyNeedsAttentionItems }: typeof import("./needs-attention") = require(path.join(ROOT, "lib/agency/needs-attention.ts"));
const { getOrganizationHealth }: typeof import("@/lib/automation-health/health") = require(path.join(ROOT, "lib/automation-health/health.ts"));
const { getBusinessMetricsSnapshot }: typeof import("@/lib/bi/metrics") = require(path.join(ROOT, "lib/bi/metrics.ts"));
const { buildAiInsightsInput }: typeof import("@/lib/bi/insights") = require(path.join(ROOT, "lib/bi/insights.ts"));
const { MAX_ATTRIBUTION_ROWS }: typeof import("@/lib/bi/revenue-attribution") = require(path.join(ROOT, "lib/bi/revenue-attribution.ts"));

type Query = { table: string; calls: string[] };
type Answer = { rows?: unknown[]; error?: boolean; failOnPage?: number };
type HealthInputs = Record<string, unknown> | "error";

/**
 * The established Phase 2J/2K fake (see lib/bi/communication.scale.test.ts),
 * plus a per-organization organization_health_inputs answer: an object (the
 * real function always returns one) or "error".
 */
function fakeSupabase(answer: (query: Query) => Answer = () => ({}), healthInputs: (organizationId: string) => HealthInputs = () => ({})) {
  const queries: Query[] = [];
  const supabase = {
    auth: { getUser: async () => ({ data: { user: { id: "agency-admin" } }, error: null }) },
    rpc: async (name: string, args?: { p_organization_id?: string }) => {
      if (name === "is_agency_admin") return { data: true, error: null };
      if (name === "organization_health_inputs") {
        const inputs = healthInputs(args?.p_organization_id ?? "");
        return inputs === "error" ? { data: null, error: { message: "boom" } } : { data: inputs, error: null };
      }
      return { data: null, error: null };
    },
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

// Recently created, so no "stuck in onboarding" item muddies the feed.
const RECENT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const agencyOrg = (id: string, name: string) => ({ organization_id: id, created_at: RECENT, organizations: { name } });
const forOrg = (q: Query, id: string) => q.calls.some((c) => c === `eq organization_id ${id}` || c.startsWith("in organization_id") && c.includes(id) || c === `eq id ${id}`);

const isEscalations = (q: Query) => q.table === "conversations" && q.calls.includes("select id, organization_id, contact_id, lead_id, updated_at");
const isHeartbeat = (q: Query) => q.table === "automation_health_check_runs";
const isExecutions = (q: Query) => q.table === "workflow_executions" && q.calls.includes("select workflow_name, status");
const isMessages = (q: Query) => q.table === "messages" && q.calls.includes("select direction, sender_type, status");
const isPaymentAndPause = (q: Query) => q.table === "organizations" && q.calls.includes("select id, payment_status, automation_paused");
const isAiBreakdown = (q: Query) => q.table === "ai_interactions" && q.calls.includes("select interaction_type, model");
const isAiOutput = (q: Query) => q.table === "ai_interactions" && q.calls.includes("select interaction_type, output");
const isReviews = (q: Query) => q.table === "review_requests";
const pages = (queries: Query[], match: (q: Query) => boolean) => queries.filter(match).flatMap((q) => q.calls.filter((c) => c.startsWith("range")));

const ONE_ORG = [agencyOrg("org-1", "Client One")];
const withOrgs = (orgs: unknown[], answer: (q: Query) => Answer = () => ({})) => (q: Query): Answer => (q.table === "agency_organizations" ? { rows: orgs } : answer(q));

/** n escalated conversations for org-1/org-2, newest first by updated_at (index 0 newest). */
const escalations = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `conv-${String(i).padStart(6, "0")}`, organization_id: i % 2 === 0 ? "org-1" : "org-2", contact_id: null, lead_id: null, updated_at: new Date(Date.UTC(2026, 9, 1) - i * 60000).toISOString() }));
const TWO_ORGS = [agencyOrg("org-1", "Client One"), agencyOrg("org-2", "Client Two")];

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

test("escalations: 999 / exactly 1,000 / 2,500 rows are all read, paged under a stable newest-first order with an id tie-break", async () => {
  for (const [n, expectedPages] of [
    [999, ["range 0 999"]],
    [1000, ["range 0 999", "range 1000 1999"]],
    [2500, ["range 0 999", "range 1000 1999", "range 2000 2999"]],
  ] as const) {
    const rows = escalations(n);
    const { supabase, queries } = fakeSupabase(withOrgs(TWO_ORGS, (q) => (isEscalations(q) ? { rows } : {})));
    const result = await getAgencyEscalatedConversations(supabase, supabase);
    assert.ok(result.ok);
    assert.equal(result.failed, false);
    assert.equal(result.conversations.length, n, `${n} rows`);
    assert.equal(result.countByOrg.get("org-1"), Math.ceil(n / 2));
    assert.equal(result.countByOrg.get("org-2"), Math.floor(n / 2));
    assert.deepEqual(pages(queries, isEscalations), expectedPages);
    const query = queries.find(isEscalations)!;
    assert.ok(query.calls.includes('order updated_at {"ascending":false}') && query.calls.includes("order id"), "newest first, id tie-break");
    assert.ok(!query.calls.some((c) => c.startsWith("limit")), "no capped read");
  }
});

test("escalations: rows past row 1,000 reach the feed - the per-org count and the newest timestamp come from the complete set", async () => {
  // org-2's only escalations sit past row 1,000.
  const rows = escalations(1200).map((row, i) => ({ ...row, organization_id: i < 1000 ? "org-1" : "org-2" }));
  const { supabase } = fakeSupabase(withOrgs(TWO_ORGS, (q) => (isEscalations(q) ? { rows } : {})));
  const result = await getAgencyEscalatedConversations(supabase, supabase);
  assert.ok(result.ok);
  assert.deepEqual([result.countByOrg.get("org-1"), result.countByOrg.get("org-2")], [1000, 200]);
  const feed = await getAgencyNeedsAttentionItems(supabase, supabase);
  assert.ok(feed.ok);
  const item = feed.items.find((i) => i.id === "escalation-org-2")!;
  assert.equal(item.why, "200 conversations waiting for a human reply");
  assert.equal(item.timestamp, rows[1000].updated_at, "the first row seen for org-2 is its newest");
});

test("escalations: a page-1 error, a page-2 error or the 100,000-row limit is failed with no rows - never 'no escalations'", async () => {
  for (const failure of [{ failOnPage: 1 }, { failOnPage: 2 }, { rows: Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, (_, i) => ({ ...escalations(1)[0], id: `c-${i}` })) }]) {
    const { supabase } = fakeSupabase(withOrgs(TWO_ORGS, (q) => (isEscalations(q) ? { rows: escalations(2500), ...failure } : {})));
    const result = await getAgencyEscalatedConversations(supabase, supabase);
    assert.ok(result.ok);
    assert.deepEqual([result.failed, result.conversations.length, result.countByOrg.size], [true, 0, 0]);
    const feed = await getAgencyNeedsAttentionItems(supabase, supabase);
    assert.ok(feed.ok);
    assert.equal(feed.partialData, true, "the feed can't claim all clients are fine");
  }
});

test("escalations: a genuinely empty result is a real zero (not failed), and no organizations means no read at all", async () => {
  const { supabase } = fakeSupabase(withOrgs(TWO_ORGS));
  const result = await getAgencyEscalatedConversations(supabase, supabase);
  assert.ok(result.ok);
  assert.deepEqual([result.failed, result.conversations.length], [false, 0]);
  const none = fakeSupabase(withOrgs([]));
  const empty = await getAgencyEscalatedConversations(none.supabase, none.supabase);
  assert.ok(empty.ok);
  assert.deepEqual([empty.failed, none.queries.some(isEscalations)], [false, false]);
});

// ---------------------------------------------------------------------------
// Scheduler heartbeat
// ---------------------------------------------------------------------------

test("heartbeat: a failed read is unavailable (never 'Never run' or stale) and feeds partialData; a genuine no-run stays 'Never run'; a recent run is fresh", async () => {
  const failed = fakeSupabase(withOrgs(ONE_ORG, (q) => (isHeartbeat(q) ? { error: true } : {})));
  const broken = await getAgencyHealth(failed.supabase, failed.supabase);
  assert.ok(broken.ok);
  assert.deepEqual(broken.schedulerHeartbeat, { lastCheckedAt: null, minutesSinceLastCheck: null, stale: false, unavailable: true });
  assert.equal(broken.partialData, true);

  const never = fakeSupabase(withOrgs(ONE_ORG));
  const neverRun = await getAgencyHealth(never.supabase, never.supabase);
  assert.ok(neverRun.ok);
  assert.deepEqual(neverRun.schedulerHeartbeat, { lastCheckedAt: null, minutesSinceLastCheck: null, stale: true, unavailable: false });
  assert.equal(neverRun.partialData, false);

  const recent = new Date(Date.now() - 5 * 60000).toISOString();
  const fresh = fakeSupabase(withOrgs(ONE_ORG, (q) => (isHeartbeat(q) ? { rows: [{ checked_at: recent }] } : {})));
  const freshRun = await getAgencyHealth(fresh.supabase, fresh.supabase);
  assert.ok(freshRun.ok);
  assert.deepEqual([freshRun.schedulerHeartbeat.lastCheckedAt, freshRun.schedulerHeartbeat.stale, freshRun.schedulerHeartbeat.unavailable], [recent, false, false]);
});

test("heartbeat UI: Unavailable takes precedence over 'Never run', with no stale claim", () => {
  const source = fs.readFileSync(path.join(ROOT, "app/agency/_components/system-health.tsx"), "utf8");
  assert.match(source, /schedulerHeartbeat\.unavailable\s*\?\s*"Unavailable"\s*:\s*schedulerHeartbeat\.lastCheckedAt === null\s*\?\s*"Never run"/);
  assert.match(source, /schedulerHeartbeat\.unavailable \? "The scheduler heartbeat could not be read\." : schedulerHeartbeat\.stale/);
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

test("AI: a failed snapshot AI read sets aiUnavailable, keeps partialData and the AI input field set unchanged; genuinely no token usage keeps the token line", async () => {
  const NOW = new Date("2026-09-25T12:00:00Z");
  const ok = await getBusinessMetricsSnapshot(fakeSupabase().supabase, "org-1", "last30Days", { now: NOW });
  assert.deepEqual([ok.aiUnavailable, ok.dataQuality.aiTokenUsageUnavailable, ok.partialData], [false, true, false]);
  const failed = await getBusinessMetricsSnapshot(fakeSupabase((q) => (isAiOutput(q) ? { error: true } : {})).supabase, "org-1", "last30Days", { now: NOW });
  assert.deepEqual([failed.aiUnavailable, failed.partialData], [true, true]);
  for (const snapshot of [ok, failed]) {
    const ai = buildAiInsightsInput(snapshot);
    assert.deepEqual(Object.keys(ai).sort(), ["aiMetrics", "appointmentMetrics", "automationMetrics", "billingMetrics", "communicationMetrics", "comparisons", "dataQuality", "estimateMetrics", "followUpMetrics", "jobMetrics", "leadMetrics", "period", "pipelineMetrics"]);
    assert.ok(!("aiUnavailable" in ai));
  }
});

test("AI in Usage: a failed snapshot AI read says 'AI usage temporarily unavailable' and marks AI unavailable - never 'no token usage reported'", async () => {
  const { supabase } = fakeSupabase(withOrgs(ONE_ORG, (q) => (isAiOutput(q) ? { error: true } : {})));
  const usage = await getAgencyUsageSummary(supabase, supabase);
  assert.ok(usage.ok);
  const [client] = usage.clients;
  assert.equal(client.ai.unavailable, true);
  assert.ok(client.dataQuality.notes.includes("AI usage temporarily unavailable."));
  assert.ok(!client.dataQuality.notes.includes("No AI interaction in this period reported token usage."));
  assert.equal(client.dataQuality.partialData, true);
});

test("AI in Usage: genuinely no AI activity keeps the existing token line, no unavailable flag, no partial data", async () => {
  const { supabase } = fakeSupabase(withOrgs(ONE_ORG));
  const usage = await getAgencyUsageSummary(supabase, supabase);
  assert.ok(usage.ok);
  const [client] = usage.clients;
  assert.deepEqual([client.ai.unavailable, client.dataQuality.partialData], [false, false]);
  assert.ok(client.dataQuality.notes.includes("No AI interaction in this period reported token usage."));
  assert.ok(!client.dataQuality.notes.includes("AI usage temporarily unavailable."));
});

test("AI: the direct Agency AI breakdown read failing alone sets aiFailed (the snapshot's own AI read is fine), discloses it in Usage and the agency-wide note", async () => {
  // The snapshot's own getAiMetrics read is issued first and the direct
  // Agency call second (deterministic with no real I/O) - fail only the second.
  let seen = 0;
  const { supabase } = fakeSupabase(withOrgs(ONE_ORG, (q) => (isAiBreakdown(q) && q.calls.some((c) => c.startsWith("range")) && seen++ === 1 ? { error: true } : {})));
  const snapshots = await getAgencyOrganizationSnapshots(supabase, supabase);
  assert.ok(snapshots.ok);
  const [org] = snapshots.organizations;
  assert.equal(org.aiFailed, true);
  assert.equal(org.metrics.aiUnavailable, false, "only the direct read failed");

  seen = 0;
  const usage = await getAgencyUsageSummary(supabase, supabase);
  assert.ok(usage.ok);
  assert.deepEqual([usage.clients[0].ai.unavailable, usage.clients[0].dataQuality.partialData], [true, true]);
  assert.ok(usage.clients[0].dataQuality.notes.includes("AI usage temporarily unavailable."));

  seen = 0;
  const metrics = await getAgencyBusinessMetrics(supabase, supabase);
  assert.ok(metrics.ok);
  assert.equal(metrics.dataQuality.aiUnavailable, true);
  assert.ok(metrics.dataQuality.notes.some((n) => n.startsWith("AI figures could not be read for 1 of 1 client(s)")));
  assert.ok(!metrics.dataQuality.notes.some((n) => n.startsWith("No organization has any ai_interactions row")));
});

// ---------------------------------------------------------------------------
// Review / referral
// ---------------------------------------------------------------------------

test("review/referral in Usage: an unreadable read is disclosed (note, partial, unavailable flag); a readable one is unchanged", async () => {
  const broken = fakeSupabase(withOrgs(ONE_ORG, (q) => (isReviews(q) ? { error: true } : {})));
  const usage = await getAgencyUsageSummary(broken.supabase, broken.supabase);
  assert.ok(usage.ok);
  const [client] = usage.clients;
  assert.equal(client.operational.reviewReferralUnavailable, true);
  assert.ok(client.dataQuality.notes.includes("Review and referral counts temporarily unavailable."));
  assert.equal(client.dataQuality.partialData, true);

  const fine = fakeSupabase(withOrgs(ONE_ORG));
  const okUsage = await getAgencyUsageSummary(fine.supabase, fine.supabase);
  assert.ok(okUsage.ok);
  assert.equal(okUsage.clients[0].operational.reviewReferralUnavailable, false);
  assert.ok(!okUsage.clients[0].dataQuality.notes.includes("Review and referral counts temporarily unavailable."));
});

// ---------------------------------------------------------------------------
// getOrganizationHealth incident read
// ---------------------------------------------------------------------------

test("organization health: a failed incident read sets incidentsUnavailable (never silently 'no incidents'); a successful read is unchanged", async () => {
  const failed = await getOrganizationHealth(fakeSupabase(() => ({}), () => "error").supabase, "org-1");
  assert.equal(failed.incidentsUnavailable, true);
  assert.equal(failed.status, "payment_blocked", "existing fail-closed status is unchanged");

  const inputs = { incidents: [{ category: "workflow_stuck", severity: "warning" }], organization: { payment_status: "active", automation_paused: false }, window_status_counts: { completed: 3, failed: 1 } };
  const ok = await getOrganizationHealth(fakeSupabase(() => ({}), () => inputs).supabase, "org-2");
  assert.deepEqual([ok.incidentsUnavailable, ok.activeIncidentCount, ok.warningIncidentCount, ok.status, ok.failedWorkflowExecutions], [false, 1, 1, "degraded", 1]);
});

test("organization health in Agency: an unreadable incident read fails closed (needsAttention, partialData), gets a feed item, and counts the client", async () => {
  const { supabase } = fakeSupabase(withOrgs(TWO_ORGS), (id) => (id === "org-2" ? "error" : {}));
  const health = await getAgencyHealth(supabase, supabase);
  assert.ok(health.ok);
  const byId = new Map(health.organizations.map((o) => [o.organizationId, o]));
  assert.deepEqual([byId.get("org-1")!.incidentsUnavailable, byId.get("org-1")!.needsAttention], [false, false]);
  assert.deepEqual([byId.get("org-2")!.incidentsUnavailable, byId.get("org-2")!.needsAttention, health.partialData], [true, true, true]);
  const feed = await getAgencyNeedsAttentionItems(supabase, supabase);
  assert.ok(feed.ok);
  assert.ok(feed.items.some((i) => i.id === "incidents-unavailable-org-2" && i.problem === "Automation health unavailable"));
  assert.deepEqual([feed.attentionOrganizationIds, feed.partialData], [["org-2"], true]);
});

// ---------------------------------------------------------------------------
// Distinct-client needs-attention
// ---------------------------------------------------------------------------

test("needs-attention: a healthy agency has no items, no flagged clients and no partial data (successful behavior unchanged)", async () => {
  const { supabase } = fakeSupabase(withOrgs(TWO_ORGS));
  const feed = await getAgencyNeedsAttentionItems(supabase, supabase);
  assert.ok(feed.ok);
  assert.deepEqual([feed.items, feed.attentionOrganizationIds, feed.partialData], [[], [], false]);
});

test("needs-attention: failed executions, failed messages, paused automation and unreadable counts each get a feed item, and every flagged client is in the set", async () => {
  const executions = Array.from({ length: 3 }, () => ({ workflow_name: "estimate_followup", status: "failed" }));
  const messages = [{ direction: "outbound", sender_type: "ai", status: "failed" }, { direction: "outbound", sender_type: "ai", status: "undelivered" }];
  const orgs = [agencyOrg("org-exec", "Exec Co"), agencyOrg("org-msg", "Msg Co"), agencyOrg("org-paused", "Paused Co"), agencyOrg("org-comm", "Comm Co"), agencyOrg("org-auto", "Auto Co"), agencyOrg("org-ok", "Fine Co")];
  const { supabase } = fakeSupabase(
    withOrgs(orgs, (q) => {
      if (isExecutions(q) && forOrg(q, "org-exec")) return { rows: executions };
      if (isMessages(q) && forOrg(q, "org-msg")) return { rows: messages };
      if (isMessages(q) && forOrg(q, "org-comm")) return { failOnPage: 1 };
      if (isExecutions(q) && forOrg(q, "org-auto")) return { failOnPage: 1 };
      if (isPaymentAndPause(q)) return { rows: orgs.map((o) => ({ id: o.organization_id, payment_status: "active", automation_paused: o.organization_id === "org-paused" })) };
      return {};
    }),
  );
  const feed = await getAgencyNeedsAttentionItems(supabase, supabase);
  assert.ok(feed.ok);
  const ids = new Set(feed.items.map((i) => i.id));
  for (const id of ["executions-failed-org-exec", "messages-failed-org-msg", "paused-org-paused", "communication-unavailable-org-comm", "automation-unavailable-org-auto"]) assert.ok(ids.has(id), id);
  assert.equal(feed.items.find((i) => i.id === "executions-failed-org-exec")!.why, "3 failed executions in the last 30 days");
  assert.equal(feed.items.find((i) => i.id === "messages-failed-org-msg")!.why, "2 failed or undelivered messages in the last 30 days");
  assert.deepEqual(feed.attentionOrganizationIds, ["org-exec", "org-msg", "org-paused", "org-comm", "org-auto"], "distinct clients in agency order; the healthy one is excluded");

  // Every client whose health flag is set appears in the set, and has a reason in the feed.
  const health = await getAgencyHealth(supabase, supabase);
  assert.ok(health.ok);
  for (const org of health.organizations.filter((o) => o.needsAttention)) {
    assert.ok(feed.attentionOrganizationIds.includes(org.organizationId), org.organizationId);
    assert.ok(feed.items.some((i) => i.organizationId === org.organizationId), `${org.organizationId} has a reason`);
  }
});

test("needs-attention: a client with several issues counts once; an escalation-only client is counted even though its health flag is not set", async () => {
  const orgs = [agencyOrg("org-multi", "Multi Co"), agencyOrg("org-esc", "Escalation Co")];
  const { supabase } = fakeSupabase(
    withOrgs(orgs, (q) => {
      if (isExecutions(q) && forOrg(q, "org-multi")) return { rows: [{ workflow_name: "x", status: "failed" }] };
      if (isMessages(q) && forOrg(q, "org-multi")) return { rows: [{ direction: "outbound", sender_type: "ai", status: "failed" }] };
      if (isPaymentAndPause(q)) return { rows: [{ id: "org-multi", payment_status: "active", automation_paused: true }, { id: "org-esc", payment_status: "active", automation_paused: false }] };
      if (isEscalations(q)) return { rows: [{ id: "c-1", organization_id: "org-esc", contact_id: null, lead_id: null, updated_at: RECENT }] };
      return {};
    }),
  );
  const feed = await getAgencyNeedsAttentionItems(supabase, supabase);
  assert.ok(feed.ok);
  assert.ok(feed.items.filter((i) => i.organizationId === "org-multi").length >= 3, "several items for one client");
  assert.deepEqual(feed.attentionOrganizationIds, ["org-multi", "org-esc"], "two clients, not one per item");
  const health = await getAgencyHealth(supabase, supabase);
  assert.ok(health.ok);
  assert.equal(health.organizations.find((o) => o.organizationId === "org-esc")!.needsAttention, false);
});

test("needs-attention: failed executions or messages already covered by an incident item are not itemized twice", async () => {
  const inputs = { incidents: [{ category: "sms_delivery_failed", severity: "warning" }], organization: { payment_status: "active", automation_paused: false } };
  const { supabase } = fakeSupabase(
    withOrgs(ONE_ORG, (q) => {
      if (isExecutions(q)) return { rows: [{ workflow_name: "x", status: "failed" }] };
      if (isMessages(q)) return { rows: [{ direction: "outbound", sender_type: "ai", status: "failed" }] };
      return {};
    }),
    () => inputs,
  );
  const feed = await getAgencyNeedsAttentionItems(supabase, supabase);
  assert.ok(feed.ok);
  const ids = feed.items.map((i) => i.id);
  assert.ok(ids.includes("incident-warning-org-1") && ids.includes("sms-org-1"));
  assert.ok(!ids.includes("executions-failed-org-1") && !ids.includes("messages-failed-org-1"));
});

// ---------------------------------------------------------------------------
// Pages (server components - source checks, the Analytics test convention)
// ---------------------------------------------------------------------------

test("overview: header counts distinct clients from the shared set, the attention filter uses the same set, and the banner covers snapshot, escalation and feed failures", () => {
  const page = fs.readFileSync(path.join(ROOT, "app/agency/page.tsx"), "utf8");
  assert.match(page, /const attentionOrganizationIds = new Set\(needsAttention\.attentionOrganizationIds\)/);
  assert.match(page, /needsAttention: attentionOrganizationIds\.has\(org\.organizationId\)/);
  assert.match(page, /case "attention":\s*\n\s*\/\/[^\n]*\n\s*return row\.needsAttention;/);
  assert.match(page, /const attentionClientCount = allRows\.filter\(\(row\) => row\.needsAttention\)\.length;/);
  assert.match(page, /\{formatCount\(attentionClientCount\)\}/);
  assert.doesNotMatch(page, /needsAttention\.items\.length/, "the header never counts items");
  assert.match(page, /const snapshotPartialData = metrics\.organizations\.some\(\(org\) => org\.metrics\.partialData \|\| org\.metrics\.reviewReferralUnavailable \|\| org\.aiFailed\);/);
  assert.match(page, /const pagePartialData = health\.partialData \|\| escalations\.failed \|\| needsAttention\.partialData \|\| snapshotPartialData;/);
  assert.match(page, /\{pagePartialData \? \(/);
  assert.match(page, /pagePartialData \? "Some data is unavailable" : "All clients operating normally"/);
  assert.match(page, /escalationCount: escalations\.failed \? null :/);
  assert.match(page, /aiEscalationCount=\{escalations\.failed \? null : escalations\.conversations\.length\}/);
});

test("client detail: a per-client partial banner, the shared attention set, Unavailable escalations and a kept AI section on a failed AI read", () => {
  const page = fs.readFileSync(path.join(ROOT, "app/agency/organizations/[id]/page.tsx"), "utf8");
  for (const flag of ["org.metrics.partialData", "org.metrics.reviewReferralUnavailable", "aiUnavailable", "orgHealth.communicationUnavailable", "orgHealth.automationUnavailable", "orgHealth.incidentsUnavailable", "escalations.failed"]) {
    assert.ok(page.slice(page.indexOf("const clientPartialData ="), page.indexOf("const clientPartialData =") + 400).includes(flag), flag);
  }
  assert.match(page, /\{clientPartialData \? \(/);
  assert.match(page, /const clientInAttention = needsAttention\.attentionOrganizationIds\.includes\(id\);/);
  assert.match(page, /const escalationCount = escalations\.failed \? null :/);
  assert.match(page, /<SectionCard title="AI activity"[^>]*>\s*\{aiUnavailable \? \(\s*<MetricList>\s*<Row label="Total interactions" value="Unavailable"/);
  assert.match(page, /\{aiUnavailable \? \([\s\S]*?AI data temporarily unavailable[\s\S]*?\) : metrics\.dataQuality\.aiTokenUsageUnavailable \? \(/);
});

test("guards: authorization still comes before any read in every changed Agency entry point", () => {
  for (const [file, fn] of [
    ["lib/agency/communication.ts", "getAgencyEscalatedConversations"],
    ["lib/agency/needs-attention.ts", "getAgencyNeedsAttentionItems"],
  ] as const) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const body = source.slice(source.indexOf(`export async function ${fn}(`));
    const auth = body.indexOf("await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);");
    const guard = body.indexOf("if (!resolved.ok) return resolved;");
    const firstRead = Math.min(...[".from(", "readAllPages<", "getAgencyHealth(", "getOrganizationHealth("].map((needle) => body.indexOf(needle)).filter((i) => i >= 0));
    assert.ok(auth >= 0 && auth < guard && guard < firstRead, `${fn}: authorized before any read`);
  }
});
