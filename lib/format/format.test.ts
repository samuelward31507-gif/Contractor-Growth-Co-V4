/**
 * Batch 1 (Cinder design foundation): the canonical presentation
 * formatters - currency, timezone-aware dates, relative time - and the
 * shared status vocabulary / semantic status colors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { formatCurrency, formatMinorUnits } from "./money";
import { formatCalendarDateTime, formatCalendarDay, formatDate, formatDateTime, formatRelativeTime, formatTime, resolveTimeZone } from "./datetime";
import { formatCurrency as dashboardCurrency, formatRelativeTime as dashboardRelative } from "../dashboard/format";
import { formatMoney } from "../invoices/domain";
import { formatContactDate } from "../contacts/format";
import { STATUS_DOT_TONE_CLASS, STATUS_LABEL, statusDisplayLabel } from "../ui/status-vocabulary";

test("currency: auto shows cents only when present; never/always are explicit", () => {
  assert.equal(formatCurrency(1200), "$1,200");
  assert.equal(formatCurrency(1300.25), "$1,300.25");
  assert.equal(formatCurrency(1300.5), "$1,300.50");
  assert.equal(formatCurrency(-45.1), "-$45.10");
  assert.equal(formatCurrency(4821.6, { cents: "never" }), "$4,822");
  assert.equal(formatCurrency(1200, { cents: "always" }), "$1,200.00");
  assert.equal(formatMinorUnits(130025), "$1,300.25");
});

test("currency: legacy names keep their exact output through the canonical formatter", () => {
  assert.equal(dashboardCurrency(4821.6), "$4,822");
  assert.equal(dashboardCurrency(0), "$0");
  assert.equal(formatMoney(1300.25), "$1,300.25");
  assert.equal(formatMoney(1300), "$1,300");
  assert.equal(formatMoney(0.1 + 0.2 - 0.3 + 5), "$5");
});

const ISO = "2026-10-09T21:00:00Z"; // 2:00 PM in Los Angeles (PDT), 5:00 PM in New York

test("dates render in the organization timezone, UTC when unknown or invalid", () => {
  assert.equal(formatTime(ISO, "America/Los_Angeles"), "2:00 PM");
  assert.equal(formatTime(ISO, "America/New_York"), "5:00 PM");
  assert.equal(formatTime(ISO, null), "9:00 PM");
  assert.equal(formatTime(ISO, "Not/AZone"), "9:00 PM");
  assert.equal(resolveTimeZone("Not/AZone"), "UTC");
  assert.equal(formatDate("2026-10-10T02:00:00Z", "America/Los_Angeles"), "Oct 9, 2026");
  assert.equal(formatDate("2026-10-10T02:00:00Z", "UTC"), "Oct 10, 2026");
  assert.equal(formatDateTime(ISO, "America/Los_Angeles"), "Oct 9, 2026, 2:00 PM");
  assert.equal(formatContactDate("2026-10-10T02:00:00Z", "America/Los_Angeles"), "Oct 9, 2026");
});

test("calendar-relative phrasing follows the org's calendar day, not UTC's", () => {
  const now = Date.parse("2026-10-09T18:00:00Z"); // Oct 9, 11:00 AM in LA
  const tz = "America/Los_Angeles";
  assert.equal(formatCalendarDateTime(ISO, tz, now), "Today at 2:00 PM");
  assert.equal(formatCalendarDateTime("2026-10-10T21:00:00Z", tz, now), "Tomorrow at 2:00 PM");
  assert.equal(formatCalendarDateTime("2026-10-08T16:15:00Z", tz, now), "Yesterday at 9:15 AM");
  assert.equal(formatCalendarDateTime("2026-10-02T21:00:00Z", tz, now), "Oct 2 at 2:00 PM");
  assert.equal(formatCalendarDay("2025-12-24T20:00:00Z", tz, now), "Dec 24, 2025");
  // 02:00Z on the 10th is still the evening of the 9th in LA: "Today", not "Tomorrow".
  assert.equal(formatCalendarDay("2026-10-10T02:00:00Z", tz, now), "Today");
  assert.equal(formatCalendarDay("2026-10-10T02:00:00Z", "UTC", now), "Tomorrow");
});

test("relative time: one implementation, shared by the legacy name", () => {
  const now = Date.parse("2026-10-09T18:00:00Z");
  assert.equal(formatRelativeTime("2026-10-09T16:00:00Z", now), "2 hours ago");
  assert.equal(formatRelativeTime("2026-10-08T18:00:00Z", now), "yesterday");
  assert.equal(formatRelativeTime("2026-10-12T18:00:00Z", now), "in 3 days");
  assert.equal(dashboardRelative, formatRelativeTime);
});

test("status vocabulary: Title Case display labels and a readable fallback", () => {
  assert.equal(STATUS_LABEL.inProgress, "In Progress");
  assert.equal(STATUS_LABEL.partiallyPaid, "Partially Paid");
  assert.equal(STATUS_LABEL.needsAttention, "Needs Attention");
  assert.equal(statusDisplayLabel("partially_paid"), "Partially Paid");
  assert.equal(statusDisplayLabel("no-show"), "No Show");
  assert.equal(statusDisplayLabel(""), "Unknown");
  for (const label of Object.values(STATUS_LABEL)) {
    for (const word of label.split(/[\s-]+/)) assert.match(word, /^[A-Z]/, `"${label}" is Title Case`);
  }
});

test("status colors are semantic tokens - no raw Tailwind palette classes in the status maps", () => {
  const RAW = /\b(?:bg|text|border|ring|fill)-(?:red|green|emerald|amber|yellow|blue|sky|slate|gray|zinc|orange|rose|violet|purple|indigo|teal|lime|stone|neutral)-\d{2,3}\b/;
  for (const file of ["lib/leads/format.ts", "lib/estimates/format.ts", "lib/appointments/format.ts", "lib/jobs/format.ts", "lib/conversations/format.ts", "lib/reviews-referrals/format.ts", "lib/ui/status-vocabulary.ts"]) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), RAW, file);
  }
  assert.equal(STATUS_DOT_TONE_CLASS.success, "bg-accent");
  assert.equal(STATUS_DOT_TONE_CLASS.attention, "bg-warning");
  assert.equal(STATUS_DOT_TONE_CLASS.danger, "bg-danger");
});

test("design foundation: ink-pill primary, ember focus, Cinder canvas and ink scale", () => {
  const css = fs.readFileSync("app/globals.css", "utf8");
  assert.match(css, /--canvas: #f5f3ee;/);
  assert.match(css, /--ink: #0d1512;/);
  assert.match(css, /--ink-2: #3a433f;/);
  assert.match(css, /--ink-3: #5f6763;/);
  assert.match(css, /--brand: #b14f2b;/);
  assert.match(css, /--focus: #b14f2b;/);
  assert.match(css, /font-feature-settings: "ss01", "cv11";/);
  assert.match(css, /:focus-visible \{\s*outline: 2px solid var\(--focus\);/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.ui-rise/);
  const form = fs.readFileSync("lib/ui/form.ts", "utf8");
  assert.match(form, /const PRIMARY = `\$\{PILL\} \$\{ARROW_NUDGE\} bg-primary text-primary-foreground/);
  assert.doesNotMatch(form, /bg-(?:accent|brand)(?:-strong)?(?=[\s`"])/, "neither pine nor ember is a button fill");
  assert.match(form, /focus-visible:outline-focus/);
});
