/**
 * Founder Command Center model (lib/founder/model.ts): input parsing, the
 * founder's time zone, task views and overdue rules, MRR arithmetic (actuals
 * vs forecasts) and pipeline summaries.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/founder/model.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayRange,
  filterItems,
  filterDeals,
  isOverdue,
  localDateKey,
  mrrHistory,
  mrrSnapshot,
  parseDealInput,
  parseItemInput,
  parseLocalDateTime,
  parseMrrInput,
  parseReviewInput,
  pipelineSummary,
  dealsNeedingFollowUp,
  toLocalInputValue,
  type FounderDeal,
  type FounderItem,
  type MrrEntry,
} from "./model";

const TZ = "America/Denver";

test("time: local days and inputs are in the founder's zone, DST-correct", () => {
  assert.equal(localDateKey(new Date("2026-10-10T05:30:00Z"), TZ), "2026-10-09", "11:30pm in Denver is still the 9th");
  const { start, end } = dayRange("2026-10-09", TZ);
  assert.equal(start.toISOString(), "2026-10-09T06:00:00.000Z");
  assert.equal(end.toISOString(), "2026-10-10T06:00:00.000Z");
  const dst = dayRange("2026-11-01", TZ); // the fall-back day is 25 hours long
  assert.equal(dst.end.getTime() - dst.start.getTime(), 25 * 3_600_000);
  assert.deepEqual(parseLocalDateTime("2026-10-09T14:30", TZ), { ok: true, value: "2026-10-09T20:30:00.000Z" });
  assert.equal(toLocalInputValue("2026-10-09T20:30:00.000Z", TZ), "2026-10-09T14:30");
  assert.deepEqual(parseLocalDateTime("", TZ), { ok: true, value: null });
  assert.equal(parseLocalDateTime("2026-02-31T10:00", TZ).ok, false, "no rollover into March");
  assert.equal(parseLocalDateTime("tomorrow", TZ).ok, false);
});

test("items: validation, events need a start, end after start, tasks drop event times", () => {
  const task = parseItemInput({ kind: "task", title: "  Send proposal ", priority: "high", dueAt: "2026-10-09T17:00", startsAt: "" }, TZ);
  assert.ok(task.ok);
  assert.equal(task.value.title, "Send proposal");
  assert.equal(task.value.priority, "high");
  assert.equal(parseItemInput({ kind: "meeting", title: "Demo" }, TZ).ok, false, "meeting without start");
  assert.equal(parseItemInput({ kind: "meeting", title: "Demo", startsAt: "2026-10-09T10:00", endsAt: "2026-10-09T09:00" }, TZ).ok, false);
  const meeting = parseItemInput({ kind: "meeting", title: "Demo", startsAt: "2026-10-09T10:00", dueAt: "2026-10-09T09:00" }, TZ);
  assert.ok(meeting.ok && meeting.value.dueAt === null, "an event's time is its start, not a due date");
  assert.equal(parseItemInput({ kind: "task", title: "" }, TZ).ok, false);
  assert.equal(parseItemInput({ kind: "reminder", title: "x" }, TZ).ok, false);
  assert.equal(parseItemInput({ kind: "task", title: "x", priority: "urgent" }, TZ).ok, false);
  assert.equal(parseItemInput({ kind: "task", title: "x".repeat(301) }, TZ).ok, false);
});

const item = (over: Partial<FounderItem>): FounderItem => ({ id: Math.random().toString(36), kind: "task", title: "t", notes: null, priority: "medium", dueAt: null, startsAt: null, endsAt: null, completedAt: null, dealId: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...over });

test("views: today includes overdue; events are never overdue; upcoming is the next 14 days; undated items are open", () => {
  const now = new Date("2026-10-09T18:00:00Z"); // noon in Denver
  const today = dayRange("2026-10-09", TZ);
  const late = item({ title: "late", dueAt: "2026-10-08T18:00:00Z" });
  const laterToday = item({ title: "later today", dueAt: "2026-10-09T23:00:00Z", priority: "high" });
  const pastMeeting = item({ title: "morning meeting", kind: "meeting", startsAt: "2026-10-09T15:00:00Z" });
  const nextWeek = item({ title: "next week", kind: "deadline", dueAt: "2026-10-15T18:00:00Z" });
  const farOff = item({ title: "far", dueAt: "2026-11-30T18:00:00Z" });
  const undated = item({ title: "someday" });
  const done = item({ title: "done", dueAt: "2026-10-08T18:00:00Z", completedAt: "2026-10-09T16:00:00Z" });
  const all = [late, laterToday, pastMeeting, nextWeek, farOff, undated, done];
  assert.equal(isOverdue(late, now), true);
  assert.equal(isOverdue(pastMeeting, now), false);
  assert.equal(isOverdue(done, now), false, "completed is never overdue");
  const titles = (view: Parameters<typeof filterItems>[1]) => filterItems(all, view, now, today).map((i) => i.title);
  assert.deepEqual(titles("today"), ["late", "morning meeting", "later today"]);
  assert.deepEqual(titles("overdue"), ["late"]);
  assert.deepEqual(titles("upcoming"), ["next week"]);
  assert.ok(titles("open").includes("someday") && titles("open").includes("far") && !titles("open").includes("done"));
  assert.deepEqual(titles("done"), ["done"]);
});

test("deals: required name, valid email and stage; won needs amount and date; lost reason only when lost", () => {
  assert.equal(parseDealInput({ name: "" }, TZ).ok, false);
  assert.equal(parseDealInput({ name: "Acme", contactEmail: "not-an-email" }, TZ).ok, false);
  assert.equal(parseDealInput({ name: "Acme", stage: "closed" }, TZ).ok, false);
  assert.equal(parseDealInput({ name: "Acme", stage: "won" }, TZ).ok, false, "won without amount/date");
  const won = parseDealInput({ name: "Acme", stage: "won", wonAmount: "$1,200", wonOn: "2026-10-09", lostReason: "ignored" }, TZ);
  assert.ok(won.ok);
  assert.equal(won.value.wonAmount, 1200);
  assert.equal(won.value.lostReason, null);
  const open = parseDealInput({ name: "Acme", stage: "negotiation", wonAmount: "5", wonOn: "2026-10-09" }, TZ);
  assert.ok(open.ok && open.value.wonAmount === null && open.value.wonOn === null, "an open deal carries no won figures");
  assert.equal(parseDealInput({ name: "Acme", expectedMrr: "-5" }, TZ).ok, false);
});

const deal = (over: Partial<FounderDeal>): FounderDeal => ({ id: Math.random().toString(36), name: "d", contactName: null, contactEmail: null, stage: "lead", expectedMrr: null, nextAction: null, nextActionAt: null, wonAmount: null, wonOn: null, lostReason: null, notes: null, createdAt: "", updatedAt: "", ...over });

test("pipeline: open counts and expected MRR (null when none entered), won this month, follow-ups, search and stage filter", () => {
  const deals = [
    deal({ name: "Acme", stage: "negotiation", expectedMrr: 300, nextActionAt: "2026-10-09T15:00:00Z", contactName: "Dana" }),
    deal({ name: "Birch", stage: "lead" }),
    deal({ name: "Cobalt", stage: "won", wonAmount: 500, wonOn: "2026-10-02" }),
    deal({ name: "Dune", stage: "won", wonAmount: 900, wonOn: "2026-09-30" }),
    deal({ name: "Elm", stage: "lost", nextActionAt: "2026-10-01T00:00:00Z" }),
  ];
  const summary = pipelineSummary(deals, "2026-10-01");
  assert.equal(summary.openCount, 2);
  assert.equal(summary.openExpectedMrr, 300);
  assert.equal(summary.openWithoutValue, 1);
  assert.equal(summary.wonThisMonthCount, 1);
  assert.equal(summary.wonThisMonthAmount, 500);
  assert.equal(pipelineSummary([deal({ stage: "lead" })], "2026-10-01").openExpectedMrr, null, "no values entered = unknown, not $0");
  assert.deepEqual(dealsNeedingFollowUp(deals, new Date("2026-10-10T06:00:00Z")).map((d) => d.name), ["Acme"], "lost deals never need follow-up");
  assert.deepEqual(filterDeals(deals, "dana", "all").map((d) => d.name), ["Acme"]);
  assert.deepEqual(filterDeals(deals, "", "won").map((d) => d.name), ["Cobalt", "Dune"]);
  assert.deepEqual(filterDeals(deals, "", "open").map((d) => d.name), ["Acme", "Birch"]);
});

const entry = (month: string, kind: MrrEntry["kind"], amount: number, isForecast = false): MrrEntry => ({ id: Math.random().toString(36), month, kind, amount, isForecast, customer: null, description: null, createdAt: "" });

test("MRR: running balance from actuals; churn subtracts; one-time never recurs; forecasts kept separate", () => {
  const entries = [
    entry("2026-08-01", "starting", 1000),
    entry("2026-09-01", "new", 500),
    entry("2026-09-01", "churn", 200),
    entry("2026-10-01", "expansion", 100.5),
    entry("2026-10-01", "contraction", 50),
    entry("2026-10-01", "one_time", 2500),
    entry("2026-11-01", "new", 1000, true),
    entry("2026-10-01", "new", 300, true),
  ];
  const history = mrrHistory(entries, "2026-09-01", "2026-11-01");
  assert.deepEqual(history.map((m) => [m.month, m.mrr]), [["2026-09-01", 1300], ["2026-10-01", 1350.5], ["2026-11-01", 1350.5]]);
  assert.equal(history[1].netNew, 50.5);
  assert.equal(history[1].oneTime, 2500);
  assert.equal(history[0].forecastMrr, null, "no forecast reaches September");
  assert.equal(history[1].forecastMrr, 1650.5);
  assert.equal(history[2].forecastMrr, 2650.5);
  const snap = mrrSnapshot(entries, "2026-10-01");
  assert.ok(snap);
  assert.equal(snap.mrr, 1350.5);
  assert.equal(snap.previousMrr, 1300);
  assert.equal(mrrSnapshot([entry("2026-10-01", "new", 10, true)], "2026-10-01"), null, "forecasts alone are not a current MRR");
  assert.equal(mrrSnapshot([], "2026-10-01"), null);
});

test("MRR and review input", () => {
  assert.deepEqual(parseMrrInput({ month: "2026-10", kind: "new", amount: "1,200.50", isForecast: "on" }), { ok: true, value: { month: "2026-10-01", kind: "new", amount: 1200.5, isForecast: true, customer: null, description: null } });
  assert.equal(parseMrrInput({ month: "2026-13", kind: "new", amount: "1" }).ok, false);
  assert.equal(parseMrrInput({ month: "2026-10", kind: "refund", amount: "1" }).ok, false);
  assert.equal(parseMrrInput({ month: "2026-10", kind: "new", amount: "" }).ok, false);
  assert.equal(parseMrrInput({ month: "2026-10", kind: "new", amount: "1.001" }).ok, false);
  assert.equal(parseReviewInput({ reviewDate: "2026-10-09" }).ok, false, "an empty review isn't saved");
  assert.equal(parseReviewInput({ reviewDate: "bad", wins: "x" }).ok, false);
  assert.ok(parseReviewInput({ reviewDate: "2026-10-09", wins: " Shipped " }).ok);
});
