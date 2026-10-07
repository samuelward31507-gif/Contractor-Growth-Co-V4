/**
 * Phase 2-3: getDecisionContext - the batched reads behind "who acts".
 * A recording fake client proves the read pattern (which reads, how many,
 * batched by id, never per item) and the resolved eligibility for every
 * organization, automation, AI-settings and business-hours state.
 *
 * Offline: no network, no database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/decisions/context.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { getDecisionContext }: typeof import("./context") = require(path.join(ROOT, "lib/decisions/context.ts"));

type AttentionItem = import("@/lib/dashboard/queries").AttentionItem;
type Read = { table: string; select?: string; filters: [string, string, unknown][]; inIds?: unknown[]; order?: [string, unknown]; limit?: [number, unknown] };
type Result = { data: unknown; error: { message: string } | null };

// Saturday 2026-10-03, 15:00 UTC.
const NOW = Date.parse("2026-10-03T15:00:00.000Z");
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const LIVE_ORG = { automation_mode: "live", payment_status: "active", automation_paused: false };

// A table's result may depend on the query (e.g. the two different conversations reads).
type ResultFor = Result | ((read: Read) => Result);

function fakeClient(results: Partial<Record<string, ResultFor>> = {}) {
  const reads: Read[] = [];
  const client = {
    from(table: string) {
      const read: Read = { table, filters: [] };
      reads.push(read);
      const resolveResult = (): Result => {
        const configured = results[table];
        if (typeof configured === "function") return configured(read);
        return configured ?? { data: table === "organizations" ? LIVE_ORG : [], error: null };
      };
      const builder: Record<string, unknown> = {
        select: (columns: string) => ((read.select = columns), builder),
        eq: (column: string, value: unknown) => (read.filters.push(["eq", column, value]), builder),
        not: (column: string, operator: string, value: unknown) => (read.filters.push(["not", column, [operator, value]]), builder),
        in: (column: string, values: unknown[]) => ((read.inIds = values), read.filters.push(["in", column, values]), builder),
        // Phase 3 (W1): the waiting-conversation read filters its embedded messages to evidence (inbound + successful outbound).
        or: (filter: string, options: { referencedTable?: string } = {}) => (read.filters.push(["or", options.referencedTable ?? "", filter]), builder),
        order: (column: string, options: unknown) => ((read.order = [column, options]), builder),
        limit: (count: number, options: unknown) => ((read.limit = [count, options]), builder),
        // readAllPages: one page holding every row (rows < page size ends paging).
        range: () => Promise.resolve(resolveResult()),
        maybeSingle: () => Promise.resolve(resolveResult()),
        then: (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(resolveResult()).then(resolve, reject),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, reads, tables: () => reads.map((r) => r.table) };
}

const waitingItem = (conversationId: string): AttentionItem => ({ id: `reply-${conversationId}`, kind: "awaiting_reply", title: "Ann", detail: "Waiting", value: null, href: `/conversations/${conversationId}`, conversationId });
const other: AttentionItem = { id: "apt-1", kind: "overdue_appointment", title: "Bo", detail: "Was scheduled", value: null, href: "/appointments/apt-1" };

// The organization, automation_settings and open-opportunities reads are request-memoized and shared with
// Today's page and getPrioritizedOpportunities - in a real request none of them is an extra read.
const SHARED_READS = ["automation_settings", "opportunities", "organizations"];

test("no waiting conversation and no pending estimate: only the shared reads - no AI settings, conversations or business-hours read", async () => {
  const fake = fakeClient();
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: [other], timeZone: "UTC", now: NOW });
  assert.deepEqual(fake.tables().sort(), SHARED_READS);
  assert.equal(context.waitingCapReached, false);
  assert.equal(context.waitingConversations.size, 0);
});

test("waiting conversations: ONE batched conversations read by id, newest 20 messages per conversation - never one read per item", async () => {
  const fake = fakeClient({
    ai_settings: { data: { ai_enabled: true }, error: null },
    conversations: {
      data: [
        { id: "conv-1", ai_enabled: true, contact: { sms_opt_out: false }, messages: [{ created_at: ago(2 * MIN), direction: "inbound" }, { created_at: ago(9 * MIN), direction: "inbound" }, { created_at: ago(30 * MIN), direction: "outbound" }] },
        { id: "conv-2", ai_enabled: false, contact: [{ sms_opt_out: true }], messages: [{ created_at: ago(MIN), direction: "inbound" }] },
        { id: "conv-3", ai_enabled: true, contact: null, messages: [] },
      ],
      error: null,
    },
  });
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: [waitingItem("conv-1"), waitingItem("conv-2"), waitingItem("conv-3"), other, waitingItem("conv-1")], timeZone: "UTC", now: NOW });
  const conversationReads = fake.reads.filter((r) => r.table === "conversations");
  assert.equal(conversationReads.length, 1, "one batched read");
  assert.deepEqual(conversationReads[0].inIds, ["conv-1", "conv-2", "conv-3"], "every waiting conversation, de-duplicated");
  assert.deepEqual(conversationReads[0].filters[0], ["eq", "organization_id", "org-1"]);
  // Phase 3 (W1): the embedded messages carry status and are filtered to evidence - only a successful outbound ends a wait.
  assert.match(conversationReads[0].select!, /ai_enabled, contact:contacts\(sms_opt_out\), messages\(created_at, direction, status\)/);
  assert.ok(conversationReads[0].filters.some(([op, table, filter]) => op === "or" && table === "messages" && filter === "direction.eq.inbound,and(direction.eq.outbound,status.in.(sent,delivered))"));
  assert.deepEqual(conversationReads[0].order, ["created_at", { referencedTable: "messages", ascending: false }]);
  assert.deepEqual(conversationReads[0].limit, [20, { referencedTable: "messages" }]);
  assert.equal(fake.reads.filter((r) => r.table === "ai_settings").length, 1);
  assert.deepEqual(context.waitingConversations.get("conv-1"), { aiEnabled: true, smsOptOut: false, firstUnansweredInboundAt: ago(9 * MIN) });
  assert.deepEqual(context.waitingConversations.get("conv-2"), { aiEnabled: false, smsOptOut: true, firstUnansweredInboundAt: ago(MIN) });
  assert.deepEqual(context.waitingConversations.get("conv-3"), { aiEnabled: true, smsOptOut: true, firstUnansweredInboundAt: null }, "no contact row: treated as unreachable");
  assert.equal(context.aiSettingsEnabled, true);
});

// Batch 3 consistency fix (supersedes C5 / Phase 2-11 G3's cap rule): the number of waiting conversations never
// decides who replies. Five (or more) waiting conversations are each graded on their own state - one batched read,
// one AI-settings read - so Today, Person and Inbox give one conversation the same actor
// (lib/decisions/actor-consistency.test.ts proves the cross-surface invariant end to end).
test("Batch 3: 5 waiting conversations no longer trip a cap - every one is graded on its own state; one batched conversations read, one AI settings read", async () => {
  const fake = fakeClient({ ai_settings: { data: { ai_enabled: true }, error: null } });
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: ["a", "b", "c", "d", "e"].map(waitingItem), timeZone: "UTC", now: NOW });
  assert.equal(context.waitingCapReached, false, "list size never forces the contractor");
  assert.deepEqual(fake.tables().sort(), [...SHARED_READS, "ai_settings", "conversations"].sort());
  const [read] = fake.reads.filter((r) => r.table === "conversations");
  assert.deepEqual(read.inIds, ["a", "b", "c", "d", "e"]);
  assert.equal(fake.reads.filter((r) => r.table === "ai_settings").length, 1);
  assert.equal(context.aiSettingsEnabled, true);
});

test("a failed conversations read leaves no conversation state - every waiting item stays human", async () => {
  const fake = fakeClient({ ai_settings: { data: { ai_enabled: true }, error: null }, conversations: { data: null, error: { message: "boom" } } });
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: [waitingItem("conv-1")], timeZone: "UTC", now: NOW });
  assert.equal(context.waitingConversations.size, 0);
});

test("organization eligibility: only live + active + not paused; every payment state, test mode, pause, a missing row and a read error fail closed", async () => {
  const cases: [string, Result, boolean][] = [
    ["live, active, not paused", { data: LIVE_ORG, error: null }, true],
    ["test mode", { data: { ...LIVE_ORG, automation_mode: "test" }, error: null }, false],
    ["payment_required", { data: { ...LIVE_ORG, payment_status: "payment_required" }, error: null }, false],
    ["suspended", { data: { ...LIVE_ORG, payment_status: "suspended" }, error: null }, false],
    ["cancelled", { data: { ...LIVE_ORG, payment_status: "cancelled" }, error: null }, false],
    ["automation_paused", { data: { ...LIVE_ORG, automation_paused: true }, error: null }, false],
    ["no row", { data: null, error: null }, false],
    ["read error", { data: LIVE_ORG, error: { message: "boom" } }, false],
  ];
  for (const [label, organizations, expected] of cases) {
    const context = await getDecisionContext(fakeClient({ organizations }).client, "org-1", { attentionItems: [], timeZone: "UTC", now: NOW });
    assert.equal(context.organizationEligible, expected, label);
  }
});

test("automations: an explicit row wins; no row falls back to the catalog default (both inbound-customer-reply and estimate-followup default on)", async () => {
  const none = await getDecisionContext(fakeClient().client, "org-1", { attentionItems: [], timeZone: "UTC", now: NOW });
  assert.deepEqual([none.inboundReplyEnabled, none.estimateFollowupEnabled], [true, true]);
  const disabled = await getDecisionContext(
    fakeClient({ automation_settings: { data: [{ automation_id: "inbound-customer-reply", enabled: false, config: {} }, { automation_id: "estimate-followup", enabled: false, config: {} }], error: null } }).client,
    "org-1",
    { attentionItems: [], timeZone: "UTC", now: NOW },
  );
  assert.deepEqual([disabled.inboundReplyEnabled, disabled.estimateFollowupEnabled], [false, false]);
});

test("organization AI: no ai_settings row means off (matching getAiSettings and the n8n callback)", async () => {
  const fake = fakeClient({ ai_settings: { data: null, error: null }, conversations: { data: [], error: null } });
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: [waitingItem("conv-1")], timeZone: "UTC", now: NOW });
  assert.equal(context.aiSettingsEnabled, false);
});

test("business hours: read once, only when inbound-customer-reply respects them, judged by the outbound gate's own isWithinBusinessHours in the org's timezone", async () => {
  const respecting = { data: [{ automation_id: "inbound-customer-reply", enabled: true, config: { respect_business_hours: true } }], error: null };
  const base = { automation_settings: respecting, ai_settings: { data: { ai_enabled: true }, error: null }, conversations: { data: [], error: null } };

  const closedSaturday = fakeClient({ ...base, business_hours: { data: [{ day_of_week: "saturday", is_open: false, open_time: null, close_time: null }], error: null } });
  const closed = await getDecisionContext(closedSaturday.client, "org-1", { attentionItems: [waitingItem("conv-1")], timeZone: "UTC", now: NOW });
  assert.equal(closed.inboundReplyWithinHours, false);
  assert.equal(closedSaturday.reads.filter((r) => r.table === "business_hours").length, 1);

  const openSaturday = fakeClient({ ...base, business_hours: { data: [{ day_of_week: "saturday", is_open: true, open_time: "09:00", close_time: "17:00" }], error: null } });
  assert.equal((await getDecisionContext(openSaturday.client, "org-1", { attentionItems: [waitingItem("conv-1")], timeZone: "UTC", now: NOW })).inboundReplyWithinHours, true);

  const notRespecting = fakeClient({ ai_settings: { data: { ai_enabled: true }, error: null }, conversations: { data: [], error: null } });
  const ctx = await getDecisionContext(notRespecting.client, "org-1", { attentionItems: [waitingItem("conv-1")], timeZone: "UTC", now: NOW });
  assert.equal(ctx.inboundReplyWithinHours, true);
  assert.equal(notRespecting.reads.filter((r) => r.table === "business_hours").length, 0, "no read when the automation ignores business hours");
});

test("structure: the shared org/settings reads are request-memoized and getPrioritizedOpportunities uses them - no duplicate reads in a Today request", () => {
  const context = fs.readFileSync(path.join(ROOT, "lib/decisions/context.ts"), "utf8");
  assert.match(context, /export const getOrganizationAutomationState = cache\(/);
  assert.match(context, /export const getOrganizationAutomationSettings = cache\(/);
  assert.match(context, /import \{ isWithinBusinessHours \} from "@\/lib\/automation\/outbound-gate";/, "reuses the gate's business-hours rule");
  const intelligence = fs.readFileSync(path.join(ROOT, "lib/opportunities/intelligence.ts"), "utf8");
  assert.match(intelligence, /getOrganizationAutomationSettings\(supabase, organizationId\)/);
  assert.match(intelligence, /getOrganizationAutomationState\(supabase, organizationId\)/);
  assert.doesNotMatch(intelligence, /\.from\("organizations"\)|getAutomationEnabledMap\(/, "no second, unshared org or settings read");
});

// ---------------------------------------------------------------------------
// Phase 2-4a (K2, K6a): pending-estimate contacts whose open SMS conversation has AI off.
// ---------------------------------------------------------------------------

const opportunityRow = (id: string, type: string, contactId: string | null) => ({
  id, type, status: "open", source_entity_type: "lead", source_entity_id: `lead-${id}`, contact_id: contactId, title: "T", description: null,
  estimated_value: null, value_basis: null, created_at: ago(MIN), updated_at: ago(MIN), resolved_at: null, resolution_reason: null, metadata: {},
});
const isAiOffRead = (read: Read) => read.table === "conversations" && read.filters.some(([op, column, value]) => op === "eq" && column === "ai_enabled" && value === false);

test("pending estimates: ONE paged read of the org's AI-off open SMS conversations, intersected with the pending-estimate contacts - no id list, no per-estimate read", async () => {
  const fake = fakeClient({
    opportunities: { data: [opportunityRow("o1", "pending_estimate", "c1"), opportunityRow("o2", "pending_estimate", "c2"), opportunityRow("o3", "invoice_overdue", "c3"), opportunityRow("o4", "pending_estimate", null)], error: null },
    conversations: (read) => (isAiOffRead(read) ? { data: [{ contact_id: "c1" }, { contact_id: "c3" }, { contact_id: "c9" }], error: null } : { data: [], error: null }),
  });
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: [], timeZone: "UTC", now: NOW });
  assert.deepEqual([...context.estimateContactAiDisabled], ["c1"], "only pending-estimate contacts; c3 (not an estimate) and c9 (no opportunity) are ignored");
  const aiOffReads = fake.reads.filter(isAiOffRead);
  assert.equal(aiOffReads.length, 1, "one read");
  assert.deepEqual(aiOffReads[0].filters, [["eq", "organization_id", "org-1"], ["eq", "status", "open"], ["eq", "channel", "sms"], ["eq", "ai_enabled", false], ["not", "contact_id", ["is", null]]]);
  assert.equal(aiOffReads[0].inIds, undefined, "never an id list");
  assert.equal(fake.reads.filter((r) => r.table === "opportunities").length, 1, "the shared open-opportunities read, once");
});

test("no pending estimate: the AI-off conversation read is skipped entirely", async () => {
  const fake = fakeClient({ opportunities: { data: [opportunityRow("o3", "invoice_overdue", "c3")], error: null } });
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: [], timeZone: "UTC", now: NOW });
  assert.equal(fake.reads.filter((r) => r.table === "conversations").length, 0);
  assert.equal(context.estimateContactAiDisabled.size, 0);
});

test("a failed AI-off conversation read fails closed: every pending-estimate contact is treated as unreachable", async () => {
  const fake = fakeClient({
    opportunities: { data: [opportunityRow("o1", "pending_estimate", "c1"), opportunityRow("o2", "pending_estimate", "c2")], error: null },
    conversations: { data: null, error: { message: "boom" } },
  });
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: [], timeZone: "UTC", now: NOW });
  assert.deepEqual([...context.estimateContactAiDisabled].sort(), ["c1", "c2"]);
});

test("structure: the open-opportunities read is request-memoized and shared - the context adds no opportunities read of its own", () => {
  const queries = fs.readFileSync(path.join(ROOT, "lib/opportunities/queries.ts"), "utf8");
  assert.match(queries, /export const getOpenOpportunitiesResult = cache\(async \(supabase: SupabaseClient, organizationId: string\)/);
  const context = fs.readFileSync(path.join(ROOT, "lib/decisions/context.ts"), "utf8");
  assert.match(context, /await getOpenOpportunitiesResult\(supabase, organizationId\)/);
  assert.doesNotMatch(context, /\.from\("opportunities"\)/);
});

// ---------------------------------------------------------------------------
// Phase 2-11 (G4): the latest successful outbound message per contact - read
// only when a pending estimate is 72h or more old; one paged read, no id list.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * MIN;
const estimateRow = (id: string, contactId: string | null, sentMsAgo: number | null) => ({ ...opportunityRow(id, "pending_estimate", contactId), metadata: sentMsAgo === null ? {} : { sent_at: ago(sentMsAgo) } });
const isOutboundRead = (read: Read) => read.table === "conversations" && read.filters.some(([op, column, value]) => op === "eq" && column === "messages.direction" && value === "outbound");

test("2-11 (G4): with a pending estimate 72h or older, ONE paged read of conversations holding a successful outbound message, newest embedded - the latest per contact, no id list", async () => {
  const fake = fakeClient({
    opportunities: { data: [estimateRow("o1", "c1", 80 * HOUR_MS), estimateRow("o2", "c2", 10 * HOUR_MS)], error: null },
    conversations: (read) =>
      isOutboundRead(read)
        ? { data: [{ contact_id: "c1", messages: [{ created_at: ago(5 * HOUR_MS) }] }, { contact_id: "c1", messages: [{ created_at: ago(2 * HOUR_MS) }] }, { contact_id: "c9", messages: [{ created_at: ago(HOUR_MS) }] }], error: null }
        : { data: [], error: null },
  });
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: [], timeZone: "UTC", now: NOW });
  assert.deepEqual([...(context.latestOutboundMsByContact ?? new Map())].sort(), [["c1", NOW - 2 * HOUR_MS], ["c9", NOW - HOUR_MS]]);
  const reads = fake.reads.filter(isOutboundRead);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].select, "contact_id, messages!inner(created_at)");
  assert.deepEqual(reads[0].filters, [["eq", "organization_id", "org-1"], ["not", "contact_id", ["is", null]], ["eq", "messages.organization_id", "org-1"], ["eq", "messages.direction", "outbound"], ["in", "messages.status", ["sent", "delivered"]]]);
  assert.deepEqual(reads[0].limit, [1, { referencedTable: "messages" }]);
  assert.equal(fake.reads.filter((r) => r.table === "opportunities").length, 1, "the shared open-opportunities read, once");
});

test("2-11 (G4): no pending estimate 72h or older (or none with a sent_at) - the outbound read is skipped", async () => {
  const fake = fakeClient({ opportunities: { data: [estimateRow("o1", "c1", 71 * HOUR_MS), estimateRow("o2", "c2", null), opportunityRow("o3", "invoice_overdue", "c3")], error: null } });
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: [], timeZone: "UTC", now: NOW });
  assert.equal(fake.reads.filter(isOutboundRead).length, 0);
  assert.equal(context.latestOutboundMsByContact?.size, 0);
});

test("2-11 (G4): a failed outbound read is null - unknown, so no estimate is labelled a missed follow-up", async () => {
  const fake = fakeClient({
    opportunities: { data: [estimateRow("o1", "c1", 80 * HOUR_MS)], error: null },
    conversations: (read) => (isOutboundRead(read) ? { data: null, error: { message: "boom" } } : { data: [], error: null }),
  });
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: [], timeZone: "UTC", now: NOW });
  assert.equal(context.latestOutboundMsByContact, null);
});

// ---------------------------------------------------------------------------
// Phase 2-13 (R-d): the organization's configured estimate follow-up window
// ---------------------------------------------------------------------------

const followupSettings = (config: unknown) => ({ automation_settings: { data: [{ automation_id: "estimate-followup", enabled: true, config }], error: null } });

test("R-d: the window is the configured followup_2_hours; no row, an invalid config or followup_2 <= followup_1 fall back to the automation's 72h default", async () => {
  const windowFor = async (results: Parameters<typeof fakeClient>[0]) => (await getDecisionContext(fakeClient(results).client, "org-1", { attentionItems: [], timeZone: "UTC", now: NOW })).estimateFollowupWindowMs;
  assert.equal(await windowFor({}), 72 * HOUR_MS, "no row");
  assert.equal(await windowFor(followupSettings({ followup_1_hours: 6, followup_2_hours: 30 })), 30 * HOUR_MS);
  assert.equal(await windowFor(followupSettings({ followup_1_hours: 48, followup_2_hours: 120 })), 120 * HOUR_MS);
  assert.equal(await windowFor(followupSettings({ followup_1_hours: 48, followup_2_hours: 24 })), 72 * HOUR_MS, "followup_2 must be after followup_1");
  assert.equal(await windowFor(followupSettings({ followup_1_hours: 0, followup_2_hours: 900 })), 72 * HOUR_MS, "out of range");
  assert.equal(await windowFor(followupSettings(null)), 72 * HOUR_MS, "null config");
});

test("R-d: the outbound read follows the configured window - a 30h window reads at 31h; a 120h window skips at 80h", async () => {
  const outboundReads = async (config: unknown, sentMsAgo: number) => {
    const fake = fakeClient({ ...followupSettings(config), opportunities: { data: [estimateRow("o1", "c1", sentMsAgo)], error: null } });
    await getDecisionContext(fake.client, "org-1", { attentionItems: [], timeZone: "UTC", now: NOW });
    return fake.reads.filter(isOutboundRead).length;
  };
  assert.equal(await outboundReads({ followup_1_hours: 6, followup_2_hours: 30 }, 31 * HOUR_MS), 1);
  assert.equal(await outboundReads({ followup_1_hours: 6, followup_2_hours: 30 }, 29 * HOUR_MS), 0);
  assert.equal(await outboundReads({ followup_1_hours: 48, followup_2_hours: 120 }, 80 * HOUR_MS), 0);
  assert.equal(await outboundReads({ followup_1_hours: 48, followup_2_hours: 120 }, 121 * HOUR_MS), 1);
});
