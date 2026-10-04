/**
 * Phase 2-2: assembleDecisions - frozen parity with Today's pre-2-2 output.
 * The expected rows below are written out by hand from the pre-2-2 rules
 * (today/page.tsx's priorityItemToQueueEntry and exception rows, at commit
 * 2cab730) for the shared fixture, and pin: queue ordering and ties, action
 * labels, action links and fallbacks, sentence construction, person links,
 * the Act II / Act III split, exception ordering, totalNeedingAttention,
 * signal keys and opportunity keys.
 *
 * Pure: no network, no database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/decisions/assemble.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { assembleDecisions }: typeof import("./assemble") = require(path.join(ROOT, "lib/decisions/assemble.ts"));
const { buildParityFixture }: typeof import("./assemble.fixture") = require(path.join(ROOT, "lib/decisions/assemble.fixture.ts"));

type Row = [key: string, reasonCode: string, act: string, tone: string, problemLabel: string, name: string, personHref: string, money: string | undefined, age: string | undefined, sentence: string, phone: string | null, actionLabel: string, actionHref: string];
const rowOf = (item: import("./types").DecisionItem): Row => [item.key, item.reasonCode, item.act, item.tone, item.problemLabel, item.subject.name, item.subject.href, item.money, item.age, item.sentence, item.phone, item.nextAction.label, item.nextAction.href];

const EXPECTED_EXCEPTIONS: Row[] = [
  ["inc-1", "human_escalation", "attention", "urgent", "Needs a human", "AI needs your attention", "/conversations/c-esc", undefined, undefined, "Customer asked for a person.", null, "Review", "/conversations/c-esc"],
  ["human_escalation-/conversations", "human_escalation", "attention", "urgent", "Needs a human", "AI needs your attention", "/conversations", undefined, undefined, "A conversation needs a human reply.", null, "Review", "/conversations"],
  ["calendar_disconnected-/settings", "calendar_sync_failed", "attention", "urgent", "Calendar disconnected", "Google Calendar sync failed", "/settings", undefined, undefined, "Token expired", null, "Review", "/settings"],
];

// Phase 2-11 (G5): the two uncontacted rows (o5, o4) now read "Missed follow-up · First contact" - every
// uncontacted lead is a missed first contact by definition. Nothing else in this frozen table changed.
const EXPECTED_ATTENTION: Row[] = [
  // needs_reply: signals only, all at value -0.5 - equal, so attention-list order holds.
  ["signal:awaiting_reply:0", "customer_awaiting_reply", "attention", "urgent", "Waiting on a reply", "Ann Lee", "/conversations/a", undefined, undefined, "Waiting for a reply 2 hours ago Reply to their message.", null, "Open conversation", "/conversations/a"],
  ["signal:awaiting_reply:1", "customer_awaiting_reply", "attention", "urgent", "Waiting on a reply", "Bo Chen", "/conversations/b", undefined, undefined, "Waiting for a reply 3 hours ago Reply to their message.", null, "Open conversation", "/conversations/b"],
  ["signal:overdue_appointment:3", "appointment_overdue", "attention", "urgent", "Appointment overdue", "Di Evans", "/appointments/apt-1", undefined, undefined, "Was scheduled yesterday Follow up.", null, "View", "/appointments/apt-1"],
  ["signal:awaiting_confirmation:4", "appointment_unconfirmed", "attention", "urgent", "Visit not confirmed", "Ed Fox", "/appointments/apt-2", undefined, undefined, "Confirmation requested 2 hours ago - no response yet Follow up.", null, "View", "/appointments/apt-2"],
  // committed_revenue_at_risk: known value descending, unknown last.
  ["opportunity:o1", "invoice_overdue", "attention", "urgent", "Invoice overdue", "Person o1", "/people/c1", "$3,000", "2 days ago", "INV-000004 was due 2026-07-23 - $3,000 still outstanding. Collect the payment.", "+15125550101", "View invoice", "/invoices/inv-4"],
  ["opportunity:o2", "estimate_accepted_no_job", "attention", "urgent", "Accepted, no job yet", "Person o2", "/people/c2", "$2,500", "3 days ago", 'Estimate "Roof" was accepted, but no job has been created yet. Create the job.', null, "View estimate", "/estimates/est-7"],
  ["opportunity:o3", "job_completed_not_invoiced", "attention", "urgent", "Completed, not invoiced", "Person o3", "/today?view=by-type#opportunities", undefined, "5 days ago", 'Completed job "Gutter" has not been invoiced yet. Value not yet entered Create the invoice.', null, "Create invoice", "/jobs/job-3"],
  // active_pursuit: known first, then the two unknowns oldest first; "monitor" and "call" add no phrase; an invalid phone still shows (pre-2-2 behavior).
  // Phase 2-4c (K4, the one approved change to this frozen table): a human-owned pending estimate's action is follow_up_estimate, so its sentence gains the existing phrase.
  ["opportunity:o6", "estimate_awaiting_decision", "attention", "soon", "Estimate sent, awaiting reply", "Person o6", "/people/c6", "$5,000", "3 days ago", 'Estimate "Deck" sent - awaiting the customer\'s decision. Follow up on the estimate.', null, "View estimate", "/estimates/est-9"],
  ["opportunity:o5", "lead_not_contacted", "attention", "soon", "Missed follow-up · First contact", "Person o5", "/people/c5", undefined, "5 days ago", "New lead from the website hasn't been contacted. Value not yet entered Flagged 5 days ago - still unresolved. Follow up.", "555-0105", "View lead", "/people/c5"],
  ["opportunity:o4", "lead_not_contacted", "attention", "soon", "Missed follow-up · First contact", "Person o4", "/people/c4", undefined, "2 days ago", "New lead from the website hasn't been contacted. Value not yet entered", "+15125550104", "View lead", "/people/c4"],
  // at_risk: known value, then the signal (-0.5), then the unknown/not-applicable opportunity (-1).
  ["opportunity:o7", "estimate_expired", "attention", "soon", "Estimate expired", "Person o7", "/people/c7", "$1,000", "3 days ago", 'Estimate "Siding" expired with no customer decision recorded. Follow up on the estimate.', null, "View estimate", "/estimates/est-8"],
  ["signal:abandoned_conversation:2", "conversation_stalled", "attention", "soon", "Conversation went quiet", "Cy Diaz", "/conversations/c", undefined, undefined, "No reply since we last reached out, 3 days ago Follow up.", null, "View", "/conversations/c"],
  ["opportunity:o8", "appointment_no_show", "attention", "soon", "Missed appointment", "Person o8", "/people/c8", undefined, "2 days ago", "Missed appointment - needs rescheduling. Reach out to get it rebooked.", null, "View schedule", "/schedule?view=list"],
];

const EXPECTED_OPPORTUNITIES: Row[] = [
  // recoverable before growth; within growth, known value first.
  ["opportunity:o11", "customer_dormant", "opportunity", "good", "Dormant customer", "Person o11", "/people/c11", undefined, "3 days ago", "No activity since their last completed job. Reach out to reconnect.", null, "View customer", "/people/c11"],
  ["opportunity:o9", "review_request_needed", "opportunity", "good", "Review request needed", "Person o9", "/people/c9", "$3,000", "2 days ago", 'Completed job "Roof" has no review request yet. Ask for a review.', null, "View job", "/jobs/job-1"],
  ["opportunity:o10", "referral_request_needed", "opportunity", "good", "Referral request needed", "Person o10", "/people/c9", undefined, "2 days ago", 'Completed job "Roof" has no referral request yet. Ask for a referral.', null, "View job", "/jobs/job-1"],
];

test("exceptions: attention-list order, keys from the incident id or kind + href, 'Review' to the item's own link", () => {
  const result = assembleDecisions(buildParityFixture());
  assert.deepEqual(result.exceptions.map(rowOf), EXPECTED_EXCEPTIONS);
  assert.ok(result.exceptions.every((item) => item.operational && item.tier === null && item.nextAction.code === null));
});

test("Act II: the exact pre-2-2 rows in the exact pre-2-2 order - ordering, ties, labels, links, sentences, person links, keys", () => {
  assert.deepEqual(assembleDecisions(buildParityFixture()).attention.map(rowOf), EXPECTED_ATTENTION);
});

test("Act III: recoverable and growth only, in priority order", () => {
  assert.deepEqual(assembleDecisions(buildParityFixture()).opportunities.map(rowOf), EXPECTED_OPPORTUNITIES);
});

test("totalNeedingAttention is exceptions + Act II - never Act III, never the ignored kinds", () => {
  const result = assembleDecisions(buildParityFixture());
  assert.equal(result.totalNeedingAttention, EXPECTED_EXCEPTIONS.length + EXPECTED_ATTENTION.length);
  assert.equal(result.totalNeedingAttention, 16);
  const allKeys = [...result.exceptions, ...result.attention, ...result.opportunities].map((item) => item.key);
  assert.ok(!allKeys.some((key) => key.includes("hot") || key.includes("legacy") || key.includes("opp-ns")), "hot_lead and the legacy no_show attention kind are not rendered");
});

test("the act split follows the tier exactly: recoverable/growth -> opportunity, every other tier -> attention", () => {
  const result = assembleDecisions(buildParityFixture());
  for (const item of result.attention) assert.ok(item.tier !== "recoverable" && item.tier !== "growth", item.key);
  for (const item of result.opportunities) assert.ok(item.tier === "recoverable" || item.tier === "growth", item.key);
});

test("input order is respected: the same fixture in a different opportunity order yields the same queue (buildPriorityQueue sorts), and signal ties keep attention-list order", () => {
  const fixture = buildParityFixture();
  const reversed = { ...fixture, prioritizedOpportunities: [...fixture.prioritizedOpportunities].reverse() };
  assert.deepEqual(assembleDecisions(reversed).attention.map(rowOf), EXPECTED_ATTENTION);
});

test("an empty day: no items, a zero count", () => {
  const result = assembleDecisions({ attentionItems: [], prioritizedOpportunities: [] });
  assert.deepEqual([result.exceptions.length, result.attention.length, result.opportunities.length, result.totalNeedingAttention], [0, 0, 0, 0]);
});

test("the assembler stays pure and synchronous: no awaits, no Supabase, no fetch", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib/decisions/assemble.ts"), "utf8");
  assert.doesNotMatch(source, /\bawait\b|async |supabase|fetch\(/i);
});

// ---------------------------------------------------------------------------
// Phase 2-3a: actor resolution. Every item carries an actor; in 2-3a it is
// computed but changes nothing else - Act II membership, order, rows and
// the count stay exactly the frozen pre-2-3 output above.
// ---------------------------------------------------------------------------

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function trackprCapableFixture(now: number) {
  const fixture = buildParityFixture(now);
  // conversation "a" waiting 5 minutes (inside the grace period); "b" waiting 40 minutes (past it)
  fixture.attentionItems = fixture.attentionItems.map((item) => (item.id === "reply-a" ? { ...item, conversationId: "conv-a" } : item.id === "reply-b" ? { ...item, conversationId: "conv-b" } : item));
  // o6 (pending estimate) sent 30h ago to a reachable, opted-in contact
  fixture.prioritizedOpportunities = fixture.prioritizedOpportunities.map((p) =>
    p.opportunity.id === "o6" ? { ...p, contactPhone: "+15125550106", contactSmsOptOut: false, opportunity: { ...p.opportunity, metadata: { ...p.opportunity.metadata, sent_at: new Date(now - 30 * HOUR).toISOString() } } } : p,
  );
  return fixture;
}

function eligibleContext(now: number): import("./actor").DecisionContext {
  return {
    now,
    organizationEligible: true,
    aiSettingsEnabled: true,
    inboundReplyEnabled: true,
    estimateFollowupEnabled: true,
    inboundReplyWithinHours: true,
    waitingCapReached: false,
    waitingConversations: new Map([
      ["conv-a", { aiEnabled: true, smsOptOut: false, firstUnansweredInboundAt: new Date(now - 5 * MIN).toISOString() }],
      ["conv-b", { aiEnabled: true, smsOptOut: false, firstUnansweredInboundAt: new Date(now - 40 * MIN).toISOString() }],
    ]),
    estimateContactAiDisabled: new Set(),
  };
}

test("2-3a: with no context every item is human - exceptions included", () => {
  const result = assembleDecisions(buildParityFixture());
  for (const item of [...result.exceptions, ...result.attention, ...result.opportunities]) assert.equal(item.actor, "human", item.key);
});

test("2-3a: the context sets actor per item - waiting reply inside the grace period and a pending estimate in its follow-up window are Trackpr; everything else human", () => {
  const now = Date.now();
  const result = assembleDecisions({ ...trackprCapableFixture(now), context: eligibleContext(now) });
  const all = [...result.exceptions, ...result.attention, ...result.trackprHandling, ...result.opportunities];
  const actorByKey = Object.fromEntries(all.map((item) => [item.key, item.actor]));
  assert.equal(actorByKey["signal:awaiting_reply:0"], "trackpr", "conv-a, 5 minutes");
  assert.equal(actorByKey["signal:awaiting_reply:1"], "human", "conv-b, 40 minutes");
  assert.equal(actorByKey["opportunity:o6"], "trackpr", "pending estimate, 30h, follow-up on");
  assert.deepEqual(all.filter((item) => item.actor === "trackpr").map((item) => item.key).sort(), ["opportunity:o6", "signal:awaiting_reply:0"]);
  for (const item of result.exceptions) assert.equal(item.actor, "human", "exceptions are always human");
});

// ---------------------------------------------------------------------------
// Phase 2-3b: Act II holds only human work; the count and caught-up read it.
// ---------------------------------------------------------------------------

test("2-3b: a Trackpr-handled item disappears from Act II and moves to trackprHandling; the human items keep their exact frozen rows and relative order", () => {
  const now = Date.now();
  const fixture = trackprCapableFixture(now);
  const baseline = assembleDecisions(fixture);
  const result = assembleDecisions({ ...fixture, context: eligibleContext(now) });
  const trackprKeys = ["signal:awaiting_reply:0", "opportunity:o6"];
  assert.deepEqual(result.trackprHandling.map((item) => item.key), trackprKeys, "in priority order");
  assert.ok(result.attention.every((item) => item.actor === "human"));
  assert.deepEqual(result.attention.map(rowOf), baseline.attention.map(rowOf).filter((row) => !trackprKeys.includes(row[0])), "the remaining human rows are byte-identical and in the same relative order");
});

test("2-3b: the attention count is operational exceptions plus human Act II items - Trackpr items never count, exceptions always do", () => {
  const now = Date.now();
  const result = assembleDecisions({ ...trackprCapableFixture(now), context: eligibleContext(now) });
  assert.equal(result.totalNeedingAttention, result.exceptions.length + result.attention.length);
  assert.equal(result.totalNeedingAttention, 3 + 11, "16 before, minus the 2 Trackpr-handled items");
  assert.equal(result.exceptions.length, 3, "exceptions still count");
});

test("2-3b: with only Trackpr-handled work and no exceptions, the count is 0 - caught up; any exception keeps it above 0", () => {
  const now = Date.now();
  const fixture = trackprCapableFixture(now);
  const onlyTrackprWork = {
    attentionItems: fixture.attentionItems.filter((item) => item.id === "reply-a"),
    prioritizedOpportunities: fixture.prioritizedOpportunities.filter((p) => p.opportunity.id === "o6" || p.opportunity.id === "o9"),
  };
  const caughtUp = assembleDecisions({ ...onlyTrackprWork, context: eligibleContext(now) });
  assert.equal(caughtUp.attention.length, 0);
  assert.equal(caughtUp.trackprHandling.length, 2, "Trackpr is still handling work");
  assert.equal(caughtUp.opportunities.length, 1, "Act III still lists the review request");
  assert.equal(caughtUp.totalNeedingAttention, 0, "caught up: Trackpr work and Act III never block it");
  const withException = assembleDecisions({ attentionItems: [...onlyTrackprWork.attentionItems, fixture.attentionItems.find((item) => item.kind === "calendar_disconnected")!], prioritizedOpportunities: onlyTrackprWork.prioritizedOpportunities, context: eligibleContext(now) });
  assert.equal(withException.totalNeedingAttention, 1, "an operational exception still blocks caught-up");
});

test("2-3b: Act III is unchanged by the context - same rows, never counted", () => {
  const now = Date.now();
  const fixture = trackprCapableFixture(now);
  const result = assembleDecisions({ ...fixture, context: eligibleContext(now) });
  assert.deepEqual(result.opportunities.map(rowOf), assembleDecisions(fixture).opportunities.map(rowOf));
  assert.ok(!result.trackprHandling.some((item) => item.act === "opportunity"));
});

test("2-3b (C5): when the waiting cap is reached, waiting conversations stay human in Act II and count, even inside the grace period", () => {
  const now = Date.now();
  const result = assembleDecisions({ ...trackprCapableFixture(now), context: { ...eligibleContext(now), waitingCapReached: true } });
  assert.ok(result.attention.some((item) => item.key === "signal:awaiting_reply:0"), "conv-a stays in Act II");
  assert.deepEqual(result.trackprHandling.map((item) => item.key), ["opportunity:o6"], "only the pending estimate is set aside");
  assert.equal(result.totalNeedingAttention, 3 + 12);
});

test("2-3b: the Act I waiting figure counts exactly Act II's human waiting-for-reply rows", () => {
  const { conversationsWaitingCount }: typeof import("@/app/(app)/today/_components/dashboard-model") = require(path.join(ROOT, "app/(app)/today/_components/dashboard-model.ts"));
  const now = Date.now();
  const result = assembleDecisions({ ...trackprCapableFixture(now), context: eligibleContext(now) });
  assert.deepEqual(conversationsWaitingCount(result.attention), { count: 1, capped: false }, "conv-b only - conv-a is inside Trackpr's grace period");
  assert.deepEqual(conversationsWaitingCount(assembleDecisions(trackprCapableFixture(now)).attention), { count: 2, capped: false }, "all-human context: both waiting replies");
});

// ---------------------------------------------------------------------------
// Phase 2-4: the estimate lifecycle in the decision layer.
// ---------------------------------------------------------------------------

/** Just the pending estimate o6 (no other items), sent `sentMsAgo` ago to contact c6. */
function estimateOnly(now: number, sentMsAgo: number | null, overrides: Partial<import("@/lib/opportunities/intelligence").PrioritizedOpportunity> = {}) {
  const base = buildParityFixture(now).prioritizedOpportunities.find((p) => p.opportunity.id === "o6")!;
  const metadata = sentMsAgo === null ? { estimate_id: "est-9" } : { estimate_id: "est-9", sent_at: new Date(now - sentMsAgo).toISOString() };
  return { attentionItems: [], prioritizedOpportunities: [{ ...base, contactPhone: "+15125550106", contactSmsOptOut: false, ...overrides, opportunity: { ...base.opportunity, metadata } }] };
}
const placement = (result: ReturnType<typeof assembleDecisions>) => ({
  attention: result.attention.map((i) => i.key),
  trackprHandling: result.trackprHandling.map((i) => i.key),
  notYetAttention: result.notYetAttention.map((i) => i.key),
  count: result.totalNeedingAttention,
});

test("2-4a: an eligible pending estimate under 72h stays Trackpr's when the contact's conversation AI is on or absent", () => {
  const now = Date.now();
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 30 * HOUR), context: eligibleContext(now) })), { attention: [], trackprHandling: ["opportunity:o6"], notYetAttention: [], count: 0 });
});

test("2-4a (K2): when the contact's open SMS conversation has AI off, the estimate is human - in Act II, counted, with the follow-up action", () => {
  const now = Date.now();
  const result = assembleDecisions({ ...estimateOnly(now, 30 * HOUR), context: { ...eligibleContext(now), estimateContactAiDisabled: new Set(["c6"]) } });
  assert.deepEqual(placement(result), { attention: ["opportunity:o6"], trackprHandling: [], notYetAttention: [], count: 1 });
  assert.equal(result.attention[0].actor, "human");
  assert.equal(result.attention[0].nextAction.code, "follow_up_estimate");
  assert.equal(result.attention[0].sentence, 'Estimate "Deck" sent - awaiting the customer\'s decision. Follow up on the estimate.', "the exact existing phrase");
  assert.deepEqual([result.attention[0].nextAction.label, result.attention[0].nextAction.href, result.attention[0].problemLabel], ["View estimate", "/estimates/est-9", "Estimate sent, awaiting reply"], "label, link and problem label unchanged");
});

test("2-4b (K3): a human-owned pending estimate is not attention until exactly 24h - 23:59:59.999 is excluded, 24:00:00.000 is counted", () => {
  const now = Date.now();
  const followupOff = { ...eligibleContext(now), estimateFollowupEnabled: false };
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 24 * HOUR - 1), context: followupOff })), { attention: [], trackprHandling: [], notYetAttention: ["opportunity:o6"], count: 0 }, "23:59:59.999 - not in Act II, not counted, not Trackpr's");
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 24 * HOUR), context: followupOff })), { attention: ["opportunity:o6"], trackprHandling: [], notYetAttention: [], count: 1 }, "24:00:00.000 - human attention");
});

test("2-4: follow-up on vs off - on: Trackpr's under 72h (even under 24h); off: human, hidden under 24h, attention after", () => {
  const now = Date.now();
  const on = eligibleContext(now);
  const off = { ...on, estimateFollowupEnabled: false };
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 2 * HOUR), context: on })).trackprHandling, ["opportunity:o6"], "on, 2h: Trackpr's first follow-up is pending");
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 72 * HOUR), context: on })).attention, ["opportunity:o6"], "on, 72h: both follow-ups done - human");
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 2 * HOUR), context: off })).notYetAttention, ["opportunity:o6"], "off, 2h: not attention yet");
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 30 * HOUR), context: off })).attention, ["opportunity:o6"], "off, 30h: human attention");
});

test("2-4: reachable vs opted-out contact - an opted-out contact makes the estimate human (and subject to the 24h rule)", () => {
  const now = Date.now();
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 30 * HOUR, { contactSmsOptOut: true }), context: eligibleContext(now) })).attention, ["opportunity:o6"]);
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 2 * HOUR, { contactSmsOptOut: true }), context: eligibleContext(now) })).notYetAttention, ["opportunity:o6"]);
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 30 * HOUR), context: eligibleContext(now) })).trackprHandling, ["opportunity:o6"], "reachable and opted in: Trackpr's");
});

test("2-4: an unknown sent_at never hides human work - the estimate stays in Act II", () => {
  const now = Date.now();
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, null), context: { ...eligibleContext(now), estimateFollowupEnabled: false } })), { attention: ["opportunity:o6"], trackprHandling: [], notYetAttention: [], count: 1 });
});

test("2-4: only pending estimates change - every other row in the frozen fixture is byte-identical to the 2-2 table", () => {
  const rows = assembleDecisions(buildParityFixture()).attention.map(rowOf);
  for (const [i, row] of rows.entries()) {
    if (row[0] === "opportunity:o6") continue;
    assert.deepEqual(row, EXPECTED_ATTENTION[i], row[0]);
  }
});

// ---------------------------------------------------------------------------
// Phase 2-11 (A7-A9, G1-G5): "Missed follow-up · ..." in the existing label
// slot. Reason codes, actions, links, actors, order and placement unchanged.
// ---------------------------------------------------------------------------

const missedOf = (items: import("./types").DecisionItem[]) => Object.fromEntries(items.map((item) => [item.key, [item.problemLabel, item.missedFollowUp ?? null]]));

test("2-11 (G5): every uncontacted lead shows 'Missed follow-up · First contact' - reason code, action and link unchanged", () => {
  const result = assembleDecisions(buildParityFixture());
  for (const key of ["opportunity:o4", "opportunity:o5"]) {
    const item = result.attention.find((i) => i.key === key)!;
    assert.deepEqual([item.problemLabel, item.missedFollowUp, item.reasonCode, item.nextAction.label, item.nextAction.href], ["Missed follow-up · First contact", "first_contact", "lead_not_contacted", "View lead", `/people/${key === "opportunity:o4" ? "c4" : "c5"}`]);
  }
});

test("2-11 (G3): a human waiting reply whose first unanswered message is 4h or more old shows 'Missed follow-up · Reply'; under 4h keeps 'Waiting on a reply'; the Trackpr grace item is untouched", () => {
  const now = Date.now();
  const context = { ...eligibleContext(now), waitingConversations: new Map([
    ["conv-a", { aiEnabled: true, smsOptOut: false, firstUnansweredInboundAt: new Date(now - 5 * MIN).toISOString() }],
    ["conv-b", { aiEnabled: true, smsOptOut: false, firstUnansweredInboundAt: new Date(now - 4 * HOUR).toISOString() }],
  ]) };
  const result = assembleDecisions({ ...trackprCapableFixture(now), context });
  assert.deepEqual(missedOf(result.attention)["signal:awaiting_reply:1"], ["Missed follow-up · Reply", "reply"], "conv-b, exactly 4h");
  assert.deepEqual(missedOf(result.trackprHandling)["signal:awaiting_reply:0"], ["Waiting on a reply", null], "conv-a, 5 minutes, Trackpr's");
  const under = assembleDecisions({ ...trackprCapableFixture(now), context: eligibleContext(now) });
  assert.deepEqual(missedOf(under.attention)["signal:awaiting_reply:1"], ["Waiting on a reply", null], "conv-b at 40 minutes is a normal waiting reply");
  const item = result.attention.find((i) => i.key === "signal:awaiting_reply:1")!;
  assert.deepEqual([item.reasonCode, item.actor, item.nextAction.label, item.nextAction.href], ["customer_awaiting_reply", "human", "Open conversation", "/conversations/b"]);
});

test("2-11 (G3): at the cap every waiting reply is still human; one waiting 4h or more is labelled, and without a timestamp nothing changes", () => {
  const now = Date.now();
  const capped = { ...eligibleContext(now), waitingCapReached: true, waitingConversations: new Map([["conv-a", { aiEnabled: true, smsOptOut: false, firstUnansweredInboundAt: new Date(now - 6 * HOUR).toISOString() }]]) };
  const result = assembleDecisions({ ...trackprCapableFixture(now), context: capped });
  const labels = missedOf(result.attention);
  assert.deepEqual(labels["signal:awaiting_reply:0"], ["Missed follow-up · Reply", "reply"]);
  assert.deepEqual(labels["signal:awaiting_reply:1"], ["Waiting on a reply", null], "conv-b's timestamp unknown: existing behavior");
  assert.ok(result.attention.filter((i) => i.reasonCode === "customer_awaiting_reply").every((i) => i.actor === "human"));
});

test("2-11 (G4): a human-owned estimate sent 72h+ ago with no outbound after sent_at shows 'Missed follow-up · Estimate follow-up'; an outbound after sent_at (a person's or Trackpr's) keeps the existing label; ownership is unchanged", () => {
  const now = Date.now();
  const humanContext = (latest: Map<string, number> | null) => ({ ...eligibleContext(now), estimateFollowupEnabled: false, latestOutboundMsByContact: latest });
  const missed = assembleDecisions({ ...estimateOnly(now, 80 * HOUR), context: humanContext(new Map()) });
  assert.deepEqual(placement(missed), { attention: ["opportunity:o6"], trackprHandling: [], notYetAttention: [], count: 1 });
  const item = missed.attention[0];
  assert.deepEqual([item.problemLabel, item.missedFollowUp, item.reasonCode, item.actor, item.nextAction.code, item.nextAction.href], ["Missed follow-up · Estimate follow-up", "estimate_followup", "estimate_awaiting_decision", "human", "follow_up_estimate", "/estimates/est-9"]);
  const followedUp = assembleDecisions({ ...estimateOnly(now, 80 * HOUR), context: humanContext(new Map([["c6", now - 10 * HOUR]])) });
  assert.deepEqual([followedUp.attention[0].problemLabel, followedUp.attention[0].missedFollowUp], ["Estimate sent, awaiting reply", undefined]);
  const under = assembleDecisions({ ...estimateOnly(now, 71 * HOUR), context: humanContext(new Map()) });
  assert.equal(under.attention[0].problemLabel, "Estimate sent, awaiting reply", "under 72h");
  const unknown = assembleDecisions({ ...estimateOnly(now, 80 * HOUR), context: humanContext(null) });
  assert.equal(unknown.attention[0].problemLabel, "Estimate sent, awaiting reply", "outbound read unavailable: existing label");
});

test("R-d (Phase 2-13): the organization's configured follow-up window decides when Trackpr is finished and when a person's follow-up is missed; the 24h minimum still holds", () => {
  const now = Date.now();
  const withWindow = (hours: number, extra: Partial<import("./actor").DecisionContext> = {}) => ({ ...eligibleContext(now), latestOutboundMsByContact: new Map<string, number>(), estimateFollowupWindowMs: hours * HOUR, ...extra });
  // 120h window (e.g. followup_1_hours 48, followup_2_hours 120): Trackpr still owns it at 100h; at 120h it is human and, with nothing sent, missed.
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 100 * HOUR), context: withWindow(120) })).trackprHandling, ["opportunity:o6"], "100h of 120h: Trackpr's second touch is still pending");
  const done = assembleDecisions({ ...estimateOnly(now, 120 * HOUR), context: withWindow(120) });
  assert.deepEqual([placement(done).attention, done.attention[0].problemLabel], [["opportunity:o6"], "Missed follow-up · Estimate follow-up"]);
  // 30h window: human and missed from 30h.
  const short = assembleDecisions({ ...estimateOnly(now, 31 * HOUR), context: withWindow(30) });
  assert.deepEqual([placement(short).attention, short.attention[0].problemLabel], [["opportunity:o6"], "Missed follow-up · Estimate follow-up"]);
  // 12h window (followup_1_hours 6, followup_2_hours 12): Trackpr is done at 12h, but a person's estimate is not attention before 24h.
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 13 * HOUR), context: withWindow(12) })), { attention: [], trackprHandling: [], notYetAttention: ["opportunity:o6"], count: 0 }, "the 24h minimum is preserved");
  assert.deepEqual(placement(assembleDecisions({ ...estimateOnly(now, 24 * HOUR), context: withWindow(12) })).attention, ["opportunity:o6"]);
  // Follow-up turned off with a 120h window: a person owns it from 24h, but it is only a missed follow-up once the configured window has elapsed.
  const off = assembleDecisions({ ...estimateOnly(now, 100 * HOUR), context: withWindow(120, { estimateFollowupEnabled: false }) });
  assert.deepEqual([placement(off).attention, off.attention[0].problemLabel], [["opportunity:o6"], "Estimate sent, awaiting reply"]);
});

test("2-11: Trackpr-owned and too-young estimates are never relabelled, and the 2-4 placement is unchanged", () => {
  const now = Date.now();
  const trackpr = assembleDecisions({ ...estimateOnly(now, 30 * HOUR), context: { ...eligibleContext(now), latestOutboundMsByContact: new Map() } });
  assert.deepEqual(placement(trackpr), { attention: [], trackprHandling: ["opportunity:o6"], notYetAttention: [], count: 0 });
  assert.equal(trackpr.trackprHandling[0].problemLabel, "Estimate sent, awaiting reply");
  const young = assembleDecisions({ ...estimateOnly(now, 10 * HOUR), context: { ...eligibleContext(now), estimateFollowupEnabled: false, latestOutboundMsByContact: new Map() } });
  assert.deepEqual(placement(young), { attention: [], trackprHandling: [], notYetAttention: ["opportunity:o6"], count: 0 });
});

test("2-11: By type is untouched - the opportunity-type labels it groups by are unchanged", () => {
  const { OPPORTUNITY_TYPE_LABEL }: typeof import("@/app/(app)/opportunities/_components/opportunity-type") = require(path.join(ROOT, "app/(app)/opportunities/_components/opportunity-type.ts"));
  assert.equal(OPPORTUNITY_TYPE_LABEL.uncontacted_lead, "Never contacted");
  assert.equal(OPPORTUNITY_TYPE_LABEL.pending_estimate, "Estimate sent, awaiting reply");
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "app/(app)/opportunities/_components/opportunities-list.tsx"), "utf8"), /Missed follow-up/);
});

// ---------------------------------------------------------------------------
// Phase 2-12 (§3): a conversation with a human escalation appears once - as
// the escalation. Matched only on the explicit conversation id both items
// carry; never by contact, link or title.
// ---------------------------------------------------------------------------

/** The parity fixture with conversation ids set on chosen items: { itemId: conversationId }. */
function withConversations(ids: Record<string, string>, now = Date.now()) {
  const fixture = trackprCapableFixture(now);
  fixture.attentionItems = fixture.attentionItems.map((item) => (item.id in ids ? { ...item, conversationId: ids[item.id] } : { ...item, conversationId: undefined }));
  return fixture;
}
const signalTitles = (items: import("./types").DecisionItem[]) => items.filter((i) => i.reasonCode === "customer_awaiting_reply").map((i) => i.subject.name);
const everyItem = (r: ReturnType<typeof assembleDecisions>) => [...r.exceptions, ...r.attention, ...r.trackprHandling, ...r.opportunities, ...r.notYetAttention];

test("2-12: the same conversation waiting for a reply and escalated - only the escalation remains (in every bucket)", () => {
  const result = assembleDecisions(withConversations({ "escalation-inc-1": "conv-a", "reply-a": "conv-a", "reply-b": "conv-b" }));
  assert.deepEqual(signalTitles(everyItem(result)), ["Bo Chen"], "Ann Lee's waiting reply is gone");
  assert.ok(result.exceptions.some((i) => i.source.kind === "exception" && i.source.incidentId === "inc-1"), "the escalation stays");
});

test("2-12: the same contact in a different conversation is never merged; an escalation alone or a waiting reply alone is unchanged", () => {
  const different = assembleDecisions(withConversations({ "escalation-inc-1": "conv-x", "reply-a": "conv-a", "reply-b": "conv-b" }));
  assert.deepEqual(signalTitles(everyItem(different)), ["Ann Lee", "Bo Chen"]);
  const escalationOnly = assembleDecisions({ ...withConversations({ "escalation-inc-1": "conv-a" }), attentionItems: withConversations({ "escalation-inc-1": "conv-a" }).attentionItems.filter((i) => i.kind !== "awaiting_reply") });
  assert.equal(escalationOnly.exceptions.filter((i) => i.reasonCode === "human_escalation").length, 2);
  const replyOnly = assembleDecisions({ ...withConversations({ "reply-a": "conv-a" }), attentionItems: withConversations({ "reply-a": "conv-a" }).attentionItems.filter((i) => i.kind !== "human_escalation") });
  assert.deepEqual(signalTitles(everyItem(replyOnly)), ["Ann Lee", "Bo Chen"]);
});

test("2-12: a missing conversation id never causes a merge - not on the escalation (even with a matching link), not on the reply", () => {
  // escalation-inc-1's link is /conversations/c-esc; reply-a gets conversation id "c-esc" but the escalation has no id.
  const noEscalationId = assembleDecisions(withConversations({ "reply-a": "c-esc" }));
  assert.deepEqual(signalTitles(everyItem(noEscalationId)), ["Ann Lee", "Bo Chen"], "links are never parsed");
  const noReplyId = assembleDecisions(withConversations({ "escalation-inc-1": "conv-a" }));
  assert.deepEqual(signalTitles(everyItem(noReplyId)), ["Ann Lee", "Bo Chen"]);
});

test("2-12: several conversations, one escalated - only that conversation's waiting reply is dropped", () => {
  const result = assembleDecisions(withConversations({ "escalation-x": "conv-b", "reply-a": "conv-a", "reply-b": "conv-b" }));
  assert.deepEqual(signalTitles(everyItem(result)), ["Ann Lee"]);
});

test("2-12: every other item keeps its row, order and actor - only the duplicate disappears (signal keys are positional, so they are compared without the key)", () => {
  const now = Date.now();
  const ids = { "escalation-inc-1": "conv-a", "reply-a": "conv-a", "reply-b": "conv-b" };
  const context = { ...eligibleContext(now), waitingConversations: new Map([["conv-b", { aiEnabled: true, smsOptOut: false, firstUnansweredInboundAt: new Date(now - 40 * MIN).toISOString() }]]) };
  const baseline = assembleDecisions({ ...withConversations({ "reply-a": "conv-a", "reply-b": "conv-b" }, now), context });
  const deduped = assembleDecisions({ ...withConversations(ids, now), context });
  const rowWithoutKey = (item: import("./types").DecisionItem) => [...rowOf(item).slice(1), item.actor];
  const expected = baseline.attention.filter((item) => item.subject.name !== "Ann Lee").map(rowWithoutKey);
  assert.deepEqual(deduped.attention.map(rowWithoutKey), expected);
  assert.deepEqual(deduped.exceptions.map(rowOf), baseline.exceptions.map(rowOf), "exceptions unchanged");
  assert.equal(deduped.totalNeedingAttention, baseline.totalNeedingAttention - 1);
});
