/**
 * Founder sales OS (lib/founder/sales.ts): activity and stage-change input,
 * the "sales today" views and the measured metrics - evidence only, voided
 * entries excluded, snapshot kept apart from conversion, local days, money
 * per currency with setup and monthly never mixed.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/founder/sales.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLD_ATTEMPTS,
  STALL_DAYS,
  buildSalesMetrics,
  buildSalesToday,
  ofLabel,
  parseActivityInput,
  parseStageChange,
  periodRange,
  suggestedStage,
  type DealActivity,
} from "./sales";
import { lastTouch } from "./intelligence";
import type { FounderDeal, FounderItem } from "./model";
import { DEAL_DEFAULTS } from "./test-fixtures";

const TZ = "America/Denver";
// Friday Oct 9 2026, 2:00pm in Denver (MDT, UTC-6).
const NOW = new Date("2026-10-09T20:00:00Z");
const TODAY = "2026-10-09";
const deal = (o: Partial<FounderDeal> & { name: string }): FounderDeal => ({ ...DEAL_DEFAULTS, id: o.name, nextAction: "Call", nextActionAt: "2026-10-30T16:00:00Z", ...o });
let seq = 0;
const act = (dealId: string, kind: DealActivity["kind"], occurredAt: string, o: Partial<DealActivity> = {}): DealActivity => ({
  id: `a${++seq}`,
  dealId,
  kind,
  occurredAt,
  channel: null,
  scheduledFor: null,
  summary: null,
  fromStage: null,
  toStage: null,
  setupFee: null,
  monthlyFee: null,
  currency: null,
  voidedAt: null,
  voidReason: null,
  recordedAt: occurredAt,
  ...o,
});
const item = (o: Partial<FounderItem> & { title: string }): FounderItem => ({ id: o.title, kind: "meeting", notes: null, priority: "medium", dueAt: null, startsAt: null, endsAt: null, completedAt: null, dealId: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...o });
const names = (list: { deal: FounderDeal }[]) => list.map((e) => e.deal.name);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// --- input ------------------------------------------------------------------------------

test("logging: only things that happened, valid kinds and channels; the stage move is offered only forward", () => {
  const d = { stage: "outreach" as const };
  assert.equal(parseActivityInput({ kind: "payment_received", occurredAt: "2026-10-09T10:00" }, d, TZ, NOW).ok, false, "payments aren't sales activity");
  assert.equal(parseActivityInput({ kind: "outreach" }, d, TZ, NOW).ok, false, "when is required");
  assert.equal(parseActivityInput({ kind: "outreach", occurredAt: "2026-10-10T10:00" }, d, TZ, NOW).ok, false, "tomorrow hasn't happened");
  assert.equal(parseActivityInput({ kind: "outreach", occurredAt: "2026-10-09T10:00", channel: "carrier pigeon" }, d, TZ, NOW).ok, false);
  const reply = parseActivityInput({ kind: "reply_received", occurredAt: "2026-10-09T13:30", channel: "email", summary: " Interested ", advance: "on" }, d, TZ, NOW);
  assert.ok(reply.ok);
  assert.deepEqual([reply.value.occurredAt, reply.value.summary, reply.value.toStage], ["2026-10-09T19:30:00.000Z", "Interested", "replied"]);
  const noAdvance = parseActivityInput({ kind: "reply_received", occurredAt: "2026-10-09T13:30" }, d, TZ, NOW);
  assert.ok(noAdvance.ok && noAdvance.value.toStage === null, "the stage only moves when asked");
  const backwards = parseActivityInput({ kind: "outreach", occurredAt: "2026-10-09T13:30", advance: "on" }, { stage: "proposal_sent" }, TZ, NOW);
  assert.ok(backwards.ok && backwards.value.toStage === null, "a follow-up email never moves a deal backwards");
  const booked = parseActivityInput({ kind: "meeting_booked", occurredAt: "2026-10-09T09:00", scheduledFor: "2026-10-12T10:00" }, d, TZ, NOW);
  assert.ok(booked.ok && booked.value.scheduledFor === "2026-10-12T16:00:00.000Z");
  const note = parseActivityInput({ kind: "note", occurredAt: "2026-10-09T09:00", scheduledFor: "2026-10-12T10:00" }, d, TZ, NOW);
  assert.ok(note.ok && note.value.scheduledFor === null, "only booked meetings carry a meeting time");
  assert.equal(suggestedStage("demo_completed", "meeting_held"), null, "demos and audits are activities, not stages");
  assert.equal(suggestedStage("proposal_sent", "won"), null, "closed deals are never moved by logging");
});

test("stage changes: wins need split terms, currency and a past date; losses need a reason; closed deals reopen first", () => {
  assert.equal(parseStageChange({ toStage: "won" }, "negotiation", TODAY, TZ, NOW).ok, false);
  assert.equal(parseStageChange({ toStage: "won", setupFee: "2500", wonOn: TODAY }, "negotiation", TODAY, TZ, NOW).ok, false, "monthly fee required");
  assert.equal(parseStageChange({ toStage: "won", setupFee: "2500", monthlyFee: "1497", wonOn: "2026-10-10" }, "negotiation", TODAY, TZ, NOW).ok, false, "won date can't be in the future");
  assert.equal(parseStageChange({ toStage: "won", setupFee: "2500", monthlyFee: "1497", wonOn: TODAY, currency: "dollars" }, "negotiation", TODAY, TZ, NOW).ok, false);
  const won = parseStageChange({ toStage: "won", setupFee: "$2,500", monthlyFee: "1497", wonOn: TODAY, currency: "usd" }, "negotiation", TODAY, TZ, NOW);
  assert.ok(won.ok);
  assert.deepEqual([won.value.setupFee, won.value.monthlyFee, won.value.currency, won.value.wonOn], [2500, 1497, "USD", TODAY]);
  const zero = parseStageChange({ toStage: "won", setupFee: "0", monthlyFee: "1497", wonOn: TODAY }, "negotiation", TODAY, TZ, NOW);
  assert.ok(zero.ok && zero.value.setupFee === 0, "a waived setup fee is an explicit 0, not missing");
  assert.equal(parseStageChange({ toStage: "lost", reason: "  " }, "negotiation", TODAY, TZ, NOW).ok, false);
  assert.ok(parseStageChange({ toStage: "lost", reason: "Budget" }, "negotiation", TODAY, TZ, NOW).ok);
  assert.equal(parseStageChange({ toStage: "lost", reason: "x" }, "won", TODAY, TZ, NOW).ok, false, "won -> lost must reopen first");
  assert.ok(parseStageChange({ toStage: "negotiation" }, "won", TODAY, TZ, NOW).ok, "reopen to an open stage");
  assert.equal(parseStageChange({ toStage: "negotiation" }, "negotiation", TODAY, TZ, NOW).ok, false);
  assert.equal(parseStageChange({ toStage: "lead" }, "negotiation", TODAY, TZ, NOW).ok, false, "legacy stage names are gone");
  assert.equal(parseStageChange({ toStage: "replied", occurredAt: "2026-10-11T09:00" }, "outreach", TODAY, TZ, NOW).ok, false, "no future-dated changes");
});

// --- sales today ----------------------------------------------------------------------------

test("sales today: outreach vs follow-ups by stage and due date (local day); overdue included; future excluded", () => {
  const deals = [
    deal({ name: "Due tonight", stage: "identified", nextActionAt: "2026-10-10T05:30:00Z" }), // 11:30pm local today
    deal({ name: "Overdue qualified", stage: "qualified", nextActionAt: "2026-10-05T16:00:00Z" }),
    deal({ name: "Tomorrow", stage: "qualified", nextActionAt: "2026-10-10T16:00:00Z" }),
    deal({ name: "Chasing", stage: "proposal_sent", nextActionAt: "2026-10-09T15:00:00Z" }),
    deal({ name: "Won", stage: "won", nextActionAt: "2026-10-01T15:00:00Z", wonSetupFee: 1, wonMonthlyFee: 1, wonOn: "2026-10-01" }),
  ];
  const t = buildSalesToday({ deals, activities: [], items: [], now: NOW, timeZone: TZ, todayKey: TODAY });
  assert.deepEqual(names(t.outreachDue), ["Overdue qualified", "Due tonight"]);
  assert.deepEqual(names(t.followUpsDue), ["Chasing"], "closed deals never need follow-up");
  assert.match(t.outreachDue[0].basis, /due and overdue/);
});

test("meetings: upcoming from the calendar or a logged booking; a passed meeting with no outcome recorded is flagged once", () => {
  const deals = [deal({ name: "Acme", stage: "meeting_booked" }), deal({ name: "Birch", stage: "meeting_booked" }), deal({ name: "Lost co", stage: "lost", lostReason: "x" })];
  const items = [
    item({ title: "Acme call", dealId: "Acme", startsAt: "2026-10-12T16:00:00Z" }),
    item({ title: "Acme past", dealId: "Acme", startsAt: "2026-10-05T16:00:00Z", endsAt: "2026-10-05T17:00:00Z" }),
    item({ title: "Lost meeting", dealId: "Lost co", startsAt: "2026-10-12T16:00:00Z" }),
    item({ title: "Unlinked", startsAt: "2026-10-12T16:00:00Z" }),
  ];
  const activities = [
    act("Birch", "meeting_booked", daysAgo(3), { scheduledFor: "2026-10-08T16:00:00Z" }),
    act("Birch", "meeting_booked", daysAgo(1), { scheduledFor: "2026-10-13T16:00:00Z" }),
  ];
  let t = buildSalesToday({ deals, activities, items, now: NOW, timeZone: TZ, todayKey: TODAY });
  assert.deepEqual(t.meetings.map((m) => `${m.deal.name}:${m.source}`), ["Acme:calendar", "Birch:logged"]);
  assert.deepEqual(t.outcomeMissing.map((m) => m.deal.name), ["Acme", "Birch"]);
  t = buildSalesToday({ deals, activities: [...activities, act("Birch", "meeting_held", "2026-10-08T17:00:00Z"), act("Acme", "meeting_no_show", "2026-10-05T16:30:00Z")], items, now: NOW, timeZone: TZ, todayKey: TODAY });
  assert.deepEqual(t.outcomeMissing, [], "a recorded held / no-show clears it");
  const voidedHeld = act("Birch", "meeting_held", "2026-10-08T17:00:00Z", { voidedAt: daysAgo(0), voidReason: "wrong deal" });
  t = buildSalesToday({ deals, activities: [...activities, voidedHeld], items, now: NOW, timeZone: TZ, todayKey: TODAY });
  assert.ok(t.outcomeMissing.some((m) => m.deal.name === "Birch"), "a voided entry is not evidence");
});

test("proposals waiting: from the logged proposal when there is one, otherwise said plainly", () => {
  const deals = [deal({ name: "Logged", stage: "proposal_sent", stageChangedAt: daysAgo(2) }), deal({ name: "Unlogged", stage: "negotiation", stageChangedAt: daysAgo(9) })];
  const t = buildSalesToday({ deals, activities: [act("Logged", "proposal_sent", daysAgo(6))], items: [], now: NOW, timeZone: TZ, todayKey: TODAY });
  assert.deepEqual(names(t.proposalsWaiting), ["Unlogged", "Logged"], "longest wait first");
  assert.equal(t.proposalsWaiting[0].basis, "At negotiation for 9 days - no proposal logged");
  assert.equal(t.proposalsWaiting[1].basis, "Proposal sent 6 days ago (recorded)");
});

test("stalled: past first reply, nothing recorded for 14+ days, nothing scheduled; due follow-ups aren't double-listed", () => {
  const deals = [
    deal({ name: "Quiet", stage: "meeting_held", lastActivityAt: daysAgo(STALL_DAYS), nextActionAt: null }),
    deal({ name: "Recent", stage: "meeting_held", lastActivityAt: daysAgo(STALL_DAYS - 1), nextActionAt: null }),
    deal({ name: "Scheduled", stage: "meeting_held", lastActivityAt: daysAgo(40), nextActionAt: "2026-10-20T16:00:00Z" }),
    deal({ name: "Overdue follow-up", stage: "meeting_held", lastActivityAt: daysAgo(40), nextActionAt: daysAgo(2) }),
    deal({ name: "Never logged", stage: "replied", stageChangedAt: daysAgo(20), nextActionAt: null }),
    deal({ name: "Early stage", stage: "qualified", lastActivityAt: daysAgo(40), nextActionAt: null }),
  ];
  const t = buildSalesToday({ deals, activities: [], items: [], now: NOW, timeZone: TZ, todayKey: TODAY });
  assert.deepEqual(names(t.stalled).sort(), ["Never logged", "Quiet"]);
  assert.match(t.stalled.find((e) => e.deal.name === "Never logged")!.basis, /^No activity recorded; at this stage for 20 days/);
  assert.match(t.stalled.find((e) => e.deal.name === "Quiet")!.basis, /^No activity recorded for 14 days/);
  assert.deepEqual(names(t.followUpsDue), ["Overdue follow-up"]);
});

test("cold: only from recorded outreach with no recorded reply; a reply resets the count", () => {
  const deals = [deal({ name: "Three tries", stage: "outreach" }), deal({ name: "Old try", stage: "outreach" }), deal({ name: "Replied once", stage: "outreach" }), deal({ name: "Nothing logged", stage: "outreach" })];
  const activities = [
    ...Array.from({ length: COLD_ATTEMPTS }, (_, i) => act("Three tries", "outreach", daysAgo(10 - i))),
    act("Old try", "outreach", daysAgo(25)),
    act("Replied once", "outreach", daysAgo(30)),
    act("Replied once", "outreach", daysAgo(28)),
    act("Replied once", "reply_received", daysAgo(26)),
    act("Replied once", "outreach", daysAgo(5)),
  ];
  const t = buildSalesToday({ deals, activities, items: [], now: NOW, timeZone: TZ, todayKey: TODAY });
  assert.deepEqual(names(t.cold), ["Old try", "Three tries"]);
  assert.match(t.cold.find((e) => e.deal.name === "Three tries")!.basis, /3 outreach attempts recorded, last 8 days ago, no reply recorded/);
  assert.ok(!names(t.cold).includes("Nothing logged"), "no recorded outreach = not cold, just unworked");
});

test("no next action: open deals with neither an action nor a date", () => {
  const deals = [deal({ name: "Blank", nextAction: null, nextActionAt: null }), deal({ name: "Has action", nextActionAt: null }), deal({ name: "Lost", stage: "lost", lostReason: "x", nextAction: null, nextActionAt: null })];
  assert.deepEqual(names(buildSalesToday({ deals, activities: [], items: [], now: NOW, timeZone: TZ, todayKey: TODAY }).noNextAction), ["Blank"]);
});

test("deterministic: same inputs in any order give the same views and metrics", () => {
  const deals = [deal({ name: "A", stage: "outreach" }), deal({ name: "B", stage: "proposal_sent", stageChangedAt: daysAgo(3) }), deal({ name: "C", stage: "meeting_held", lastActivityAt: daysAgo(30), nextActionAt: null })];
  const activities = [act("A", "outreach", daysAgo(25)), act("B", "proposal_sent", daysAgo(3)), act("C", "meeting_held", daysAgo(30))];
  const run = (d: FounderDeal[], a: DealActivity[]) => JSON.stringify([buildSalesToday({ deals: d, activities: a, items: [], now: NOW, timeZone: TZ, todayKey: TODAY }), buildSalesMetrics({ deals: d, activities: a, ...periodRange(TODAY, 30), timeZone: TZ })]);
  assert.equal(run(deals, activities), run([...deals].reverse(), [...activities].reverse()));
});

// --- metrics --------------------------------------------------------------------------------

test("metrics: nothing recorded yet = not measured (no invented conversion), snapshot still available elsewhere", () => {
  const m = buildSalesMetrics({ deals: [deal({ name: "Old", stage: "proposal_sent" })], activities: [], ...periodRange(TODAY, 30), timeZone: TZ });
  assert.equal(m.measuredSince, null);
  assert.deepEqual(m.cohort, { outreached: 0, replied: 0, meetingHeld: 0, proposalSent: 0, won: 0 }, "a deal sitting at proposal sent is not counted as converted");
  assert.equal(ofLabel(0, 0), "—");
  assert.equal(ofLabel(2, 5), "2 of 5");
});

test("metrics: cohort of first outreach in the period, what's recorded since; voided entries ignored; later stages count", () => {
  const activities = [
    act("A", "outreach", daysAgo(20)),
    act("A", "reply_received", daysAgo(18)),
    act("A", "stage_change", daysAgo(10), { fromStage: "replied", toStage: "proposal_sent" }), // skipped meeting_held: a later stage counts as reaching it
    act("A", "won", daysAgo(2), { fromStage: "proposal_sent", toStage: "won", setupFee: 2500, monthlyFee: 1497, currency: "USD" }),
    act("B", "outreach", daysAgo(15)),
    act("B", "reply_received", daysAgo(14), { voidedAt: daysAgo(13), voidReason: "wrong prospect" }),
    act("C", "outreach", daysAgo(45)), // first outreach before the period
    act("C", "outreach", daysAgo(5)),
    act("D", "stage_change", daysAgo(3), { fromStage: "outreach", toStage: "lost" }),
  ];
  const m = buildSalesMetrics({ deals: [], activities, ...periodRange(TODAY, 30), timeZone: TZ });
  assert.deepEqual(m.cohort, { outreached: 2, replied: 1, meetingHeld: 1, proposalSent: 1, won: 1 });
  assert.equal(m.activity.outreach, 3, "C's second attempt is in the period");
  assert.equal(m.activity.reply_received, 1, "voided reply excluded");
  assert.equal(m.measuredSince, daysAgo(45));
});

test("metrics: won terms per currency, setup and monthly apart, by won date in the local period; losses by recorded stage", () => {
  const deals = [
    deal({ name: "W1", stage: "won", wonOn: "2026-10-09", wonSetupFee: 2500, wonMonthlyFee: 1497 }),
    deal({ name: "W2", stage: "won", wonOn: "2026-09-10", wonSetupFee: 0, wonMonthlyFee: 997, currency: "CAD" }),
    deal({ name: "W old", stage: "won", wonOn: "2026-09-09", wonSetupFee: 9999, wonMonthlyFee: 9999 }),
    deal({ name: "L1", stage: "lost", lostOn: "2026-10-01", lostReason: "Price" }),
    deal({ name: "L2", stage: "lost", lostOn: "2026-10-02", lostReason: "Price" }),
    deal({ name: "L3", stage: "lost", lostOn: "2026-10-03", lostReason: "No response" }),
  ];
  const activities = [act("L1", "lost", "2026-10-01T18:00:00Z", { fromStage: "proposal_sent", toStage: "lost" }), act("L2", "lost", "2026-10-02T18:00:00Z", { fromStage: "proposal_sent", toStage: "lost" })];
  const range = periodRange(TODAY, 30);
  assert.deepEqual(range, { fromKey: "2026-09-10", toKey: "2026-10-09" });
  const m = buildSalesMetrics({ deals, activities, ...range, timeZone: TZ });
  assert.deepEqual(m.won, { count: 2, setup: { USD: 2500, CAD: 0 }, monthly: { USD: 1497, CAD: 997 } });
  assert.deepEqual(m.lost.fromStage, { proposal_sent: 2, not_recorded: 1 }, "legacy losses without history are labelled, not guessed");
  assert.deepEqual(m.lost.reasons, [{ reason: "Price", count: 2 }, { reason: "No response", count: 1 }]);
});

test("metrics: activity is counted on the founder's local days (an evening entry belongs to that day)", () => {
  const lateEvening = act("A", "outreach", "2026-09-10T05:30:00Z"); // Sep 9, 11:30pm local - outside a period starting Sep 10
  const morning = act("A", "outreach", "2026-09-10T14:00:00Z");
  const m = buildSalesMetrics({ deals: [], activities: [lateEvening, morning], ...periodRange(TODAY, 30), timeZone: TZ });
  assert.equal(m.activity.outreach, 1);
});

test("briefing staleness prefers recorded activity over the last edit", () => {
  assert.deepEqual(lastTouch({ lastActivityAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }), { at: "2026-10-01T00:00:00Z", recordedActivity: true });
  assert.deepEqual(lastTouch({ lastActivityAt: null, updatedAt: "2026-10-08T00:00:00Z" }), { at: "2026-10-08T00:00:00Z", recordedActivity: false });
});
