/**
 * Founder home and end-of-day review - loading, empty, error and
 * "not enabled" states, and the wiring that keeps actions explicit and
 * owner-scoped. Verified against source (no DOM test environment here);
 * behavior is in lib/founder/daily.test.ts and app/founder/daily-actions.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/founder/daily.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const HOME = read("app/founder/page.tsx");
const REVIEW = read("app/founder/review/page.tsx");
const PRIORITIES = read("app/founder/_components/daily-priorities.tsx");
const CAPTURE = read("app/founder/_components/quick-capture.tsx");

test("both pages re-check founder access and read only the founder's own data", () => {
  for (const page of [HOME, REVIEW]) assert.match(page, /await requireFounderPage\(\)/);
  assert.match(HOME, /getFounderFocus\(supabase, userId, todayKey, todayKey\)/);
  assert.match(REVIEW, /getFounderFocus\(supabase, userId, requested, tomorrowKey\)/, "the reviewed day (for the summary) through tomorrow (for priorities) - one bounded read");
  assert.match(read("lib/founder/queries.ts"), /\.select\("id, focus_date, focus_rank"\)\s*\.eq\("owner_id", ownerId\)/);
});

test("loading, error, empty and not-enabled states", () => {
  assert.ok(fs.existsSync(path.join(process.cwd(), "app/founder/loading.tsx")));
  assert.match(read("app/founder/loading.tsx"), /SkeletonPage/);
  assert.match(HOME, /<LoadFailed what="Your tasks and events" \/>/);
  assert.match(HOME, /<LoadFailed what="Today's priorities" \/>/);
  assert.match(HOME, /No meetings, events or tasks due today\./);
  assert.match(HOME, /Nothing needs attention among what was checked\./);
  assert.match(HOME, /Nothing scheduled for the next three days\./);
  assert.match(PRIORITIES, /if \(!available\) \{[\s\S]*?aren&rsquo;t enabled on this database yet/);
  assert.match(PRIORITIES, /No priorities set for \{dayLabel\}/);
  assert.match(REVIEW, /<LoadFailed what="Tomorrow's priorities" \/>/);
  assert.match(REVIEW, /Nothing left open from/);
  assert.match(REVIEW, /No deal was created, won, lost or edited/);
});

test("priorities: complete, reorder, remove, add by title, or pick an open task; progress shown; max three", () => {
  for (const call of ["setFounderItemCompleted(item.id, !complete)", 'moveFounderPriority(item.id, "up")', 'moveFounderPriority(item.id, "down")', "removeFounderPriority(item.id)", "addFounderPriority({ title, date: dateKey, clientId })", "setFounderPriority(itemId, dateKey)"]) {
    assert.ok(PRIORITIES.includes(call), call);
  }
  assert.match(PRIORITIES, /\{done\}\/\{priorities\.length\} done/);
  assert.match(PRIORITIES, /const full = priorities\.length >= MAX_DAILY_PRIORITIES;/);
  assert.match(PRIORITIES, /role=\{message\.tone === "error" \? "alert" : "status"\}/, "success and error feedback");
});

test("quick capture: optional due date, one-time id renewed only after success, feedback", () => {
  assert.match(CAPTURE, /name="dueDate" type="date"/);
  assert.match(CAPTURE, /quickCaptureFounderItem\(title, \{ dueDate, clientId \}\)/);
  assert.match(CAPTURE, /formRef\.current\?\.reset\(\);\s*setClientId\(newClientId\(\)\);/);
  assert.match(CAPTURE, /disabled=\{isPending\}/);
});

test("review: nothing is rescheduled automatically - each move is a button carrying the item's version", () => {
  assert.match(read("app/founder/_components/move-to-day.tsx"), /moveFounderItemToDay\(item\.id, dateKey, item\.updatedAt\)/);
  assert.match(REVIEW, /<MoveToDayButton item=\{item\} dateKey=\{addDaysKey\(todayKey, 1\)\} label="Move to tomorrow" \/>/);
  assert.doesNotMatch(REVIEW, /moveFounderItemToDay|setFounderItemCompleted/, "the page itself never moves or completes anything");
  assert.match(REVIEW, /<DailyPriorities dateKey=\{tomorrowKey\} dayLabel="tomorrow"/);
  assert.match(read("app/founder/_components/review-form.tsx"), /label: "Notes for tomorrow"/);
});

test("responsive: one column on phones (priorities and today first), two from lg; no fixed widths that overflow", () => {
  assert.match(HOME, /grid grid-cols-1 gap-6 lg:grid-cols-\[minmax\(0,3fr\)_minmax\(0,2fr\)\]/);
  assert.ok(HOME.indexOf('title="Today\'s priorities"') < HOME.indexOf('title="Needs attention"'), "priorities come before attention in source (and on a phone)");
  assert.match(CAPTURE, /w-full sm:w-40/);
});
