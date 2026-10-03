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

function fakeClient(results: Partial<Record<string, Result>> = {}) {
  const reads: Read[] = [];
  const client = {
    from(table: string) {
      const read: Read = { table, filters: [] };
      reads.push(read);
      const result = results[table] ?? { data: table === "organizations" ? LIVE_ORG : [], error: null };
      const builder: Record<string, unknown> = {
        select: (columns: string) => ((read.select = columns), builder),
        eq: (column: string, value: unknown) => (read.filters.push(["eq", column, value]), builder),
        in: (column: string, values: unknown[]) => ((read.inIds = values), read.filters.push(["in", column, values]), builder),
        order: (column: string, options: unknown) => ((read.order = [column, options]), builder),
        limit: (count: number, options: unknown) => ((read.limit = [count, options]), builder),
        maybeSingle: () => Promise.resolve(result),
        then: (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, reads, tables: () => reads.map((r) => r.table) };
}

const waitingItem = (conversationId: string): AttentionItem => ({ id: `reply-${conversationId}`, kind: "awaiting_reply", title: "Ann", detail: "Waiting", value: null, href: `/conversations/${conversationId}`, conversationId });
const other: AttentionItem = { id: "apt-1", kind: "overdue_appointment", title: "Bo", detail: "Was scheduled", value: null, href: "/appointments/apt-1" };

test("no waiting conversation: only the two shared org reads - no AI settings, conversations or business-hours read", async () => {
  const fake = fakeClient();
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: [other], timeZone: "UTC", now: NOW });
  assert.deepEqual(fake.tables().sort(), ["automation_settings", "organizations"]);
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
  assert.match(conversationReads[0].select!, /ai_enabled, contact:contacts\(sms_opt_out\), messages\(created_at, direction\)/);
  assert.deepEqual(conversationReads[0].order, ["created_at", { referencedTable: "messages", ascending: false }]);
  assert.deepEqual(conversationReads[0].limit, [20, { referencedTable: "messages" }]);
  assert.equal(fake.reads.filter((r) => r.table === "ai_settings").length, 1);
  assert.deepEqual(context.waitingConversations.get("conv-1"), { aiEnabled: true, smsOptOut: false, firstUnansweredInboundAt: ago(9 * MIN) });
  assert.deepEqual(context.waitingConversations.get("conv-2"), { aiEnabled: false, smsOptOut: true, firstUnansweredInboundAt: ago(MIN) });
  assert.deepEqual(context.waitingConversations.get("conv-3"), { aiEnabled: true, smsOptOut: true, firstUnansweredInboundAt: null }, "no contact row: treated as unreachable");
  assert.equal(context.aiSettingsEnabled, true);
});

test("C5: with 5 or more waiting conversations the cap is reached - no AI settings or conversations read, every one human", async () => {
  const fake = fakeClient();
  const context = await getDecisionContext(fake.client, "org-1", { attentionItems: ["a", "b", "c", "d", "e"].map(waitingItem), timeZone: "UTC", now: NOW });
  assert.equal(context.waitingCapReached, true);
  assert.deepEqual(fake.tables().sort(), ["automation_settings", "organizations"]);
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
