/**
 * Founder Intelligence (lib/founder/intelligence.ts): the deterministic
 * briefing and end-of-day summary. Determinism, local days across DST,
 * priorities, overdue vs due today, deals without a next action, stale
 * deals, ranking and explanations, duplicate suppression, completed-item
 * exclusion, destinations, empty and incomplete data, and that nothing is
 * ever modified.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/founder/intelligence.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RECOMMENDATIONS,
  PRIORITIES_HREF,
  RECOMMENDATION_TIERS,
  STALE_DEAL_DAYS,
  buildEndOfDaySummary,
  buildFounderBriefing,
  coverageStatement,
  dealHref,
  itemHref,
  rankRecommendations,
  scheduleConflicts,
  staleDeals,
  type FounderBriefing,
  type Recommendation,
} from "./intelligence";
import { localDateKey, type FounderDeal, type FounderItem } from "./model";
import { DEAL_DEFAULTS } from "./test-fixtures";
import type { DailyFocus } from "./queries";
import { buildSalesToday, type DealActivity } from "./sales";
import type { ClientHandoff } from "./handoff";

const TZ = "America/Denver";
const item = (o: Partial<FounderItem> & { title: string }): FounderItem => ({ id: o.title, kind: "task", notes: null, priority: "medium", dueAt: null, startsAt: null, endsAt: null, completedAt: null, dealId: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...o });
const deal = (o: Partial<FounderDeal> & { name: string }): FounderDeal => ({ ...DEAL_DEFAULTS, id: o.name, expectedMrr: 500, nextAction: "Call", nextActionAt: "2026-10-30T16:00:00Z", updatedAt: "2026-10-08T00:00:00Z", ...o });

// Friday Oct 9 2026, 2:00pm in Denver (MDT, UTC-6).
const NOW = new Date("2026-10-09T20:00:00Z");
const TODAY = "2026-10-09";
const GENERATED = "2026-10-09T20:00:00.000Z";

type Sources = Pick<Parameters<typeof buildFounderBriefing>[0], "salesHistory" | "handoffs">;
function brief(o: { items?: FounderItem[]; deals?: FounderDeal[]; focus?: DailyFocus[]; now?: Date; todayKey?: string; prioritiesAvailable?: boolean; timeZone?: string } & Sources = {}): FounderBriefing {
  const timeZone = o.timeZone ?? TZ;
  const now = o.now ?? NOW;
  return buildFounderBriefing({ items: o.items ?? [], deals: o.deals ?? [], focus: o.focus ?? [], now, timeZone, todayKey: o.todayKey ?? localDateKey(now, timeZone), prioritiesAvailable: o.prioritiesAvailable ?? true, generatedAt: now.toISOString(), salesHistory: o.salesHistory, handoffs: o.handoffs });
}
const rules = (b: FounderBriefing) => b.recommended_actions.map((r) => r.rule);
const recIds = (b: FounderBriefing) => b.recommended_actions.map((r) => r.records.map((x) => x.id).join("+") || r.rule);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// A realistic mixed day used by several tests.
function mixedDay() {
  const items = [
    item({ title: "Pitch deck", priority: "high" }),
    item({ title: "Hire plan" }),
    item({ title: "Standup", kind: "meeting", startsAt: "2026-10-09T21:00:00Z", endsAt: "2026-10-09T21:30:00Z" }), // 3pm local, within 2h
    item({ title: "Board dinner", kind: "event", startsAt: "2026-10-10T01:00:00Z", endsAt: "2026-10-10T03:00:00Z" }), // 7pm local, not within 2h
    item({ title: "Invoice Acme", dueAt: "2026-10-08T17:00:00Z", priority: "high" }), // yesterday: overdue
    item({ title: "Old chore", dueAt: "2026-10-01T17:00:00Z", priority: "low" }), // 8 days overdue
    item({ title: "Due this morning", dueAt: "2026-10-09T16:00:00Z" }), // past, but today: due today, not overdue
    item({ title: "Ping Jane", kind: "follow_up", dueAt: "2026-10-09T23:00:00Z" }),
    item({ title: "Tax filing", kind: "deadline", dueAt: "2026-10-11T23:00:00Z" }),
    item({ title: "Shipped", dueAt: "2026-10-08T17:00:00Z", completedAt: "2026-10-08T18:00:00Z" }),
  ];
  const deals = [
    deal({ name: "Late no step", stage: "negotiation", nextAction: null, nextActionAt: null }),
    deal({ name: "Early no step", stage: "identified", nextAction: null, nextActionAt: null }),
    deal({ name: "Follow up now", stage: "proposal_sent", nextAction: "Send proposal", nextActionAt: "2026-10-09T17:00:00Z" }),
    deal({ name: "Quiet one", stage: "outreach", nextActionAt: "2026-09-01T16:00:00Z", updatedAt: "2026-09-10T16:00:00Z" }), // past follow-up: that rule, not stale
    deal({ name: "Gone quiet", stage: "outreach", nextActionAt: null, nextAction: "Call", updatedAt: "2026-09-20T16:00:00Z" }), // 19 days, no follow-up date
    deal({ name: "Won deal", stage: "won", nextAction: null, nextActionAt: null, wonOn: "2026-10-01", wonSetupFee: 2500, wonMonthlyFee: 900 }),
  ];
  const focus: DailyFocus[] = [
    { itemId: "Hire plan", date: TODAY, rank: 2 },
    { itemId: "Pitch deck", date: TODAY, rank: 1 },
  ];
  return { items, deals, focus };
}

// --- determinism ------------------------------------------------------------------

test("determinism: identical input gives identical output, whatever the input order", () => {
  const { items, deals, focus } = mixedDay();
  const a = brief({ items, deals, focus });
  const b = brief({ items: [...items].reverse(), deals: [...deals].reverse(), focus: [...focus].reverse() });
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
  assert.equal(a.generated_at, GENERATED, "generated_at is exactly what was passed in");
  assert.equal(a.timezone, TZ);
  assert.equal(a.date, TODAY);
});

test("never modifies its input (frozen records still produce a briefing and a summary)", () => {
  const { items, deals, focus } = mixedDay();
  const before = JSON.stringify({ items, deals, focus });
  deepFreeze(items);
  deepFreeze(deals);
  deepFreeze(focus);
  assert.doesNotThrow(() => brief({ items, deals, focus }));
  assert.doesNotThrow(() => buildEndOfDaySummary({ items, deals, focus, dayKey: TODAY, timeZone: TZ }));
  assert.equal(JSON.stringify({ items, deals, focus }), before);
});

// --- ranking & explanations ---------------------------------------------------------

test("ranking: fixed tiers in order, one per record, capped, each with a factual reason", () => {
  const { items, deals, focus } = mixedDay();
  const b = brief({ items, deals, focus });
  assert.deepEqual(rules(b), ["finish_priority", "resolve_overdue", "resolve_overdue", "prepare_meeting", "follow_up_due"]);
  assert.deepEqual(recIds(b), ["Pitch deck", "Old chore", "Invoice Acme", "Standup", "Ping Jane"], "overdue oldest first; a tier's records in time order");
  assert.equal(b.recommended_actions.length, MAX_RECOMMENDATIONS);
  assert.equal(b.best_next_action?.id, b.recommended_actions[0].id);
  for (const rec of b.recommended_actions) {
    assert.ok(rec.why.length > 10, `${rec.id} explains itself`);
    assert.ok(rec.records.length > 0 || rec.rule === "set_priorities");
    assert.ok(RECOMMENDATION_TIERS.includes(rec.rule));
  }
  const tiers = b.recommended_actions.map((r) => RECOMMENDATION_TIERS.indexOf(r.rule));
  assert.deepEqual(tiers, [...tiers].sort((x, y) => x - y), "never out of tier order");
  assert.match(b.recommended_actions[1].why, /8 days overdue/);
  assert.match(b.recommended_actions[2].why, /1 day overdue, high priority/);
  assert.match(b.recommended_actions[3].why, /starts at 3:00\s?PM today/i);
});

test("facts and inferences are kept apart: suggestions are separate and never restate numbers", () => {
  const { items, deals, focus } = mixedDay();
  const b = brief({ items, deals, focus });
  const all = [...b.recommended_actions];
  for (const rec of all) if (rec.suggestion) assert.doesNotMatch(rec.suggestion, /\d/, `${rec.id}: a suggestion carries no figures`);
  for (const rec of all) assert.doesNotMatch(`${rec.title} ${rec.why} ${rec.suggestion ?? ""}`, /score|%|probability|likely to close/i, "no fake precision");
});

test("overflow beyond the top five stays visible under needs attention (nothing lost)", () => {
  const { items, deals, focus } = mixedDay();
  const b = brief({ items, deals, focus });
  assert.deepEqual(
    b.needs_attention.map((e) => e.id),
    ["deadline_soon:Tax filing", "deal_follow_up:Quiet one", "deal_follow_up:Follow up now", "deal_no_next_action:Early no step", "deal_no_next_action:Late no step", "stale_deal:Gone quiet"],
    "grouped by kind, oldest follow-up first; the stale deal is the one with no follow-up date at all",
  );
  assert.equal(b.attention_total, b.needs_attention.length + 3, "the 2 overdue and 1 follow-up went to recommendations");
});

// --- duplicate suppression ------------------------------------------------------------

test("duplicates: a record is recommended once, and never also listed under needs attention", () => {
  const { items, deals, focus } = mixedDay();
  const b = brief({ items, deals, focus });
  const recKeys = b.recommended_actions.flatMap((r) => r.records.map((x) => `${x.type}:${x.id}`));
  assert.equal(new Set(recKeys).size, recKeys.length);
  for (const entry of b.needs_attention) assert.ok(!recKeys.includes(`${entry.record.type}:${entry.record.id}`), entry.id);
  const attKeys = b.needs_attention.map((e) => `${e.record.type}:${e.record.id}`);
  assert.equal(new Set(attKeys).size, attKeys.length, "one attention entry per record");
});

test("duplicates: an overdue item that is also a priority is recommended as the priority only", () => {
  const items = [item({ title: "P1 overdue", dueAt: "2026-10-07T17:00:00Z" })];
  const b = brief({ items, focus: [{ itemId: "P1 overdue", date: TODAY, rank: 1 }] });
  assert.deepEqual(rules(b), ["finish_priority"]);
  assert.equal(b.needs_attention.length, 0);
});

test("duplicates: the ranking safety net keeps the highest tier per record and is stable within a tier", () => {
  const rec = (rule: Recommendation["rule"], ids: string[], title: string = rule): Recommendation => ({ id: ids.length ? `${rule}:${ids.join("+")}` : rule, rule, title, why: "w", suggestion: null, records: ids.map((id) => ({ type: id.startsWith("d") ? "deal" : "item", id, label: id })), href: "/founder" });
  const ranked = rankRecommendations([
    rec("stale_deal", ["d1"]),
    rec("deadline_soon", ["i2"], "first"),
    rec("follow_up_due", ["d1"]),
    rec("deadline_soon", ["i3"], "second"),
    rec("resolve_overdue", ["i2"]),
    rec("set_priorities", []),
    rec("set_priorities", []),
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ["resolve_overdue:i2", "follow_up_due:d1", "set_priorities", "deadline_soon:i3"]);
  assert.equal(rankRecommendations(Array.from({ length: 9 }, (_, n) => rec("deadline_soon", [`i${n}`]))).length, MAX_RECOMMENDATIONS);
  assert.deepEqual(rankRecommendations([rec("deadline_soon", ["i1"]), rec("deadline_soon", ["i0"])]).map((r) => r.id), ["deadline_soon:i1", "deadline_soon:i0"], "stable: input order kept within a tier");
});

// --- priorities -------------------------------------------------------------------------

test("priorities: the next open one in the founder's order; one recommendation, not three", () => {
  const items = [item({ title: "A" }), item({ title: "B" }), item({ title: "C" })];
  const focus = [{ itemId: "C", date: TODAY, rank: 3 }, { itemId: "A", date: TODAY, rank: 1 }, { itemId: "B", date: TODAY, rank: 2 }];
  let b = brief({ items, focus });
  assert.deepEqual(b.top_priorities.items.map((i) => i.title), ["A", "B", "C"]);
  assert.deepEqual(rules(b), ["finish_priority"]);
  assert.equal(b.best_next_action?.title, "Finish priority 1: A");
  assert.match(b.best_next_action?.why ?? "", /3 of 3 still open/);
  assert.equal(b.best_next_action?.href, PRIORITIES_HREF);

  const done = items.map((i) => (i.title === "A" ? { ...i, completedAt: "2026-10-09T17:00:00Z" } : i));
  b = brief({ items: done, focus });
  assert.equal(b.best_next_action?.title, "Finish priority 2: B");
  assert.deepEqual([b.top_priorities.done, b.top_priorities.total, b.top_priorities.max], [1, 3, 3]);

  const allDone = items.map((i) => ({ ...i, completedAt: "2026-10-09T17:00:00Z" }));
  b = brief({ items: allDone, focus });
  assert.equal(b.best_next_action, null, "all three done and nothing else pending");
  assert.equal(b.workload.prioritiesOpen, 0);
});

test("priorities: suggest choosing them only when none are set and the feature is enabled", () => {
  assert.deepEqual(rules(brief({ items: [item({ title: "x" })] })), ["set_priorities"]);
  assert.deepEqual(rules(brief({ items: [item({ title: "x" })], prioritiesAvailable: false })), [], "not enabled on this database: no nagging");
  const withOne = brief({ items: [item({ title: "x" })], focus: [{ itemId: "x", date: TODAY, rank: 1 }] });
  assert.ok(!rules(withOne).includes("set_priorities"));
  const otherDay = brief({ items: [item({ title: "x" })], focus: [{ itemId: "x", date: "2026-10-10", rank: 1 }] });
  assert.ok(rules(otherDay).includes("set_priorities"), "tomorrow's priorities don't count for today");
});

// --- overdue vs due today ---------------------------------------------------------------

test("overdue vs due today: local-day boundaries decide, not the current time", () => {
  const items = [
    item({ title: "Earlier today", dueAt: "2026-10-09T15:00:00Z" }), // 9am local, already past
    item({ title: "11pm yesterday", dueAt: "2026-10-09T05:00:00Z" }), // Oct 8, 11pm local
    item({ title: "Tonight 11:30pm", dueAt: "2026-10-10T05:30:00Z" }), // still Oct 9 local
  ];
  const b = brief({ items, prioritiesAvailable: false });
  assert.deepEqual(b.today.due.map((i) => i.title), ["Earlier today", "Tonight 11:30pm"]);
  assert.deepEqual(rules(b), ["resolve_overdue"]);
  assert.equal(b.best_next_action?.records[0].id, "11pm yesterday");
  assert.match(b.best_next_action?.why ?? "", /1 day overdue/);
  assert.equal(b.workload.overdue, 1);
  assert.equal(b.workload.dueToday, 2);
});

// --- deals ---------------------------------------------------------------------------------

test("missing next action: late-stage deals outrank deadlines; early-stage deals come after them", () => {
  const items = [item({ title: "Deadline", kind: "deadline", dueAt: "2026-10-11T23:00:00Z" })];
  const deals = [deal({ name: "Early", stage: "outreach", nextAction: null, nextActionAt: null }), deal({ name: "Late", stage: "negotiation", nextAction: null, nextActionAt: null })];
  const b = brief({ items, deals, prioritiesAvailable: false });
  assert.deepEqual(rules(b), ["deal_next_action_late_stage", "deadline_soon", "deal_next_action"]);
  assert.match(b.recommended_actions[0].why, /Negotiation with no next action or follow-up date recorded/);
  assert.equal(b.recommended_actions[0].href, "/founder/deals?deal=Late");
  const withAction = brief({ deals: [deal({ name: "Has action", nextAction: "Call", nextActionAt: null })], prioritiesAvailable: false });
  assert.deepEqual(rules(withAction), [], "a written next action without a date is not 'missing'");
});

test("stale deals: open, no change for 14+ local days, and no upcoming follow-up date", () => {
  const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
  const deals = [
    deal({ name: "13 days", updatedAt: at(13), nextActionAt: null }),
    deal({ name: "14 days", updatedAt: at(STALE_DEAL_DAYS), nextActionAt: null }),
    deal({ name: "40 days but follow-up booked", updatedAt: at(40), nextActionAt: "2026-10-12T16:00:00Z" }),
    deal({ name: "40 days lost", stage: "lost", updatedAt: at(40), nextActionAt: null }),
    deal({ name: "40 days won", stage: "won", updatedAt: at(40), nextActionAt: null }),
  ];
  assert.deepEqual(staleDeals(deals, NOW, TZ).map((d) => d.name), ["14 days"]);
  // Sep 25, 9pm in Denver is Sep 26 in UTC: 14 local days, though only 13 UTC days.
  assert.deepEqual(staleDeals([deal({ name: "Evening edit", updatedAt: "2026-09-26T03:00:00Z", nextActionAt: null })], NOW, TZ).map((d) => d.name), ["Evening edit"], "days are counted on the founder's calendar");
  const b = brief({ deals, prioritiesAvailable: false });
  assert.deepEqual(rules(b), ["stale_deal"]);
  assert.match(b.recommended_actions[0].why, /^No change recorded on this deal since .*\(14 days\), and no upcoming follow-up date\.$/);
  assert.equal(b.recommended_actions[0].suggestion, "It may need a touch - or an update to its stage.", "the inference is labelled separately");
});

test("stale deals are not double-reported when another deal rule already covers them", () => {
  const old = "2026-08-01T16:00:00Z";
  const deals = [deal({ name: "Overdue follow-up", updatedAt: old, nextActionAt: "2026-09-01T16:00:00Z" }), deal({ name: "No step", updatedAt: old, nextAction: null, nextActionAt: null })];
  const b = brief({ deals, prioritiesAvailable: false });
  assert.deepEqual(rules(b), ["follow_up_due", "deal_next_action"]);
  assert.ok(!b.needs_attention.some((e) => e.kind === "stale_deal"));
});

// --- completed items ------------------------------------------------------------------------

test("completed items and closed deals never surface as work", () => {
  const items = [
    item({ title: "Done overdue", dueAt: "2026-10-01T17:00:00Z", completedAt: "2026-10-02T17:00:00Z" }),
    item({ title: "Done follow-up", kind: "follow_up", dueAt: "2026-10-09T22:00:00Z", completedAt: "2026-10-09T19:00:00Z" }),
    item({ title: "Done deadline", kind: "deadline", dueAt: "2026-10-11T22:00:00Z", completedAt: "2026-10-09T19:00:00Z" }),
  ];
  const deals = [deal({ name: "Won", stage: "won", nextAction: null, nextActionAt: null, updatedAt: "2026-08-01T00:00:00Z" }), deal({ name: "Lost", stage: "lost", nextAction: null, nextActionAt: "2026-10-01T00:00:00Z" })];
  const b = brief({ items, deals, prioritiesAvailable: false });
  assert.deepEqual(b.recommended_actions, []);
  assert.deepEqual(b.needs_attention, []);
  assert.equal(b.attention_total, 0);
  assert.deepEqual(b.review_needed, []);
  assert.equal(b.workload.level, "clear");
});

// --- destinations ------------------------------------------------------------------------------

test("destinations: items open on their own local day in the calendar, deals on the deals page", () => {
  const { items, deals, focus } = mixedDay();
  const b = brief({ items, deals, focus });
  const byId = new Map(items.map((i) => [i.id, i]));
  const entries = [...b.recommended_actions.map((r) => ({ href: r.href, record: r.records[0], rule: r.rule as string })), ...b.needs_attention.map((e) => ({ href: e.href, record: e.record, rule: e.kind as string }))];
  for (const { href, record, rule } of entries) {
    if (rule === "finish_priority") assert.equal(href, PRIORITIES_HREF);
    else if (record.type === "deal") assert.equal(href, `/founder/deals?deal=${encodeURIComponent(record.id)}`);
    else {
      const it = byId.get(record.id) as FounderItem;
      const day = localDateKey(new Date((it.startsAt ?? it.dueAt) as string), TZ);
      assert.equal(href, `/founder/calendar?view=day&date=${day}&item=${encodeURIComponent(record.id)}`, rule);
    }
  }
  assert.equal(itemHref(item({ title: "No date" }), TZ, TODAY), "/founder/calendar?view=day&date=2026-10-09&item=No%20date", "undated items open from today (where Unscheduled is listed)");
  assert.equal(itemHref(item({ title: "Late", dueAt: "2026-10-10T05:30:00Z" }), TZ, TODAY), "/founder/calendar?view=day&date=2026-10-09&item=Late", "the local day, not the UTC day");
  assert.equal(dealHref({ id: "a&b" }), "/founder/deals?deal=a%26b", "ids are URL-encoded");
});

// --- empty & incomplete data ---------------------------------------------------------------------

test("empty data: a clear day, an honest message, no invented work", () => {
  const b = brief({ prioritiesAvailable: false });
  assert.equal(b.workload.level, "clear");
  assert.equal(b.workload.summary, "A clear day: nothing scheduled, due or overdue.");
  assert.equal(b.best_next_action, null);
  assert.deepEqual([b.recommended_actions, b.needs_attention, b.review_needed, b.today.schedule, b.today.due], [[], [], [], [], []]);
  assert.deepEqual(b.coming_up.map((d) => d.items.length), [0, 0, 0]);
  assert.equal(brief().best_next_action?.rule, "set_priorities", "with priorities enabled, the one useful nudge");
});

test("workload: counted from today's commitments, with honest wording", () => {
  const items = [
    item({ title: "M1", kind: "meeting", startsAt: "2026-10-09T15:00:00Z" }),
    item({ title: "T1", dueAt: "2026-10-09T23:00:00Z" }),
    item({ title: "Old", dueAt: "2026-10-05T17:00:00Z" }),
  ];
  let b = brief({ items, prioritiesAvailable: false });
  assert.equal(b.workload.level, "light");
  assert.equal(b.workload.summary, "Light day: 1 meeting or event, 1 item due, 1 overdue.");
  const many = Array.from({ length: 8 }, (_, n) => item({ title: `Due ${n}`, dueAt: "2026-10-09T23:00:00Z" }));
  b = brief({ items: many, prioritiesAvailable: false });
  assert.equal(b.workload.level, "heavy");
  b = brief({ items: many.slice(0, 5), prioritiesAvailable: false });
  assert.equal(b.workload.level, "moderate");
  b = brief({ items: [item({ title: "Old", dueAt: "2026-10-05T17:00:00Z" })], prioritiesAvailable: false });
  assert.equal(b.workload.level, "light", "overdue work means the day isn't 'clear'");
});

test("review needed: conflicting or incomplete records are flagged, never changed", () => {
  const items = [
    item({ title: "Call A", kind: "meeting", startsAt: "2026-10-09T16:00:00Z", endsAt: "2026-10-09T17:00:00Z" }),
    item({ title: "Call B", kind: "meeting", startsAt: "2026-10-09T16:30:00Z", endsAt: "2026-10-09T17:30:00Z" }),
    item({ title: "Call C", kind: "meeting", startsAt: "2026-10-09T17:30:00Z", endsAt: "2026-10-09T18:00:00Z" }), // touches B's end: no conflict
    item({ title: "Holiday", kind: "event", startsAt: "2026-10-09T06:00:00Z", endsAt: "2026-10-10T06:00:00Z" }), // all day: no conflict
    item({ title: "Send docs", dealId: "Closed" }),
  ];
  const deals = [
    deal({ name: "Closed", stage: "lost" }),
    deal({ name: "Date only", nextAction: null, nextActionAt: "2026-10-20T16:00:00Z" }),
    deal({ name: "Late no value", stage: "negotiation", expectedMrr: null }),
  ];
  const b = brief({ items, deals, prioritiesAvailable: false });
  assert.deepEqual(b.review_needed.map((f) => f.id), [
    "schedule_conflict:Call A+Call B",
    "follow_up_without_action:Date only",
    "late_deal_without_value:Late no value",
    "open_item_on_closed_deal:Send docs",
  ]);
  assert.deepEqual(scheduleConflicts(b.today.schedule, TZ).length, 1);
});

// --- prepare meeting window ----------------------------------------------------------------------

test("prepare for a meeting only when it starts within the next two hours", () => {
  const items = [
    item({ title: "Started", kind: "meeting", startsAt: "2026-10-09T19:30:00Z" }),
    item({ title: "In 90 min", kind: "meeting", startsAt: "2026-10-09T21:30:00Z" }),
    item({ title: "In 3 hours", kind: "meeting", startsAt: "2026-10-09T23:00:00Z" }),
  ];
  assert.deepEqual(recIds(brief({ items, prioritiesAvailable: false })), ["In 90 min"]);
});

// --- local day & DST ----------------------------------------------------------------------------

test("DST: the day the clocks fall back still has its full local span, and stale counts local days", () => {
  // Sunday Nov 1 2026: Denver goes from MDT (UTC-6) to MST (UTC-7) at 2am.
  const now = new Date("2026-11-01T18:00:00Z"); // 11am MST
  const items = [
    item({ title: "Late Sunday", dueAt: "2026-11-02T06:30:00Z" }), // 11:30pm MST, still Nov 1
    item({ title: "Saturday night", dueAt: "2026-11-01T05:30:00Z" }), // 11:30pm MDT Oct 31: overdue
  ];
  const deals = [deal({ name: "Stale across DST", updatedAt: "2026-10-18T18:00:00Z", nextActionAt: null })];
  const b = brief({ items, deals, now, prioritiesAvailable: false });
  assert.equal(b.date, "2026-11-01");
  assert.deepEqual(b.today.due.map((i) => i.title), ["Late Sunday"]);
  assert.deepEqual(b.needs_attention.concat().length + b.recommended_actions.length, 2);
  assert.equal(b.recommended_actions[0].records[0].id, "Saturday night");
  assert.match(b.recommended_actions[1].why, /\(14 days\)/, "Oct 18 to Nov 1 is 14 local days despite the 25-hour day");
  assert.equal(b.greeting, "Good morning");
});

test("greeting follows the founder's local hour, not the server's", () => {
  assert.equal(brief({ now: new Date("2026-10-09T15:00:00Z") }).greeting, "Good morning"); // 9am
  assert.equal(brief({ now: new Date("2026-10-09T20:00:00Z") }).greeting, "Good afternoon"); // 2pm
  assert.equal(brief({ now: new Date("2026-10-10T01:00:00Z") }).greeting, "Good evening"); // 7pm Oct 9
  assert.equal(brief({ now: new Date("2026-10-10T01:00:00Z"), timeZone: "Asia/Tokyo" }).greeting, "Good morning"); // 10am Oct 10
});

// --- end of day ------------------------------------------------------------------------------------

test("end-of-day summary: only what the records confirm", () => {
  const items = [
    item({ title: "P1", completedAt: "2026-10-09T18:00:00Z" }),
    item({ title: "P2" }),
    item({ title: "Due done", dueAt: "2026-10-09T17:00:00Z", completedAt: "2026-10-09T17:30:00Z" }),
    item({ title: "Due open", dueAt: "2026-10-09T23:00:00Z" }),
    item({ title: "Old open", dueAt: "2026-10-01T17:00:00Z" }),
    item({ title: "Meeting", kind: "meeting", startsAt: "2026-10-09T16:00:00Z", dueAt: "2026-10-09T16:00:00Z" }), // meetings are never commitments, even with a due date
    item({ title: "Tomorrow pick" }),
  ];
  const deals = [
    deal({ name: "Won today", stage: "won", wonOn: TODAY, wonSetupFee: 1000, wonMonthlyFee: 200.5, updatedAt: "2026-10-09T19:00:00Z" }),
    deal({ name: "New today", createdAt: "2026-10-09T15:00:00Z", updatedAt: "2026-10-09T15:00:00Z" }),
    deal({ name: "Untouched", updatedAt: "2026-10-01T15:00:00Z" }),
  ];
  const focus = [{ itemId: "P1", date: TODAY, rank: 1 }, { itemId: "P2", date: TODAY, rank: 2 }, { itemId: "Tomorrow pick", date: "2026-10-10", rank: 1 }];
  const s = buildEndOfDaySummary({ items, deals, focus, dayKey: TODAY, timeZone: TZ });
  assert.deepEqual(
    { completed: s.completed, committed: s.committed, committedDone: s.committedDone, unfinished: s.unfinished, stillOverdue: s.stillOverdue, dealChanges: s.dealChanges, wonSetup: s.wonSetup, wonMonthly: s.wonMonthly, tomorrowPriorities: s.tomorrowPriorities },
    { completed: 2, committed: 4, committedDone: 2, unfinished: 1, stillOverdue: 1, dealChanges: 2, wonSetup: { USD: 1000 }, wonMonthly: { USD: 200.5 }, tomorrowPriorities: 1 },
  );
  assert.equal(s.sentence, "2 of 4 commitments done; 2 items completed; 1 still open; 1 overdue from earlier; 2 deal changes (won: $1,000 setup + $200.50/mo agreed); 1 of 3 priorities set for Saturday.");

  const empty = buildEndOfDaySummary({ items: [], deals: [], focus: [], dayKey: TODAY, timeZone: TZ });
  assert.equal(empty.sentence, "No commitments were set; 0 items completed; no deal changes; no priorities set for Saturday yet.");
});

// --- sales history: the Deals page's definitions ---------------------------------------------

const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
let actSeq = 0;
const act = (dealId: string, kind: DealActivity["kind"], occurredAt: string, o: Partial<DealActivity> = {}): DealActivity => ({
  id: `act${++actSeq}`, dealId, kind, occurredAt, channel: null, scheduledFor: null, summary: null, fromStage: null, toStage: null, setupFee: null, monthlyFee: null, currency: null, voidedAt: null, voidReason: null, recordedAt: occurredAt, ...o,
});

function salesDay() {
  const deals = [
    deal({ name: "Stalled", stage: "meeting_held", nextAction: "Call", nextActionAt: null, lastActivityAt: daysAgo(20), updatedAt: daysAgo(20) }),
    deal({ name: "Cold", stage: "outreach", nextAction: "Email", nextActionAt: null, lastActivityAt: daysAgo(15), updatedAt: daysAgo(15) }),
    deal({ name: "Met", stage: "meeting_booked", nextAction: "Prep", nextActionAt: "2026-10-20T16:00:00Z", lastActivityAt: daysAgo(10) }),
    deal({ name: "Proposal", stage: "proposal_sent", nextAction: "Wait", nextActionAt: "2026-10-15T16:00:00Z", lastActivityAt: daysAgo(5) }),
    deal({ name: "Fresh identified", stage: "identified", nextAction: "Research", nextActionAt: null, updatedAt: daysAgo(20) }),
    deal({ name: "Covered", stage: "replied", nextAction: null, nextActionAt: null, lastActivityAt: daysAgo(30), updatedAt: daysAgo(30) }),
  ];
  const activities = [
    act("Stalled", "meeting_held", daysAgo(20)),
    act("Cold", "outreach", daysAgo(25)),
    act("Cold", "outreach", daysAgo(20)),
    act("Cold", "outreach", daysAgo(15)),
    act("Met", "meeting_booked", daysAgo(10), { scheduledFor: "2026-10-07T17:00:00Z" }),
    act("Proposal", "proposal_sent", daysAgo(5)),
    act("Covered", "reply_received", daysAgo(30)),
  ];
  return { deals, activities };
}

/** Every deal signal on Home - recommended or under needs attention - as kind -> deal ids. */
function dealSignals(b: FounderBriefing): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const push = (kind: string, id: string) => (out[kind] = [...(out[kind] ?? []), id]);
  for (const r of b.recommended_actions) for (const rec of r.records) if (rec.type === "deal") push(r.rule, rec.id);
  for (const e of b.needs_attention) if (e.record.type === "deal") push(e.kind, e.record.id);
  return out;
}

test("sales history loaded: Home reports exactly what the Deals page reports, once per deal", () => {
  const { deals, activities } = salesDay();
  const b = brief({ deals, prioritiesAvailable: false, salesHistory: { status: "loaded", data: activities } });
  const sales = buildSalesToday({ deals, activities, items: [], now: NOW, timeZone: TZ, todayKey: TODAY });
  const covered = new Set(["Covered"]); // no next action: reported as that, not again as stalled
  const ids = (list: { deal: FounderDeal }[]) => list.map((e) => e.deal.id).filter((id) => !covered.has(id));
  const signals = dealSignals(b);
  assert.deepEqual(signals.stalled_deal, ids(sales.stalled));
  assert.deepEqual(signals.cold_prospect, ids(sales.cold));
  assert.deepEqual(signals.record_meeting_outcome, ids(sales.outcomeMissing));
  assert.deepEqual(signals.proposal_waiting, ids(sales.proposalsWaiting));
  assert.deepEqual(sales.stalled.map((e) => e.deal.id).sort(), ["Covered", "Stalled"], "Deals lists both; Home shows Covered once, as its missing next step");
  assert.deepEqual(signals.deal_next_action, ["Covered"]);
  assert.equal(signals.stale_deal, undefined, "the fallback rule is off when the history is readable");
  assert.ok(!Object.values(signals).flat().includes("Fresh identified"), "a dated-less next action at Identified isn't stalled on Deals, so not on Home");
  const all = Object.values(signals).flat();
  assert.equal(new Set(all).size, all.length, "each deal appears in one place only");
  assert.deepEqual(rules(b), ["record_meeting_outcome", "deal_next_action", "stalled_deal", "cold_prospect"], "fixed tiers: meetings, missing steps, then maintenance");
  assert.match(b.recommended_actions[0].why, /^The meeting logged as booked for Wed, Oct 7, 11:00\s?AM has no held or no-show recorded since\.$/);
  assert.equal(b.recommended_actions[0].href, "/founder/deals?deal=Met");
  assert.match(b.recommended_actions[2].why, /^No activity recorded for 20 days, nothing scheduled \(deal at Meeting held\)\.$/);
  assert.match(b.recommended_actions[3].why, /^3 outreach attempts recorded, last 15 days ago, no reply recorded\.$/);
  assert.deepEqual(b.coverage, { salesHistory: "loaded", handoffs: "unavailable" });
});

test("sales history: a calendar meeting and a logged booking for the same deal give one recommendation", () => {
  const deals = [deal({ name: "Twice", stage: "meeting_booked", nextActionAt: "2026-10-20T16:00:00Z" })];
  const items = [item({ title: "Call with Twice", kind: "meeting", dealId: "Twice", startsAt: "2026-10-06T17:00:00Z", endsAt: "2026-10-06T17:30:00Z" })];
  const activities = [act("Twice", "meeting_booked", daysAgo(9), { scheduledFor: "2026-10-08T17:00:00Z" })];
  const b = brief({ deals, items, prioritiesAvailable: false, salesHistory: { status: "loaded", data: activities } });
  assert.deepEqual(rules(b), ["record_meeting_outcome"]);
  assert.match(b.recommended_actions[0].why, /on your calendar for Tue, Oct 6/, "the earliest missing outcome, as Deals orders them");
  const heldFirst = brief({ deals, items, prioritiesAvailable: false, salesHistory: { status: "loaded", data: [...activities, act("Twice", "meeting_held", "2026-10-06T18:00:00Z")] } });
  assert.match(heldFirst.recommended_actions[0]?.why ?? "", /logged as booked for Thu, Oct 8/, "an outcome clears only the meetings it follows, as on Deals");
  const heldBoth = brief({ deals, items, prioritiesAvailable: false, salesHistory: { status: "loaded", data: [...activities, act("Twice", "meeting_held", "2026-10-08T18:00:00Z")] } });
  assert.deepEqual(rules(heldBoth), [], "a recorded outcome after both meetings clears them");
});

test("sales history unreadable: the older stale rule is used, and the briefing says what wasn't checked", () => {
  const { deals, activities } = salesDay();
  for (const status of ["failed", "unavailable"] as const) {
    const b = brief({ deals, prioritiesAvailable: false, salesHistory: { status } });
    const signals = dealSignals(b);
    assert.deepEqual(signals.stale_deal, ["Fresh identified", "Stalled", "Cold"], status);
    for (const kind of ["stalled_deal", "cold_prospect", "record_meeting_outcome", "meeting_outcome_missing", "proposal_waiting"]) assert.equal(signals[kind], undefined, `${status}: ${kind}`);
    assert.equal(b.coverage.salesHistory, status);
  }
  assert.equal(brief({ deals }).coverage.salesHistory, "unavailable", "omitted = not loaded, never 'checked'");
  assert.notDeepEqual(dealSignals(brief({ deals, salesHistory: { status: "loaded", data: activities } })), dealSignals(brief({ deals })));
});

// --- client handoffs ----------------------------------------------------------------------------

const wonDeal = (o: Partial<FounderDeal> & { name: string }) => deal({ stage: "won", nextAction: null, nextActionAt: null, wonSetupFee: 1000, wonMonthlyFee: 500, contactName: "Dana", contactEmail: "dana@example.com", ...o });
const handoff = (d: FounderDeal, o: Partial<ClientHandoff> = {}): ClientHandoff => ({
  id: `h-${d.id}`, dealId: d.id, status: "prepared", clientName: d.name, contactName: d.contactName ?? "", contactEmail: d.contactEmail, contactPhone: d.contactPhone, setupFee: d.wonSetupFee ?? 0, monthlyFee: d.wonMonthlyFee ?? 0, currency: d.currency, scope: "Website and ads", preparedBy: "me", preparedAt: "2026-10-05T16:00:00Z", confirmedBy: null, confirmedAt: null, cancelledBy: null, cancelledAt: null, cancelReason: null, agencyClientId: null, ...o,
});

function handoffDay() {
  const ready = wonDeal({ name: "Ready", wonOn: "2026-10-02" });
  const missing = wonDeal({ name: "Missing", wonOn: "2026-10-03", contactName: null });
  const waiting = wonDeal({ name: "Waiting", wonOn: "2026-09-20" });
  const changed = wonDeal({ name: "Changed", wonOn: "2026-10-01" });
  const reopened = deal({ name: "Reopened", stage: "negotiation", nextActionAt: "2026-10-20T16:00:00Z" });
  const confirmedOld = wonDeal({ name: "Done", wonOn: "2026-09-01" });
  const handoffs = [
    handoff(waiting),
    handoff(changed, { monthlyFee: 400 }),
    handoff(reopened, { status: "confirmed", clientName: "Reopened", contactName: "Dana", setupFee: 1000, monthlyFee: 500, confirmedAt: "2026-10-06T16:00:00Z", agencyClientId: "c1" }),
    handoff(confirmedOld, { status: "confirmed", confirmedAt: "2026-09-02T16:00:00Z", agencyClientId: "c2" }),
    handoff(ready, { id: "h-cancelled", status: "cancelled", cancelledAt: "2026-10-03T16:00:00Z" }),
  ];
  return { deals: [ready, missing, waiting, changed, reopened, confirmedOld], handoffs };
}

test("handoffs: won deals to hand off, complete or redo are actions; a current one only waits", () => {
  const { deals, handoffs } = handoffDay();
  const b = brief({ deals, prioritiesAvailable: false, handoffs: { status: "loaded", data: handoffs } });
  assert.deepEqual(rules(b), ["client_handoff", "client_handoff", "client_handoff"]);
  assert.deepEqual(b.recommended_actions.map((r) => r.title), ["Redo the client handoff for Changed", "Prepare the client handoff for Ready", "Complete Missing for its client handoff"], "ordered by won date, then name");
  assert.match(b.recommended_actions[1].why, /no handoff prepared yet/, "a cancelled handoff can be redone");
  assert.match(b.recommended_actions[2].why, /needs a decision-maker name\.$/);
  assert.ok(b.recommended_actions.every((r) => r.href === `/founder/deals?deal=${r.records[0].id}`));
  assert.deepEqual(b.needs_attention.filter((e) => e.kind === "handoff_waiting").map((e) => e.record.id), ["Waiting"]);
  assert.match(b.needs_attention.find((e) => e.kind === "handoff_waiting")?.detail ?? "", /waiting for an agency admin to confirm/);
  assert.deepEqual(b.review_needed.filter((f) => f.kind === "handoff_on_reopened_deal").map((f) => f.records[0].id), ["Reopened"]);
  assert.ok(!Object.values(dealSignals(b)).flat().includes("Done") && !b.review_needed.some((f) => f.records.some((r) => r.id === "Done")), "a confirmed handoff on a won deal needs nothing");
  assert.equal(b.coverage.handoffs, "loaded");
});

test("handoffs rank as client commitments: after meetings and late-stage next steps, before deadlines and upkeep", () => {
  const { deals, handoffs } = handoffDay();
  const items = [item({ title: "Tax filing", kind: "deadline", dueAt: "2026-10-11T23:00:00Z" })];
  const extra = [deal({ name: "Late", stage: "negotiation", nextAction: null, nextActionAt: null }), deal({ name: "Met", stage: "meeting_booked", nextActionAt: "2026-10-20T16:00:00Z" })];
  const activities = [act("Met", "meeting_booked", daysAgo(5), { scheduledFor: "2026-10-08T17:00:00Z" })];
  const b = brief({ items, deals: [...extra, ...deals.filter((d) => d.name === "Ready")], prioritiesAvailable: false, salesHistory: { status: "loaded", data: activities }, handoffs: { status: "loaded", data: handoffs } });
  assert.deepEqual(rules(b), ["record_meeting_outcome", "deal_next_action_late_stage", "client_handoff", "deadline_soon"]);
});

test("handoffs not loaded: no handoff signals, and the briefing says won deals weren't checked", () => {
  const { deals } = handoffDay();
  for (const status of ["failed", "unavailable"] as const) {
    const b = brief({ deals, prioritiesAvailable: false, handoffs: { status } });
    assert.ok(!b.recommended_actions.some((r) => r.rule === "client_handoff"), status);
    assert.ok(!b.needs_attention.some((e) => e.kind === "client_handoff" || e.kind === "handoff_waiting"), status);
    assert.ok(!b.review_needed.some((f) => f.kind === "handoff_on_reopened_deal"), status);
    assert.match(coverageStatement(b.coverage).notChecked.join(" "), status === "failed" ? /client handoffs didn't load/ : /client handoffs aren't enabled/);
  }
});

// --- combined: ranking, dedup, caps, determinism ---------------------------------------------------

test("combined: fixed tiers, one place per record, five recommendations and three priorities at most", () => {
  const { items, deals, focus } = mixedDay();
  const sales = salesDay();
  const hand = handoffDay();
  const allDeals = [...deals, ...sales.deals, ...hand.deals];
  const input = { items, deals: allDeals, focus: [...focus, { itemId: "Old chore", date: TODAY, rank: 3 }], salesHistory: { status: "loaded" as const, data: sales.activities }, handoffs: { status: "loaded" as const, data: hand.handoffs } };
  const b = brief(input);
  assert.deepEqual([b.top_priorities.items.length, b.top_priorities.max], [3, 3], "three priorities, unchanged by the new sources");
  assert.equal(b.recommended_actions.length, MAX_RECOMMENDATIONS);
  const tiers = b.recommended_actions.map((r) => RECOMMENDATION_TIERS.indexOf(r.rule));
  assert.deepEqual(tiers, [...tiers].sort((x, y) => x - y));
  const keys = [...b.recommended_actions.flatMap((r) => r.records.map((x) => `${x.type}:${x.id}`)), ...b.needs_attention.map((e) => `${e.record.type}:${e.record.id}`)];
  assert.equal(new Set(keys).size, keys.length, "no record is both recommended and listed, or listed twice");
  const reversed = brief({ ...input, items: [...items].reverse(), deals: [...allDeals].reverse(), focus: [...input.focus].reverse(), salesHistory: { status: "loaded", data: [...sales.activities].reverse() }, handoffs: { status: "loaded", data: [...hand.handoffs].reverse() } });
  assert.deepEqual(JSON.parse(JSON.stringify(reversed)), JSON.parse(JSON.stringify(b)), "deterministic whatever the input order");
  for (const rec of b.recommended_actions) if (rec.suggestion) assert.doesNotMatch(rec.suggestion, /\d/);
});

test("new sources are never modified", () => {
  const sales = salesDay();
  const hand = handoffDay();
  const deals = [...sales.deals, ...hand.deals];
  const before = JSON.stringify({ deals, a: sales.activities, h: hand.handoffs });
  deepFreeze(deals);
  deepFreeze(sales.activities);
  deepFreeze(hand.handoffs);
  assert.doesNotThrow(() => brief({ deals, salesHistory: { status: "loaded", data: sales.activities }, handoffs: { status: "loaded", data: hand.handoffs } }));
  assert.equal(JSON.stringify({ deals, a: sales.activities, h: hand.handoffs }), before);
});

test("coverage statement: the all-clear names what was checked, and every source that wasn't", () => {
  assert.deepEqual(coverageStatement({ salesHistory: "loaded", handoffs: "loaded" }), {
    checked: "no open priorities, nothing overdue, no follow-up due today, no deadline in the next 3 days, no meeting in the next 2 hours, every open deal has a next step that isn't due yet, no meeting is missing its outcome, no deal has stalled or gone cold, and every won deal's client handoff is in hand",
    notChecked: [],
  });
  const partial = coverageStatement({ salesHistory: "failed", handoffs: "unavailable" });
  assert.equal(partial.checked, "no open priorities, nothing overdue, no follow-up due today, no deadline in the next 3 days, no meeting in the next 2 hours, every open deal has a next step that isn't due yet, and no open deal has gone 14 days without a change");
  assert.doesNotMatch(partial.checked, /due soon|nothing due/, "tasks due later today aren't a recommendation, so they aren't claimed");
  assert.deepEqual(partial.notChecked, [
    "sales history didn't load, so meeting outcomes, stalled deals and cold prospects weren't checked",
    "client handoffs aren't enabled on this database, so won deals weren't checked for a handoff",
  ]);
  assert.doesNotMatch(partial.checked, /outcome|stalled|cold|handoff/, "never claims a check that didn't run");
});
