/**
 * Phase 2-1: getDashboardData's attentionItems is never cut to a list-wide
 * cap. Each kind stays bounded at 5 by its own builder / SQL function, but a
 * busy day (5 escalations + 5 awaiting replies + 5 stalled conversations)
 * used to push calendar_disconnected, overdue_appointment and
 * awaiting_confirmation - all read by Today - out of a 10-item slice.
 *
 * Exercises the real getDashboardData in the SQL mode Today uses
 * (getDashboardSqlData), against a hand-built client that answers each read
 * at the wire boundary. No network, no database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/dashboard/queries.no-truncation.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { getDashboardData }: typeof import("./queries") = require("./queries.ts");
const { getOperationalExceptions, getConversationSignals }: typeof import("@/lib/opportunities/intelligence") = require(path.join(process.cwd(), "lib/opportunities/intelligence.ts"));

type Result = { data: unknown; error: { message: string } | null };

const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const contact = { contact_first_name: "Pat", contact_last_name: null };

const ESCALATIONS = range(5).map((i) => ({ id: `inc-${i}`, status: "open", description: "Needs a human", metadata: { conversationId: `conv-esc-${i}` }, last_seen_at: iso(-i * HOUR) }));
const CONVERSATION_ROWS = [
  ...range(5).map((i) => ({ kind: "awaiting_reply", item_position: i, conversation_id: `conv-wait-${i}`, ...contact, last_activity_at: iso(-i * HOUR) })),
  ...range(5).map((i) => ({ kind: "abandoned_conversation", item_position: i, conversation_id: `conv-stall-${i}`, ...contact, last_activity_at: iso(-72 * HOUR) })),
];
const RECORD_ATTENTION = {
  overdue_appointments: range(5).map((i) => ({ id: `apt-over-${i}`, title: "Inspection", start_at: iso(-i * HOUR), ...contact })),
  awaiting_confirmation: range(5).map((i) => ({ id: `apt-conf-${i}`, title: "Inspection", confirmation_requested_at: iso(-i * HOUR), ...contact })),
  hot_leads: [],
  high_value_leads: [],
  pending_estimate_leads: [],
  uncontacted_dedup_lead_ids: [],
  recent_leads: [],
  recent_appointments: [],
  new_leads: 0,
  open_leads: 0,
  upcoming_appointments: 0,
  pending_estimates: 0,
  pipeline: { new: 0, contacted: 0, qualified: 0, appointment: 0, estimate: 0, won: 0 },
};
const CALENDAR_ERROR = { id: "cal-1", account_email: null, calendar_id: null, calendar_name: null, status: "error", last_synced_at: null, last_error: "Token expired" };
const opportunity = (id: string, type: string, sourceEntityId: string) => ({
  id, type, status: "open", source_entity_type: "job", source_entity_id: sourceEntityId, contact_id: null, title: "Pat", description: null,
  estimated_value: null, value_basis: null, created_at: iso(-HOUR), updated_at: iso(-HOUR), resolved_at: null, resolution_reason: null, metadata: {},
});
const OPPORTUNITIES = [opportunity("opp-review", "completed_job_no_review_request", "job-1"), opportunity("opp-referral", "completed_job_no_referral_request", "job-2")];

function busyDayClient(): SupabaseClient {
  const tables: Record<string, Result> = {
    audit_log: { data: [], error: null },
    automation_incidents: { data: ESCALATIONS, error: null },
    calendar_connections: { data: CALENDAR_ERROR, error: null },
    opportunities: { data: OPPORTUNITIES, error: null },
  };
  const rpcs: Record<string, Result> = {
    dashboard_conversation_attention: { data: CONVERSATION_ROWS, error: null },
    dashboard_record_attention: { data: RECORD_ATTENTION, error: null },
  };
  const builder = (result: Result) => {
    const b: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "not", "order"]) b[name] = () => b;
    b.limit = () => Promise.resolve(result);
    b.range = () => Promise.resolve(result);
    b.maybeSingle = () => Promise.resolve(result);
    return b;
  };
  return {
    from: (table: string) => builder(tables[table] ?? { data: [], error: null }),
    rpc: (name: string) => Promise.resolve(rpcs[name] ?? { data: null, error: { message: `unexpected rpc ${name}` } }),
  } as unknown as SupabaseClient;
}

const countByKind = (items: { kind: string }[]) => items.reduce<Record<string, number>>((acc, item) => ((acc[item.kind] = (acc[item.kind] ?? 0) + 1), acc), {});

test("a busy day keeps every kind: nothing past the first 10 rows is dropped", async () => {
  const data = await getDashboardData(busyDayClient(), "org-1", { conversationAttention: "sql", recordAttention: "sql" });
  assert.equal(data.partialData, false);
  assert.deepEqual(countByKind(data.attentionItems), {
    human_escalation: 5,
    awaiting_reply: 5,
    abandoned_conversation: 5,
    calendar_disconnected: 1,
    overdue_appointment: 5,
    awaiting_confirmation: 5,
    completed_job_no_review_request: 1,
    completed_job_no_referral_request: 1,
  });
  assert.equal(data.attentionItems.length, 28, "the true total, not a list-wide cap of 10");
});

test("Today's extractions see what the old cap hid: the calendar failure and every overdue / unconfirmed appointment", async () => {
  const data = await getDashboardData(busyDayClient(), "org-1", { conversationAttention: "sql", recordAttention: "sql" });
  const exceptions = getOperationalExceptions(data.attentionItems);
  assert.deepEqual(countByKind(exceptions), { human_escalation: 5, calendar_disconnected: 1 });
  const signals = getConversationSignals(data.attentionItems);
  assert.deepEqual(countByKind(signals), { awaiting_reply: 5, abandoned_conversation: 5, overdue_appointment: 5, awaiting_confirmation: 5 });
});

test("each kind is still bounded by its own builder - the per-kind caps of 5 are unchanged", async () => {
  const data = await getDashboardData(busyDayClient(), "org-1", { conversationAttention: "sql", recordAttention: "sql" });
  for (const [kind, count] of Object.entries(countByKind(data.attentionItems))) assert.ok(count <= 5, `${kind}: ${count}`);
});

test("no list-wide slice remains on the assembled attention list", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/dashboard/queries.ts"), "utf8");
  const start = source.indexOf("const attentionItems = [");
  const assembled = source.slice(start, source.indexOf("const leadActivity", start));
  assert.match(assembled, /\.\.\.completedJobNoReferralRequestOpportunities,/, "the window covers the assembled list");
  assert.doesNotMatch(assembled, /\]\.slice\(/);
});

test("Phase 2-12: a human_escalation item carries its incident's conversation id; without one it carries none", async () => {
  const data = await getDashboardData(busyDayClient(), "org-1", { conversationAttention: "sql", recordAttention: "sql" });
  const escalations = data.attentionItems.filter((item) => item.kind === "human_escalation");
  assert.deepEqual(escalations.map((item) => item.conversationId), range(5).map((i) => `conv-esc-${i}`));
  assert.ok(escalations.every((item) => item.href === `/conversations/${item.conversationId}`), "the link is unchanged");
  ESCALATIONS[0].metadata = {} as { conversationId: string };
  try {
    const without = await getDashboardData(busyDayClient(), "org-1", { conversationAttention: "sql", recordAttention: "sql" });
    const first = without.attentionItems.find((item) => item.id === "escalation-inc-1")!;
    assert.deepEqual([first.conversationId, first.href], [undefined, "/conversations"]);
  } finally {
    ESCALATIONS[0].metadata = { conversationId: "conv-esc-1" };
  }
});
