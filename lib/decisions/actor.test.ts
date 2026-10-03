/**
 * Phase 2-3: who acts - the actor rules (C1-C3, C5-C7) and the corrected
 * B4 eligibility, as pure functions over a hand-built DecisionContext.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/decisions/actor.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const actor: typeof import("./actor") = require(path.join(ROOT, "lib/decisions/actor.ts"));
const { CONVERSATION_ATTENTION_CAP }: typeof import("@/app/(app)/today/_components/dashboard-model") = require(path.join(ROOT, "app/(app)/today/_components/dashboard-model.ts"));

type DecisionContext = import("./actor").DecisionContext;
type Opportunity = import("@/lib/opportunities/queries").Opportunity;
type OpportunityType = import("@/lib/opportunities/queries").OpportunityType;

const NOW = Date.parse("2026-10-03T15:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const conversation = (overrides: Partial<import("./actor").WaitingConversationState> = {}) => ({ aiEnabled: true, smsOptOut: false, firstUnansweredInboundAt: ago(5 * MIN), ...overrides });
const context = (overrides: Partial<DecisionContext> = {}, conv = conversation()): DecisionContext => ({
  now: NOW,
  organizationEligible: true,
  aiSettingsEnabled: true,
  inboundReplyEnabled: true,
  estimateFollowupEnabled: true,
  inboundReplyWithinHours: true,
  waitingCapReached: false,
  waitingConversations: new Map([["conv-1", conv]]),
  ...overrides,
});
const waiting = { kind: "awaiting_reply" as const, conversationId: "conv-1" };

test("the cap the actor rule honours is the same cap Today discloses (SQL rn <= 5)", () => {
  assert.equal(actor.WAITING_REPLY_CAP, CONVERSATION_ATTENTION_CAP);
  assert.equal(actor.AI_REPLY_GRACE_MS, 15 * MIN);
  assert.equal(actor.ESTIMATE_FOLLOWUP_WINDOW_MS, 72 * HOUR);
});

test("firstUnansweredInboundAt: the oldest inbound in the unbroken inbound run at the top (C3); any outbound - AI, staff or a customer-facing system send - ends the run", () => {
  const msg = (minutesAgo: number, direction: "inbound" | "outbound") => ({ created_at: ago(minutesAgo * MIN), direction });
  assert.equal(actor.firstUnansweredInboundAt([msg(1, "inbound"), msg(3, "inbound"), msg(9, "inbound"), msg(20, "outbound"), msg(30, "inbound")]), ago(9 * MIN), "first unanswered, not the latest");
  assert.equal(actor.firstUnansweredInboundAt([msg(1, "outbound"), msg(3, "inbound")]), null, "already answered");
  assert.equal(actor.firstUnansweredInboundAt([]), null);
  assert.equal(actor.firstUnansweredInboundAt([msg(1, "inbound"), msg(2, "inbound")]), ago(2 * MIN), "all inbound: the oldest read is the best known start");
});

test("waiting for reply: Trackpr inside the 15-minute grace period when the AI can answer; human from exactly 15:00", () => {
  assert.equal(actor.resolveSignalActor(waiting, context({}, conversation({ firstUnansweredInboundAt: ago(0) }))), "trackpr");
  assert.equal(actor.resolveSignalActor(waiting, context({}, conversation({ firstUnansweredInboundAt: ago(15 * MIN - 1) }))), "trackpr", "14:59.999");
  assert.equal(actor.resolveSignalActor(waiting, context({}, conversation({ firstUnansweredInboundAt: ago(15 * MIN) }))), "human", "15:00.000");
  assert.equal(actor.resolveSignalActor(waiting, context({}, conversation({ firstUnansweredInboundAt: ago(3 * HOUR) }))), "human");
});

test("B4 corrected (C2): any one failing condition makes a waiting conversation human immediately, even inside the grace period", () => {
  const cases: [string, DecisionContext][] = [
    ["conversation AI off (staff took over / AI handed off)", context({}, conversation({ aiEnabled: false }))],
    ["organization AI off (no ai_settings row counts as off)", context({ aiSettingsEnabled: false })],
    ["inbound-customer-reply disabled", context({ inboundReplyEnabled: false })],
    ["organization not live / unpaid / paused", context({ organizationEligible: false })],
    ["contact opted out", context({}, conversation({ smsOptOut: true }))],
    ["outside business hours while the automation respects them", context({ inboundReplyWithinHours: false })],
  ];
  for (const [label, ctx] of cases) {
    assert.equal(actor.aiReplyEligible(ctx.waitingConversations.get("conv-1")!, ctx), false, label);
    assert.equal(actor.resolveSignalActor(waiting, ctx), "human", label);
  }
  assert.equal(actor.aiReplyEligible(conversation(), context()), true, "all conditions met");
});

test("C5: when the SQL cap of 5 waiting conversations is reached, every waiting conversation is human - the grace period never hides older waits", () => {
  assert.equal(actor.resolveSignalActor(waiting, context({ waitingCapReached: true })), "human");
});

test("a waiting item with no conversation id, no loaded state, or no unanswered inbound is human", () => {
  assert.equal(actor.resolveSignalActor({ kind: "awaiting_reply", conversationId: undefined }, context()), "human");
  assert.equal(actor.resolveSignalActor({ kind: "awaiting_reply", conversationId: "conv-unknown" }, context()), "human");
  assert.equal(actor.resolveSignalActor(waiting, context({}, conversation({ firstUnansweredInboundAt: null }))), "human");
});

test("every other signal kind is always human, whatever the context", () => {
  for (const kind of ["overdue_appointment", "awaiting_confirmation", "abandoned_conversation"] as const) assert.equal(actor.resolveSignalActor({ kind, conversationId: "conv-1" }, context()), "human", kind);
});

const opp = (type: OpportunityType, metadata: Record<string, unknown> = {}): Opportunity => ({
  id: "o1", type, status: "open", sourceEntityType: "estimate", sourceEntityId: "est-1", contactId: "c1", title: "Ann", description: null,
  estimatedValue: null, valueBasis: null, createdAt: ago(HOUR), updatedAt: ago(HOUR), resolvedAt: null, resolutionReason: null, metadata,
});
// An options object, not default parameters: a default parameter would turn an explicit `undefined` opt-out back into `false`.
const pending = (o: { metadata?: Record<string, unknown>; phone?: string | null; optOut?: boolean | null | "absent" } = {}) => {
  const item: { opportunity: Opportunity; contactPhone: string | null; contactSmsOptOut?: boolean | null } = { opportunity: opp("pending_estimate", o.metadata ?? { sent_at: ago(30 * HOUR) }), contactPhone: "phone" in o ? (o.phone ?? null) : "+15125550100" };
  if (o.optOut !== "absent") item.contactSmsOptOut = o.optOut === undefined ? false : o.optOut;
  return item;
};

test("pending estimate (C7): Trackpr while estimate follow-up still has a touch to send - under 72h since sending; human from exactly 72h", () => {
  assert.equal(actor.resolveOpportunityActor(pending({ metadata: { sent_at: ago(1 * MIN) } }), context()), "trackpr");
  assert.equal(actor.resolveOpportunityActor(pending({ metadata: { sent_at: ago(72 * HOUR - 1) } }), context()), "trackpr", "71:59:59.999");
  assert.equal(actor.resolveOpportunityActor(pending({ metadata: { sent_at: ago(72 * HOUR) } }), context()), "human", "72:00:00.000");
});

test("pending estimate is human whenever Trackpr cannot send the follow-up", () => {
  const cases: [string, Parameters<typeof actor.resolveOpportunityActor>[0], DecisionContext][] = [
    ["organization ineligible", pending(), context({ organizationEligible: false })],
    ["estimate follow-up disabled", pending(), context({ estimateFollowupEnabled: false })],
    ["no phone", pending({ phone: null }), context()],
    ["phone not E.164", pending({ phone: "555-0100" }), context()],
    ["contact opted out", pending({ optOut: true }), context()],
    ["opt-out unknown (no contact row)", pending({ optOut: null }), context()],
    ["opt-out unknown (field absent)", pending({ optOut: "absent" }), context()],
    ["no sent_at", pending({ metadata: {} }), context()],
    ["unparseable sent_at", pending({ metadata: { sent_at: "not a date" } }), context()],
  ];
  for (const [label, item, ctx] of cases) assert.equal(actor.resolveOpportunityActor(item, ctx), "human", label);
});

test("every other opportunity type is human (C1, C6) - their automations are one-shot or absent, even when the org and every automation are eligible", () => {
  const types: OpportunityType[] = [
    "accepted_estimate_no_job", "completed_job_not_invoiced", "invoice_overdue", "qualified_lead_unbooked", "completed_appointment_no_estimate",
    "uncontacted_lead", "active_lead_signal", "no_show", "cancelled_appointment_no_rebooking", "stale_estimate", "dormant_customer",
    "completed_job_no_review_request", "completed_job_no_referral_request",
  ];
  for (const type of types) assert.equal(actor.resolveOpportunityActor({ opportunity: opp(type, { sent_at: ago(MIN) }), contactPhone: "+15125550100", contactSmsOptOut: false }, context()), "human", type);
});

test("the all-human default context makes everything human", () => {
  assert.equal(actor.resolveSignalActor(waiting, actor.ALL_HUMAN_CONTEXT), "human");
  assert.equal(actor.resolveOpportunityActor(pending(), actor.ALL_HUMAN_CONTEXT), "human");
});
