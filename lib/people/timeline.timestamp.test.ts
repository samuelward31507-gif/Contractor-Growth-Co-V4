/**
 * Final Batch 3: every timeline event shows when it happened, from its own
 * stored timestamp - never a fabricated or altered one.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/people/timeline.timestamp.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPersonTimeline, formatTimelineTimestamp } from "./timeline";

const NOW = Date.parse("2026-10-10T15:00:00.000Z");

test("date and time come from the stored value, in the organization's timezone", () => {
  assert.deepEqual(formatTimelineTimestamp("2026-09-01T18:05:00.000Z", "America/Los_Angeles", NOW), { iso: "2026-09-01T18:05:00.000Z", date: "Sep 1, 2026", time: "11:05 AM", relative: null });
  assert.deepEqual(formatTimelineTimestamp("2026-09-01T18:05:00.000Z", "UTC", NOW), { iso: "2026-09-01T18:05:00.000Z", date: "Sep 1, 2026", time: "6:05 PM", relative: null });
});

test("a relative phrase only for the last week, where it helps", () => {
  assert.equal(formatTimelineTimestamp("2026-10-10T14:58:00.000Z", "UTC", NOW)?.relative, "2 min ago");
  assert.equal(formatTimelineTimestamp("2026-10-10T12:00:00.000Z", "UTC", NOW)?.relative, "3 hr ago");
  assert.equal(formatTimelineTimestamp("2026-10-09T12:00:00.000Z", "UTC", NOW)?.relative, "yesterday");
  assert.equal(formatTimelineTimestamp("2026-10-06T12:00:00.000Z", "UTC", NOW)?.relative, "4 days ago");
  assert.equal(formatTimelineTimestamp("2026-10-01T12:00:00.000Z", "UTC", NOW)?.relative, null);
  assert.equal(formatTimelineTimestamp("2026-10-12T12:00:00.000Z", "UTC", NOW)?.relative, null, "a future stored time is never called 'ago'");
});

test("a missing or unreadable stored value shows no date at all - never a fabricated one", () => {
  assert.equal(formatTimelineTimestamp(null, "UTC", NOW), null);
  assert.equal(formatTimelineTimestamp(undefined, "UTC", NOW), null);
  assert.equal(formatTimelineTimestamp("not a date", "UTC", NOW), null);
});

test("an unusable timezone falls back to UTC rather than failing", () => {
  assert.equal(formatTimelineTimestamp("2026-09-01T18:05:00.000Z", "Not/AZone", NOW)?.time, "6:05 PM");
});

test("every event type keeps its own stored timestamp through the timeline, and the format is the identity on it", () => {
  const events = buildPersonTimeline({
    leads: [{ id: "L1", created_at: "2026-10-01T10:00:00.000Z", service: "Roof", source: "web" }] as never,
    stageHistoryByLeadId: new Map([["L1", [{ id: "H1", previousStatus: "new", newStatus: "contacted", changedAt: "2026-10-02T10:00:00.000Z", source: "manual" }] as never]]),
    appointments: [{ id: "A1", created_at: "2026-10-03T10:00:00.000Z", updated_at: "2026-10-05T10:00:00.000Z", status: "completed", title: "Visit", start_at: "2026-10-04T16:00:00.000Z" }] as never,
    estimates: [{ id: "E1", sent_at: "2026-10-06T10:00:00.000Z", responded_at: "2026-10-07T10:00:00.000Z", status: "accepted", amount: 900, title: "Roof" }] as never,
    jobs: [{ id: "J1", created_at: "2026-10-08T10:00:00.000Z", started_at: "2026-10-08T12:00:00.000Z", completed_at: null, title: "Roof job", amount: 900 }] as never,
    messages: [{ id: "M1", created_at: "2026-10-09T10:00:00.000Z", direction: "inbound", status: "received", sender_type: "customer", body: "Thanks" }] as never,
    timeZone: "UTC",
  });
  const byId = Object.fromEntries(events.map((event) => [event.id, event.at]));
  assert.deepEqual(byId, {
    "msg-M1": "2026-10-09T10:00:00.000Z",
    "job-started-J1": "2026-10-08T12:00:00.000Z",
    "job-J1": "2026-10-08T10:00:00.000Z",
    "est-responded-E1": "2026-10-07T10:00:00.000Z",
    "est-sent-E1": "2026-10-06T10:00:00.000Z",
    "apt-completed-A1": "2026-10-05T10:00:00.000Z",
    "apt-A1": "2026-10-03T10:00:00.000Z",
    "stage-H1": "2026-10-02T10:00:00.000Z",
    "lead-L1": "2026-10-01T10:00:00.000Z",
  });
  for (const event of events) assert.equal(formatTimelineTimestamp(event.at, "UTC", NOW)?.iso, event.at);
});

test("the Person page renders each event's date/time from formatTimelineTimestamp in a <time dateTime>", () => {
  const page = readFileSync("app/(app)/people/[id]/page.tsx", "utf8");
  assert.match(page, /formatTimelineTimestamp\(event\.at, timeZone\)/);
  assert.match(page, /<time dateTime=\{stamp\.iso\}/);
});
