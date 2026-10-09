/**
 * Founder calendar date logic (lib/founder/calendar.ts): month / week / day
 * ranges, navigation, and where items land - in the founder's time zone,
 * across DST, with all-day events, multi-day events and end-of-day tasks.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/founder/calendar.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarRange, calendarTitle, dayOfWeek, isAllDayEvent, isEndOfDayDue, parseCalendarParams, placeItems, shiftAnchor, calendarHref } from "./calendar";
import { parseItemInput, type FounderItem } from "./model";

const TZ = "America/Denver";
const item = (over: Partial<FounderItem>): FounderItem => ({ id: over.title ?? "x", kind: "task", title: "t", notes: null, priority: "medium", dueAt: null, startsAt: null, endsAt: null, completedAt: null, dealId: null, createdAt: "", updatedAt: "", ...over });

test("month view: whole Sunday-Saturday weeks covering the month, as local Denver instants", () => {
  const r = calendarRange("month", "2026-10-09", TZ);
  assert.equal(r.days[0], "2026-09-27", "the Sunday on or before Oct 1 (a Thursday)");
  assert.equal(r.days.at(-1), "2026-10-31", "Oct 31 is a Saturday");
  assert.equal(r.days.length, 35);
  assert.equal(r.start.toISOString(), "2026-09-27T06:00:00.000Z", "midnight MDT");
  assert.equal(r.end.toISOString(), "2026-11-01T06:00:00.000Z", "midnight on Nov 1, still MDT (DST ends at 2am)");
  const feb = calendarRange("month", "2026-02-14", TZ);
  assert.equal(feb.days[0], "2026-02-01", "Feb 1 2026 is a Sunday");
  assert.equal(feb.days.length, 28);
  const may = calendarRange("month", "2026-05-01", TZ);
  assert.equal(may.days.length, 42, "a month spanning six weeks");
});

test("week and day views; DST weeks keep exact local boundaries", () => {
  const week = calendarRange("week", "2026-11-04", TZ);
  assert.deepEqual([week.days[0], week.days.at(-1)], ["2026-11-01", "2026-11-07"]);
  assert.equal(week.start.toISOString(), "2026-11-01T06:00:00.000Z", "midnight MDT");
  assert.equal(week.end.toISOString(), "2026-11-08T07:00:00.000Z", "midnight MST - the week is 169 hours");
  const day = calendarRange("day", "2026-03-08", TZ);
  assert.deepEqual(day.days, ["2026-03-08"]);
  assert.equal(day.end.getTime() - day.start.getTime(), 23 * 3_600_000, "spring-forward day is 23 hours");
  assert.equal(dayOfWeek("2026-10-09"), 5);
  const tokyo = calendarRange("day", "2026-10-09", "Asia/Tokyo");
  assert.equal(tokyo.start.toISOString(), "2026-10-08T15:00:00.000Z", "the saved time zone is honored");
});

test("navigation: prev / next by month, week or day; Today; bad params fall back", () => {
  assert.equal(shiftAnchor("month", "2026-01-31", 1), "2026-02-01", "no overflow into March");
  assert.equal(shiftAnchor("month", "2026-01-15", -1), "2025-12-01");
  assert.equal(shiftAnchor("week", "2026-10-09", 1), "2026-10-16");
  assert.equal(shiftAnchor("day", "2026-12-31", 1), "2027-01-01");
  assert.deepEqual(parseCalendarParams({ view: "week", date: "2026-10-01" }, "2026-10-09"), { view: "week", anchor: "2026-10-01" });
  assert.deepEqual(parseCalendarParams({ view: "year", date: "2026-02-31" }, "2026-10-09"), { view: "month", anchor: "2026-10-09" });
  assert.deepEqual(parseCalendarParams({}, "2026-10-09"), { view: "month", anchor: "2026-10-09" });
  assert.equal(calendarHref("day", "2026-10-09"), "/founder/calendar?view=day&date=2026-10-09");
  assert.equal(calendarTitle(calendarRange("month", "2026-10-09", TZ)), "October 2026");
  assert.equal(calendarTitle(calendarRange("week", "2026-10-09", TZ)), "Oct 4 – 10, 2026");
  assert.equal(calendarTitle(calendarRange("week", "2026-12-30", TZ)), "Dec 27, 2026 – Jan 2, 2027");
  assert.equal(calendarTitle(calendarRange("day", "2026-10-09", TZ)), "Friday, October 9, 2026");
});

test("placement: timed, late-evening, multi-day, all-day, end-of-day tasks; undated items aren't placed", () => {
  const allDay = parseItemInput({ kind: "event", title: "Offsite", allDay: "on", startDate: "2026-10-08", endDate: "2026-10-09" }, TZ);
  assert.ok(allDay.ok);
  const endOfDay = parseItemInput({ kind: "deadline", title: "Tax filing", dueAt: "2026-10-09" }, TZ);
  assert.ok(endOfDay.ok);
  const items = [
    item({ title: "Standup", kind: "meeting", startsAt: "2026-10-09T15:00:00Z", endsAt: "2026-10-09T15:30:00Z" }),
    item({ title: "Late call", kind: "meeting", startsAt: "2026-10-10T04:30:00Z" }), // 10:30pm Oct 9 in Denver - not Oct 10
    item({ title: "Offsite", kind: "event", startsAt: allDay.value.startsAt, endsAt: allDay.value.endsAt }),
    item({ title: "Tax filing", kind: "deadline", dueAt: endOfDay.value.dueAt }),
    item({ title: "Conference", kind: "event", startsAt: "2026-10-09T20:00:00Z", endsAt: "2026-10-11T18:00:00Z" }),
    item({ title: "Someday" }),
  ];
  const byDay = placeItems(items, ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"], TZ);
  const titles = (day: string) => byDay.get(day)!.map((e) => `${e.item.title}${e.allDay ? "*" : ""}${e.continued ? "+" : ""}`);
  assert.deepEqual(titles("2026-10-08"), ["Offsite*"]);
  assert.deepEqual(titles("2026-10-09"), ["Offsite*+", "Tax filing*", "Standup", "Conference", "Late call"]);
  assert.deepEqual(titles("2026-10-10"), ["Conference+"]);
  assert.deepEqual(titles("2026-10-11"), ["Conference+"]);
  assert.deepEqual(titles("2026-10-12"), [], "an all-day end at midnight doesn't spill into the next day");
  assert.ok(![...byDay.values()].flat().some((e) => e.item.title === "Someday"), "undated items are listed separately, not placed");
  assert.equal(isAllDayEvent(items[2], TZ), true);
  assert.equal(isAllDayEvent(items[0], TZ), false);
  assert.equal(isEndOfDayDue(items[3], TZ), true);
});

test("item validation: required fields, all-day days, end after start, tasks carry no event times", () => {
  assert.equal(parseItemInput({ kind: "meeting", title: "Demo", startsAt: "2026-10-09T10:00", endsAt: "2026-10-09T10:00" }, TZ).ok, false, "an end equal to the start is refused");
  assert.equal(parseItemInput({ kind: "event", title: "Trip", allDay: "on", startDate: "2026-10-09", endDate: "2026-10-08" }, TZ).ok, false);
  assert.equal(parseItemInput({ kind: "event", title: "Trip", allDay: "on", startDate: "" }, TZ).ok, false);
  assert.equal(parseItemInput({ kind: "event", title: "Trip", allDay: "on", startDate: "2026-02-30" }, TZ).ok, false);
  const task = parseItemInput({ kind: "task", title: "Call", dueAt: "2026-10-09T09:00", startsAt: "2026-10-09T08:00", endsAt: "2026-10-09T09:00" }, TZ);
  assert.ok(task.ok && task.value.startsAt === null && task.value.endsAt === null, "a task never gets an event time from stray fields");
  const done = parseItemInput({ kind: "task", title: "Call", completed: "on" }, TZ);
  assert.ok(done.ok && done.value.completed === true);
  const untouched = parseItemInput({ kind: "task", title: "Call" }, TZ);
  assert.ok(untouched.ok && untouched.value.completed === null, "no completion field = leave completion as it is");
});
