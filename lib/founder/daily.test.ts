/**
 * The founder's day (lib/founder/daily.ts): which section each item lands in
 * (exactly one), overdue vs due-today, completed items, follow-ups, deadline
 * window, deals with no next action, upcoming days across DST, daily
 * progress, priority order, and the end-of-day closeout.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/founder/daily.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDailyPlan, prioritiesFor, reviewDay } from "./daily";
import type { FounderDeal, FounderItem } from "./model";

const TZ = "America/Denver";
const item = (o: Partial<FounderItem> & { title: string }): FounderItem => ({ id: o.title, kind: "task", notes: null, priority: "medium", dueAt: null, startsAt: null, endsAt: null, completedAt: null, dealId: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...o });
const deal = (o: Partial<FounderDeal> & { name: string }): FounderDeal => ({ id: o.name, contactName: null, contactEmail: null, stage: "lead", expectedMrr: null, nextAction: "Call", nextActionAt: null, wonAmount: null, wonOn: null, lostReason: null, notes: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...o });
const titles = (list: { title: string }[]) => list.map((i) => i.title);

// Friday Oct 9 2026, 2:00pm in Denver (MDT, UTC-6).
const NOW = new Date("2026-10-09T20:00:00Z");
const TODAY = "2026-10-09";

test("every item lands in exactly one section, in precedence order", () => {
  const items = [
    item({ title: "Priority (also due today)", dueAt: "2026-10-09T23:00:00Z" }),
    item({ title: "Standup", kind: "meeting", startsAt: "2026-10-09T15:00:00Z" }),
    item({ title: "Late night call", kind: "meeting", startsAt: "2026-10-10T04:30:00Z" }), // 10:30pm Oct 9 local
    item({ title: "Due this morning", dueAt: "2026-10-09T16:00:00Z" }), // passed today: still "due today", not "overdue"
    item({ title: "Due yesterday", dueAt: "2026-10-09T05:00:00Z" }), // 11pm Oct 8 local
    item({ title: "Follow-up today", kind: "follow_up", dueAt: "2026-10-09T22:00:00Z" }),
    item({ title: "Deadline Monday", kind: "deadline", dueAt: "2026-10-12T22:00:00Z" }),
    item({ title: "Deadline far", kind: "deadline", dueAt: "2026-10-20T22:00:00Z" }),
    item({ title: "Tomorrow task", dueAt: "2026-10-10T18:00:00Z" }),
    item({ title: "Done today", dueAt: "2026-10-09T17:00:00Z", completedAt: "2026-10-09T17:30:00Z" }),
    item({ title: "Undated" }),
  ];
  const plan = buildDailyPlan({ items, deals: [], focus: [{ itemId: "Priority (also due today)", date: TODAY, rank: 1 }], now: NOW, timeZone: TZ, todayKey: TODAY });
  assert.deepEqual(titles(plan.priorities), ["Priority (also due today)"]);
  assert.deepEqual(titles(plan.schedule), ["Standup", "Late night call"], "ordered by local start; 10:30pm local is still today");
  assert.deepEqual(titles(plan.dueToday), ["Due this morning"], "the priority isn't repeated; follow-ups go to attention; done items are left out");
  assert.deepEqual(titles(plan.attention.overdue), ["Due yesterday"]);
  assert.deepEqual(titles(plan.attention.followUpsToday), ["Follow-up today"]);
  assert.deepEqual(titles(plan.attention.deadlinesSoon), ["Deadline Monday"]);
  const upcoming = plan.upcoming.flatMap((d) => titles(d.items));
  assert.deepEqual(upcoming, ["Tomorrow task"], "the soon deadline isn't repeated; far deadlines and undated items aren't 'coming up'");
  const all = [...plan.priorities, ...plan.schedule, ...plan.dueToday, ...plan.attention.overdue, ...plan.attention.followUpsToday, ...plan.attention.deadlinesSoon, ...plan.upcoming.flatMap((d) => d.items)];
  assert.equal(new Set(all.map((i) => i.id)).size, all.length, "no item appears twice");
});

test("progress: priorities plus non-event items due today, done or not", () => {
  const items = [
    item({ title: "P1", completedAt: "2026-10-09T18:00:00Z" }),
    item({ title: "P2" }),
    item({ title: "Due A", dueAt: "2026-10-09T17:00:00Z", completedAt: "2026-10-09T16:00:00Z" }),
    item({ title: "Due B", dueAt: "2026-10-09T23:59:00Z" }),
    item({ title: "Meeting", kind: "meeting", startsAt: "2026-10-09T15:00:00Z" }),
    item({ title: "Tomorrow", dueAt: "2026-10-10T18:00:00Z", completedAt: "2026-10-09T18:00:00Z" }),
  ];
  const focus = [{ itemId: "P2", date: TODAY, rank: 2 }, { itemId: "P1", date: TODAY, rank: 1 }, { itemId: "Tomorrow", date: "2026-10-10", rank: 1 }];
  const plan = buildDailyPlan({ items, deals: [], focus, now: NOW, timeZone: TZ, todayKey: TODAY });
  assert.deepEqual(titles(plan.priorities), ["P1", "P2"], "rank order, today's only");
  assert.deepEqual(plan.progress, { done: 2, total: 4 }, "P1 + Due A of P1, P2, Due A, Due B; meetings and other days don't count");
  assert.deepEqual(buildDailyPlan({ items: [], deals: [], focus: [], now: NOW, timeZone: TZ, todayKey: TODAY }).progress, { done: 0, total: 0 });
  assert.deepEqual(titles(prioritiesFor(items, [{ itemId: "gone", date: TODAY, rank: 1 }, ...focus], TODAY)), ["P1", "P2"], "a marked item that no longer loads is skipped");
});

test("deals needing attention: next action due, or none set; closed deals ignored", () => {
  const deals = [
    deal({ name: "Due", nextActionAt: "2026-10-09T18:00:00Z" }),
    deal({ name: "Later", nextActionAt: "2026-10-12T18:00:00Z" }),
    deal({ name: "No action", nextAction: null, nextActionAt: null }),
    deal({ name: "Text only", nextAction: "Send deck", nextActionAt: null }),
    deal({ name: "Won", stage: "won", nextAction: null }),
  ];
  const plan = buildDailyPlan({ items: [], deals, focus: [], now: NOW, timeZone: TZ, todayKey: TODAY });
  assert.deepEqual(plan.attention.dealFollowUps.map((d) => d.name), ["Due"]);
  assert.deepEqual(plan.attention.dealsWithoutNextAction.map((d) => d.name), ["No action"]);
  assert.equal(plan.attentionCount, 2);
});

test("upcoming days and 'today' follow local days across the November DST change", () => {
  // Saturday Oct 31 2026, noon MDT. DST ends Sunday Nov 1 at 2am.
  const now = new Date("2026-10-31T18:00:00Z");
  const items = [
    item({ title: "Sun 11:30pm", dueAt: "2026-11-02T06:30:00Z" }), // MST (UTC-7): 11:30pm Nov 1 local
    item({ title: "Mon 12:30am", dueAt: "2026-11-02T07:30:00Z" }), // 12:30am Nov 2 local
    item({ title: "Tue 9am", kind: "meeting", startsAt: "2026-11-03T16:00:00Z" }),
    item({ title: "Wed early", dueAt: "2026-11-04T08:00:00Z" }), // 1am Nov 4 local - outside the 3-day window
    item({ title: "Sat 11:30pm", dueAt: "2026-11-01T05:30:00Z" }), // 11:30pm Oct 31 MDT - still today
  ];
  const plan = buildDailyPlan({ items, deals: [], focus: [], now, timeZone: TZ, todayKey: "2026-10-31" });
  assert.deepEqual(titles(plan.dueToday), ["Sat 11:30pm"]);
  assert.deepEqual(plan.upcoming.map((d) => [d.day, titles(d.items)]), [
    ["2026-11-01", ["Sun 11:30pm"]],
    ["2026-11-02", ["Mon 12:30am"]],
    ["2026-11-03", ["Tue 9am"]],
  ]);
});

test("end-of-day review: done that day, still open, still overdue, and what changed in the pipeline", () => {
  const items = [
    item({ title: "Finished", dueAt: "2026-10-09T17:00:00Z", completedAt: "2026-10-09T18:00:00Z" }),
    item({ title: "Finished early", completedAt: "2026-10-09T07:00:00Z" }), // 1am local
    item({ title: "Finished yesterday", completedAt: "2026-10-09T05:00:00Z" }), // 11pm Oct 8 local
    item({ title: "Not done", dueAt: "2026-10-09T22:00:00Z" }),
    item({ title: "Old overdue", kind: "follow_up", dueAt: "2026-10-07T18:00:00Z" }),
    item({ title: "Meeting", kind: "meeting", startsAt: "2026-10-09T15:00:00Z" }),
  ];
  const deals = [
    deal({ name: "New", createdAt: "2026-10-09T16:00:00Z", updatedAt: "2026-10-09T16:00:00Z" }),
    deal({ name: "Closed", stage: "won", wonOn: TODAY, wonAmount: 500, updatedAt: "2026-10-09T19:00:00Z" }),
    deal({ name: "Dropped", stage: "lost", updatedAt: "2026-10-09T19:00:00Z" }),
    deal({ name: "Touched", stage: "negotiation", updatedAt: "2026-10-09T21:00:00Z" }),
    deal({ name: "Quiet", updatedAt: "2026-10-01T00:00:00Z" }),
  ];
  const r = reviewDay({ items, deals, dayKey: TODAY, timeZone: TZ });
  assert.deepEqual(titles(r.completed), ["Finished early", "Finished"]);
  assert.deepEqual(titles(r.unfinished), ["Not done"], "meetings aren't 'unfinished work'");
  assert.deepEqual(titles(r.stillOverdue), ["Old overdue"]);
  assert.deepEqual([r.pipeline.created, r.pipeline.won, r.pipeline.lost, r.pipeline.updated].map((l) => l.map((d) => d.name)), [["New"], ["Closed"], ["Dropped"], ["Touched"]]);
});
