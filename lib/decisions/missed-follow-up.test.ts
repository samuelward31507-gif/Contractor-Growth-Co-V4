/**
 * Phase 2-11 (A7-A9, G3-G5): the pure missed-follow-up rules.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/decisions/missed-follow-up.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isReplyFollowUpMissed, isEstimateFollowUpMissed, REPLY_FOLLOW_UP_WINDOW_MS, ESTIMATE_FOLLOW_UP_WINDOW_MS, MISSED_FOLLOW_UP_LABEL }: typeof import("./missed-follow-up") = require("./missed-follow-up.ts");
const { ESTIMATE_FOLLOWUP_WINDOW_MS }: typeof import("./actor") = require("./actor.ts");

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const H = 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const waiting = (msAgo: number | null) => ({ aiEnabled: true, smsOptOut: false, firstUnansweredInboundAt: msAgo === null ? null : iso(msAgo) });
const estimate = (sentMsAgo: number | null, contactId: string | null = "c1") => ({ contactId, metadata: sentMsAgo === null ? {} : { sent_at: iso(sentMsAgo) } });

test("labels and thresholds: the three approved labels; 4h for replies; the existing 72h estimate window", () => {
  assert.deepEqual(MISSED_FOLLOW_UP_LABEL, { first_contact: "Missed follow-up · First contact", reply: "Missed follow-up · Reply", estimate_followup: "Missed follow-up · Estimate follow-up" });
  assert.equal(REPLY_FOLLOW_UP_WINDOW_MS, 4 * H);
  assert.equal(ESTIMATE_FOLLOW_UP_WINDOW_MS, 72 * H);
  assert.equal(ESTIMATE_FOLLOW_UP_WINDOW_MS, ESTIMATE_FOLLOWUP_WINDOW_MS, "the same constant as Trackpr's follow-up window (Phase 2-4)");
});

test("reply: missed at exactly 4h of waiting and after; not at 3h59m59.999s; unknown or missing timestamps never mark it", () => {
  assert.equal(isReplyFollowUpMissed(waiting(4 * H), NOW), true, "exactly 4h");
  assert.equal(isReplyFollowUpMissed(waiting(30 * H), NOW), true);
  assert.equal(isReplyFollowUpMissed(waiting(4 * H - 1), NOW), false, "one millisecond short");
  assert.equal(isReplyFollowUpMissed(waiting(null), NOW), false, "no unanswered message known");
  assert.equal(isReplyFollowUpMissed(undefined, NOW), false, "conversation not read");
});

test("estimate: missed at 72h or more with no successful outbound message after sent_at", () => {
  const none = new Map<string, number>();
  assert.equal(isEstimateFollowUpMissed(estimate(72 * H), none, NOW), true, "exactly 72h, nothing sent");
  assert.equal(isEstimateFollowUpMissed(estimate(72 * H - 1), none, NOW), false, "one millisecond short of 72h");
  assert.equal(isEstimateFollowUpMissed(estimate(100 * H), new Map([["c1", NOW - 200 * H]]), NOW), true, "the only outbound was before the estimate was sent");
  assert.equal(isEstimateFollowUpMissed(estimate(100 * H), new Map([["c1", NOW - 100 * H]]), NOW), true, "an outbound at exactly sent_at is not after it");
});

test("estimate: NOT missed when any successful outbound message reached the contact after sent_at - a person's or Trackpr's own automated follow-up (B10)", () => {
  assert.equal(isEstimateFollowUpMissed(estimate(100 * H), new Map([["c1", NOW - 99 * H]]), NOW), false);
  assert.equal(isEstimateFollowUpMissed(estimate(100 * H), new Map([["c2", NOW - 1 * H]]), NOW), true, "another contact's message does not count");
});

test("estimate: unknown data never marks it - no outbound read, no or unreadable sent_at; a contactless estimate past 72h is missed (nothing could reach them)", () => {
  assert.equal(isEstimateFollowUpMissed(estimate(100 * H), null, NOW), false, "read failed");
  assert.equal(isEstimateFollowUpMissed(estimate(100 * H), undefined, NOW), false, "read not made");
  assert.equal(isEstimateFollowUpMissed(estimate(null), new Map(), NOW), false, "no sent_at");
  assert.equal(isEstimateFollowUpMissed({ contactId: "c1", metadata: { sent_at: "garbage" } }, new Map(), NOW), false, "unreadable sent_at");
  assert.equal(isEstimateFollowUpMissed(estimate(100 * H, null), new Map(), NOW), true);
});

test("R-d (Phase 2-13): with a configured window, an estimate follow-up is missed only once that window has elapsed", () => {
  const none = new Map<string, number>();
  assert.equal(isEstimateFollowUpMissed(estimate(30 * H), none, NOW, 30 * H), true, "exactly 30h of a 30h window");
  assert.equal(isEstimateFollowUpMissed(estimate(30 * H - 1), none, NOW, 30 * H), false);
  assert.equal(isEstimateFollowUpMissed(estimate(100 * H), none, NOW, 120 * H), false, "past 72h but Trackpr's 120h window is still open");
  assert.equal(isEstimateFollowUpMissed(estimate(120 * H), none, NOW, 120 * H), true);
});
