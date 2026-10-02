/**
 * Phase 2J: message, conversation and opt-out counts - getCommunicationMetrics
 * (also called directly by Agency), getOptOutCount (via the snapshot) and
 * what Agency and the AI see when they can't be read - against a fake
 * Supabase client that, like the real API, returns at most 1,000 rows to a
 * request that isn't paged. Every read must be complete past 1,000 rows
 * (failed sends past row 1,000 included); a failed page or the row limit
 * is unavailable - never zeros presented as data - in Analytics, the AI's
 * dataQuality notes and Agency health/usage; partialData and the AI field
 * set are unchanged. The same counts run against TEST in
 * communication.scale.integration.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/communication.scale.test.ts
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
const { getCommunicationMetrics, resolveDateRange }: typeof import("./queries") = require(path.join(ROOT, "lib/bi/queries.ts"));
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(ROOT, "lib/bi/metrics.ts"));
const { buildAiInsightsInput }: typeof import("./insights") = require(path.join(ROOT, "lib/bi/insights.ts"));
const { MAX_ATTRIBUTION_ROWS }: typeof import("./revenue-attribution") = require(path.join(ROOT, "lib/bi/revenue-attribution.ts"));
const { getAgencyOrganizationSnapshots }: typeof import("@/lib/agency/queries") = require(path.join(ROOT, "lib/agency/queries.ts"));
const { getAgencyHealth }: typeof import("@/lib/agency/health") = require(path.join(ROOT, "lib/agency/health.ts"));
const { getAgencyUsageSummary }: typeof import("@/lib/agency/usage") = require(path.join(ROOT, "lib/agency/usage.ts"));

type Query = { table: string; calls: string[] };
type Answer = { rows?: unknown[]; error?: boolean; failOnPage?: number };

/** The Phase 2F-2I fake client with the API's cap: a request that isn't paged gets at most 1,000 rows. */
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

const isConversations = (q: Query) => q.table === "conversations" && q.calls.includes("select status, channel");
const isMessages = (q: Query) => q.table === "messages" && q.calls.includes("select direction, sender_type, status");
const isOptOuts = (q: Query) => q.table === "contacts" && q.calls.includes("select sms_opt_out");
const pagesOf = (queries: Query[], match: (q: Query) => boolean) => queries.filter(match).flatMap((q) => q.calls.filter((c) => c.startsWith("range")));

const CHANNELS = ["sms", "web", "email", "voice"];
/** 1,200 conversations: channels cycle, every third closed. */
const conversations = () => Array.from({ length: 1200 }, (_, i) => ({ status: i % 3 === 0 ? "closed" : "open", channel: CHANNELS[i % 4] }));
/**
 * 2,500 messages. The first 1,000 hold no failed or undelivered sends; rows
 * 1,000+ hold 100 failed and 50 undelivered - exactly what a capped read lost.
 */
function messages() {
  const rows: { direction: string; sender_type: string; status: string }[] = [];
  for (let i = 0; i < 2500; i++) {
    if (i % 2 === 0) rows.push({ direction: "inbound", sender_type: "customer", status: "received" });
    else rows.push({ direction: "outbound", sender_type: ["ai", "user", "system"][i % 3], status: "delivered" });
  }
  for (let i = 0; i < 100; i++) rows[1001 + i * 2] = { direction: "outbound", sender_type: "ai", status: "failed" };
  for (let i = 0; i < 50; i++) rows[1301 + i * 2] = { direction: "outbound", sender_type: "user", status: "undelivered" };
  return rows;
}
const count = <T>(rows: T[], match: (row: T) => boolean) => rows.filter(match).length;
const ALL_TIME = { label: "all time", from: null, to: null };

// ---------------------------------------------------------------------------
// getCommunicationMetrics (also Agency's direct call)
// ---------------------------------------------------------------------------

test("conversations and messages page past 1,000 rows under a stable order, with no cap and no id list", async () => {
  const { supabase, queries } = fakeSupabase((q) => (isConversations(q) ? { rows: conversations() } : isMessages(q) ? { rows: messages() } : {}));
  const result = await getCommunicationMetrics(supabase, "org-1", ALL_TIME);
  assert.equal(result.failed, false);
  assert.deepEqual(pagesOf(queries, isConversations), ["range 0 999", "range 1000 1999"]);
  assert.deepEqual(pagesOf(queries, isMessages), ["range 0 999", "range 1000 1999", "range 2000 2999"]);
  for (const q of queries) {
    assert.ok(q.calls.includes("order id"));
    assert.ok(!q.calls.some((c) => c.startsWith("limit ")), "no capped read");
    assert.ok(!q.calls.some((c) => c.startsWith("in ")), "no id list");
  }
});

test("exact counts across 2,500 messages and 1,200 conversations - direction, sender, every status (failed sends past row 1,000 included), every channel", async () => {
  const msgs = messages();
  const convs = conversations();
  const { supabase } = fakeSupabase((q) => (isConversations(q) ? { rows: convs } : isMessages(q) ? { rows: msgs } : {}));
  const m = await getCommunicationMetrics(supabase, "org-1", ALL_TIME);
  assert.equal(m.totalInboundMessages, count(msgs, (r) => r.direction === "inbound"));
  assert.equal(m.totalOutboundMessages, count(msgs, (r) => r.direction === "outbound"));
  assert.deepEqual([m.aiOutboundMessages, m.userOutboundMessages, m.systemOutboundMessages], ["ai", "user", "system"].map((s) => count(msgs, (r) => r.direction === "outbound" && r.sender_type === s)));
  assert.deepEqual([m.failedMessages, m.undeliveredMessages], [100, 50], "failed sends past row 1,000 are counted");
  assert.equal(m.deliveredMessages, count(msgs, (r) => r.status === "delivered"));
  assert.equal(m.byMessageStatus.received, count(msgs, (r) => r.status === "received"));
  assert.deepEqual([m.openConversations, m.closedConversations], [800, 400]);
  assert.deepEqual([m.smsConversations, m.webConversations, m.emailConversations, m.voiceConversations], [300, 300, 300, 300]);
});

test("a page-2 failure or the row limit on either read is failed, and that read contributes nothing - never partial counts", async () => {
  for (const [name, failing] of [["conversations", isConversations], ["messages", isMessages]] as const) {
    for (const failure of [{ failOnPage: 2 }, { rows: Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, () => ({ status: "open", channel: "sms", direction: "outbound", sender_type: "ai" })) }]) {
      const { supabase } = fakeSupabase((q) => {
        const base = isConversations(q) ? { rows: conversations() } : isMessages(q) ? { rows: messages() } : {};
        return failing(q) ? { ...base, ...failure } : base;
      });
      const m = await getCommunicationMetrics(supabase, "org-1", ALL_TIME);
      assert.equal(m.failed, true, name);
      if (name === "messages") assert.deepEqual([m.totalInboundMessages, m.totalOutboundMessages, m.failedMessages, m.openConversations], [0, 0, 0, 800]);
      else assert.deepEqual([m.openConversations, m.closedConversations, m.totalInboundMessages], [0, 0, 1250]);
    }
  }
});

// ---------------------------------------------------------------------------
// The snapshot: opt-outs, communicationUnavailable, the AI note, partialData
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-25T12:00:00Z");
const optOuts = () => Array.from({ length: 1500 }, (_, i) => ({ sms_opt_out: i % 5 === 0 }));
const baseAnswer = (q: Query): Answer => (isConversations(q) ? { rows: conversations() } : isMessages(q) ? { rows: messages() } : isOptOuts(q) ? { rows: optOuts() } : {});
const snapshotWith = (answer: (q: Query) => Answer) => getBusinessMetricsSnapshot(fakeSupabase(answer).supabase, "org-1", "last30Days", { now: NOW });
const AI_NOTE = "Message, conversation and opt-out counts could not be read for this snapshot";

test("snapshot: exact opt-outs across 1,500 contacts (300) and complete communication figures; nothing unavailable, no AI note", async () => {
  const s = await snapshotWith(baseAnswer);
  assert.equal(s.communicationMetrics.optOutCount, 300);
  assert.equal(s.communicationMetrics.inboundMessages, 1250);
  assert.equal(s.communicationUnavailable, false);
  assert.ok(!s.dataQuality.notes.some((n) => n.startsWith(AI_NOTE)));
});

test("snapshot: a failed conversation, message or opt-out read (page 2 or row limit) is unavailable, tells the AI so, and leaves partialData and the AI field set unchanged", async () => {
  for (const failing of [isConversations, isMessages, isOptOuts]) {
    for (const failure of [{ failOnPage: 2 }, { rows: Array.from({ length: MAX_ATTRIBUTION_ROWS + 1 }, () => ({ sms_opt_out: true, status: "open", channel: "sms", direction: "inbound", sender_type: "customer" })) }]) {
      const s = await snapshotWith((q) => (failing(q) ? { ...baseAnswer(q), ...failure } : baseAnswer(q)));
      assert.equal(s.communicationUnavailable, true);
      assert.equal(s.partialData, false, "communication never feeds partialData");
      const ai = buildAiInsightsInput(s);
      assert.ok(ai.dataQuality.notes.some((n) => n.startsWith(AI_NOTE)), "the AI is told the counts are unavailable");
      assert.deepEqual(Object.keys(ai).sort(), ["aiMetrics", "appointmentMetrics", "automationMetrics", "billingMetrics", "communicationMetrics", "comparisons", "dataQuality", "estimateMetrics", "followUpMetrics", "jobMetrics", "leadMetrics", "period", "pipelineMetrics"]);
      assert.deepEqual(Object.keys(ai.communicationMetrics).sort(), ["aiOutboundMessages", "conversationsClosed", "conversationsOpened", "customerReplies", "inboundMessages", "optOutCount", "outboundMessages", "systemOutboundMessages", "userOutboundMessages"]);
      assert.ok(!("communicationUnavailable" in ai));
    }
  }
});

// ---------------------------------------------------------------------------
// Agency (K1): complete counts, and unavailable never read as a healthy zero
// ---------------------------------------------------------------------------

const AGENCY_ORG = { organization_id: "org-1", created_at: "2026-01-01T00:00:00Z", organizations: { name: "Client One" } };
const agencyAnswer = (failing?: (q: Query) => boolean) => (q: Query): Answer => {
  if (q.table === "agency_organizations") return { rows: [AGENCY_ORG] };
  const base = baseAnswer(q);
  return failing?.(q) ? { ...base, failOnPage: 2 } : base;
};

test("Agency: the direct getCommunicationMetrics call gets complete counts - failed and undelivered sends past row 1,000 make the organization need attention", async () => {
  const { supabase } = fakeSupabase(agencyAnswer());
  const snapshots = await getAgencyOrganizationSnapshots(supabase, supabase);
  assert.ok(snapshots.ok);
  const [org] = snapshots.organizations;
  assert.deepEqual([org.messagesByStatus.failed, org.messagesByStatus.undelivered, org.communicationFailed], [100, 50, false]);
  const health = await getAgencyHealth(supabase, supabase);
  assert.ok(health.ok);
  const [orgHealth] = health.organizations;
  assert.deepEqual([orgHealth.failedMessages, orgHealth.undeliveredMessages, orgHealth.communicationUnavailable, orgHealth.needsAttention], [100, 50, false, true]);
});

test("Agency: a genuine zero stays healthy; an unreadable message read is disclosed (partialData, usage note) and fails closed - never a healthy zero", async () => {
  // Genuine zero: no messages at all.
  const quiet = fakeSupabase((q) => (q.table === "agency_organizations" ? { rows: [AGENCY_ORG] } : {}));
  const quietHealth = await getAgencyHealth(quiet.supabase, quiet.supabase);
  assert.ok(quietHealth.ok);
  assert.deepEqual([quietHealth.organizations[0].communicationUnavailable, quietHealth.organizations[0].needsAttention, quietHealth.partialData], [false, false, false]);

  // Unreadable: the message read fails on page 2.
  const broken = fakeSupabase(agencyAnswer(isMessages));
  const health = await getAgencyHealth(broken.supabase, broken.supabase);
  assert.ok(health.ok);
  const [orgHealth] = health.organizations;
  assert.deepEqual([orgHealth.failedMessages, orgHealth.communicationUnavailable, orgHealth.needsAttention, health.partialData], [0, true, true, true]);
  const usage = await getAgencyUsageSummary(broken.supabase, broken.supabase);
  assert.ok(usage.ok);
  assert.equal(usage.clients[0].dataQuality.partialData, true);
  assert.ok(usage.clients[0].dataQuality.notes.includes("Message counts temporarily unavailable."));
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("guards: the affected reads use readAllPages with a stable order and no cap; partialData inputs are byte-identical to main", () => {
  const body = (file: string, fn: string) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const start = source.indexOf(`async function ${fn}(`);
    return source.slice(start, source.indexOf("\n}\n", start));
  };
  for (const [file, fn] of [["lib/bi/queries.ts", "getCommunicationMetrics"], ["lib/bi/metrics.ts", "getOptOutCount"]]) {
    const code = body(file, fn);
    assert.match(code, /readAllPages</, fn);
    assert.doesNotMatch(code, /\.limit\(/, fn);
    assert.match(code, /\.order\("id"\)/, fn);
  }
  const partialData = (source: string) => source.slice(source.indexOf("const partialDataSourceCount"), source.indexOf(".length;", source.indexOf("const partialDataSourceCount")));
  const main = execFileSync("git", ["show", "4e806726f008ac47176c4650a158e2e1a325bc58:lib/bi/metrics.ts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(partialData(fs.readFileSync(path.join(ROOT, "lib/bi/metrics.ts"), "utf8")), partialData(main));
  void resolveDateRange;
});
