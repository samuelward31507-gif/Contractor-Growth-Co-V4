/**
 * Founder calendar, planner and deal wiring - verified against source (this
 * repository has no DOM test environment; the same convention as the app's
 * other UI tests). Behavior is covered by calendar-items.test.ts and
 * lib/founder/calendar.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/founder/calendar.structural.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const PAGE = read("app/founder/calendar/page.tsx");
const VIEW = read("app/founder/_components/calendar-view.tsx");
const DETAILS = read("app/founder/_components/item-details.tsx");
const DIALOG = read("app/founder/_components/item-dialog.tsx");

test("access: the calendar re-checks founder access and reads only the founder's own items for the visible range", () => {
  assert.match(PAGE, /await requireFounderPage\(\)/);
  assert.match(PAGE, /getFounderCalendarItems\(supabase, userId, range\.start, range\.end\)/);
  assert.match(read("lib/founder/queries.ts"), /from\("founder_items"\)\.select\(ITEM_COLUMNS\)\.eq\("owner_id", ownerId\)\.gte\("starts_at"/);
  assert.ok(fs.existsSync(path.join(process.cwd(), "app/founder/calendar/loading.tsx")), "loading state");
});

test("navigation: Calendar is in the Founder nav only; month/week/day, previous/next and Today are links", () => {
  assert.match(read("lib/ui/operator-shell/nav.ts"), /\{ href: "\/founder\/calendar", label: "Calendar", icon: "CalendarDays" \}/);
  assert.doesNotMatch(read("app/(app)/_components/nav-items.ts"), /founder/i, "not in contractor navigation");
  assert.match(PAGE, /href=\{calendarHref\(view, shiftAnchor\(view, anchor, -1\)\)\} aria-label=\{`Previous \$\{view\}`\}/);
  assert.match(PAGE, /href=\{calendarHref\(view, shiftAnchor\(view, anchor, 1\)\)\} aria-label=\{`Next \$\{view\}`\}/);
  assert.match(PAGE, /href=\{calendarHref\(view, todayKey\)\}[\s\S]{0,120}Today/);
  assert.match(PAGE, /CALENDAR_VIEWS\.map\(\(v\) => \([\s\S]*?aria-current=\{v === view \? "page" : undefined\}/);
});

test("states: load failure, empty range, and an always-present Unscheduled list", () => {
  assert.match(PAGE, /\{!itemsResult\.ok \? \(\s*<LoadFailed what="Your calendar" \/>/);
  assert.match(PAGE, /Nothing on the calendar for this \{view\} yet/);
  assert.match(VIEW, /aria-labelledby="unscheduled-title"/);
  assert.match(VIEW, /Everything open has a date\./);
  assert.match(VIEW, /Nothing on this day/);
  assert.match(VIEW, /role="status"[\s\S]{0,160}\{flash\}/, "success feedback after a save");
});

test("interaction: every item is a button opening its details; details offer complete, edit/reschedule, delete and the deal link", () => {
  assert.match(VIEW, /onClick=\{\(\) => setSelected\(item\)\}\s*aria-label=\{`\$\{item\.title\}, \$\{describeItemTime\(item, timeZone\)\}/);
  assert.match(VIEW, /onClick=\{\(\) => setCreating\(\{ date: day \}\)\} aria-label=\{label\}/, "add on a specific day");
  assert.match(DETAILS, /href=\{`\/founder\/deals\?deal=\$\{deal\.id\}`\}/);
  assert.match(DETAILS, /Edit \/ reschedule/);
  assert.match(DETAILS, /setFounderItemCompleted\(item\.id, !done\)/);
  assert.match(DETAILS, /deleteFounderItem\(item\.id\)/);
  assert.doesNotMatch(VIEW, /draggable|onDrag/, "no drag-and-drop: rescheduling is through the edit dialog");
});

test("types are distinguishable without color: every type has its own icon and label, plus a legend", () => {
  const icons = read("app/founder/_components/kind-icon.tsx");
  for (const kind of ["meeting", "event", "task", "deadline", "follow_up"]) assert.match(icons, new RegExp(`${kind}: \\w+`), kind);
  assert.match(VIEW, /aria-label="Legend"/);
});

test("responsive: month chips from sm up with dots on phones; week days 1/2/4/7 across; Unscheduled beside the grid only when wide", () => {
  assert.match(VIEW, /className="mt-1 flex flex-wrap gap-0\.5 sm:hidden"/);
  assert.match(VIEW, /className="mt-1 hidden space-y-0\.5 sm:block"/);
  assert.match(VIEW, /grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7/);
  assert.match(VIEW, /2xl:w-72/);
});

test("the item dialog prevents duplicates and lost updates, and never drops a closed deal link", () => {
  assert.match(DIALOG, /<input type="hidden" name="expectedUpdatedAt" value=\{item\.updatedAt\} \/>/);
  assert.match(DIALOG, /<input type="hidden" name="clientId" value=\{clientId\} \/>/);
  assert.match(DIALOG, /deals\.filter\(\(deal\) => !deal\.closed \|\| deal\.id === \(item\?\.dealId \?\? defaults\?\.dealId\)\)/);
  assert.match(DIALOG, /name="allDay"/);
  assert.match(DIALOG, /name="completed"/);
});

test("home command center: quick actions for each type, priorities, today, needs attention, coming up, compact figures", () => {
  const HOME = read("app/founder/page.tsx");
  for (const label of ['label="Task" defaultKind="task"', 'label="Meeting" defaultKind="meeting"', 'label="Event" defaultKind="event"', 'label="Follow-up" defaultKind="follow_up"']) assert.ok(HOME.includes(label), label);
  for (const title of ['title="Today\'s priorities"', 'title="Today"', 'title="Needs attention"', 'title="Coming up"']) assert.ok(HOME.includes(title), title);
  assert.match(HOME, /buildDailyPlan\(\{ items, deals, focus, now, timeZone, todayKey \}\)/, "one plan decides every section (no duplicates)");
  assert.match(HOME, /href=\{`\/founder\/deals\?deal=\$\{deal\.id\}`\}/);
  assert.match(HOME, /calendarHref\("week", todayKey\)/);
  assert.match(HOME, /MRR \(actual, manual\)/, "MRR is labelled as the actual manually recorded figure");
  assert.doesNotMatch(HOME, /<StatGrid/, "figures are one compact line, not a wall of cards");
});

test("deals: a follow-up created from a deal keeps the link; ?deal= focuses one deal; linked items are shown", () => {
  const DEALS = read("app/founder/deals/page.tsx");
  assert.match(DEALS, /<AddItemButton label="Follow-up" defaultKind="follow_up" defaults=\{\{ dealId: deal\.id, date: todayKey \}\}/);
  assert.match(DEALS, /const focused = focusId \? deals\.find\(\(deal\) => deal\.id === focusId\) \?\? null : null;/);
  assert.match(DEALS, /aria-label=\{`Open items for \$\{deal\.name\}`\}/);
  assert.match(read("app/founder/_components/item-list.tsx"), /href=\{`\/founder\/deals\?deal=\$\{item\.dealId\}`\}/);
});
