/**
 * Unit tests for buildPersonTimeline - pure, no I/O. Generalizes the same
 * chronological merge app/(app)/leads/[id]/page.tsx's own "What happened"
 * section already builds, across a whole person's leads/appointments/
 * estimates/jobs/messages. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test "lib/people/timeline.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Lead } from "@/lib/leads/queries";
import type { Appointment } from "@/lib/appointments/queries";
import type { Estimate } from "@/lib/estimates/queries";
import type { Job } from "@/lib/jobs/queries";
import type { Message } from "@/lib/conversations/queries";
import type { LeadStageHistoryEntry } from "@/lib/automation/lead-stage-history";
import type { ReviewRequest, ReferralRequest } from "@/lib/reviews-referrals/queries";

const require = createRequire(import.meta.url);
const { buildPersonTimeline }: typeof import("./timeline") = require("./timeline.ts");

const emptyParams = {
  leads: [] as Lead[],
  stageHistoryByLeadId: new Map<string, LeadStageHistoryEntry[]>(),
  appointments: [] as Appointment[],
  estimates: [] as Estimate[],
  jobs: [] as Job[],
  messages: [] as Message[],
  reviewRequests: [] as ReviewRequest[],
  referralRequests: [] as ReferralRequest[],
};

test("events from every source are merged into one feed, sorted newest first", () => {
  const events = buildPersonTimeline({
    ...emptyParams,
    leads: [{ id: "l1", created_at: "2026-01-01T00:00:00.000Z", service: "Roofing", source: "Google" }] as unknown as Lead[],
    jobs: [{ id: "j1", created_at: "2026-01-05T00:00:00.000Z", title: "Roof replacement" }] as unknown as Job[],
    messages: [{ id: "m1", created_at: "2026-01-03T00:00:00.000Z", direction: "inbound", body: "Sounds good" }] as unknown as Message[],
  });
  assert.deepEqual(
    events.map((event) => event.id),
    ["job-j1", "msg-m1", "lead-l1"],
  );
});

test("a lead's own stage transitions appear, but its initial null-previous-status row is excluded (that's the lead-created event, not a transition)", () => {
  const events = buildPersonTimeline({
    ...emptyParams,
    leads: [{ id: "l1", created_at: "2026-01-01T00:00:00.000Z" }] as unknown as Lead[],
    stageHistoryByLeadId: new Map([
      [
        "l1",
        [
          { id: "h1", changedAt: "2026-01-01T00:00:00.000Z", previousStatus: null, newStatus: "new", source: "automation" },
          { id: "h2", changedAt: "2026-01-02T00:00:00.000Z", previousStatus: "new", newStatus: "contacted", source: "staff" },
        ] as unknown as LeadStageHistoryEntry[],
      ],
    ]),
  });
  const stageEvents = events.filter((event) => event.id.startsWith("stage-"));
  assert.equal(stageEvents.length, 1);
  assert.equal(stageEvents[0].id, "stage-h2");
});

test("an estimate contributes both a sent event and a responded event when both timestamps exist", () => {
  const events = buildPersonTimeline({
    ...emptyParams,
    estimates: [{ id: "e1", sent_at: "2026-01-01T00:00:00.000Z", responded_at: "2026-01-04T00:00:00.000Z", status: "accepted", title: "Roof estimate", amount: 5000 }] as unknown as Estimate[],
  });
  assert.deepEqual(
    events.map((event) => event.id),
    ["est-responded-e1", "est-sent-e1"],
  );
});

test("an estimate with neither sent_at nor responded_at contributes no event, never a fabricated one", () => {
  const events = buildPersonTimeline({
    ...emptyParams,
    estimates: [{ id: "e1", sent_at: null, responded_at: null, status: "draft", title: "Roof estimate" }] as unknown as Estimate[],
  });
  assert.equal(events.length, 0);
});

test("messages label distinct sender types distinctly: customer reply, automated follow-up, and staff message", () => {
  const events = buildPersonTimeline({
    ...emptyParams,
    messages: [
      { id: "m1", created_at: "2026-01-01T00:00:00.000Z", direction: "inbound", sender_type: "customer", body: "hi" },
      { id: "m2", created_at: "2026-01-02T00:00:00.000Z", direction: "outbound", sender_type: "ai", body: "following up" },
      { id: "m3", created_at: "2026-01-03T00:00:00.000Z", direction: "outbound", sender_type: "staff", body: "calling now" },
    ] as unknown as Message[],
  });
  const labelsById = new Map(events.map((event) => [event.id, event.label]));
  assert.equal(labelsById.get("msg-m1"), "Customer replied");
  assert.equal(labelsById.get("msg-m2"), "Automated follow-up sent");
  assert.equal(labelsById.get("msg-m3"), "You sent a message");
});

test("a job contributes started and completed events when both timestamps are real, in addition to its creation event", () => {
  const events = buildPersonTimeline({
    ...emptyParams,
    jobs: [{ id: "j1", created_at: "2026-01-01T00:00:00.000Z", started_at: "2026-01-02T00:00:00.000Z", completed_at: "2026-01-05T00:00:00.000Z", title: "Roof replacement", amount: 8000 }] as unknown as Job[],
  });
  assert.deepEqual(
    events.map((event) => event.id),
    ["job-completed-j1", "job-started-j1", "job-j1"],
  );
});

test("a job with no started_at/completed_at contributes only its creation event, never a fabricated one", () => {
  const events = buildPersonTimeline({
    ...emptyParams,
    jobs: [{ id: "j1", created_at: "2026-01-01T00:00:00.000Z", started_at: null, completed_at: null, title: "Roof replacement" }] as unknown as Job[],
  });
  assert.deepEqual(
    events.map((event) => event.id),
    ["job-j1"],
  );
});

test("an appointment in a terminal status contributes a real event keyed off its own updated_at, labeled per status", () => {
  const completed = buildPersonTimeline({
    ...emptyParams,
    appointments: [{ id: "a1", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-03T00:00:00.000Z", status: "completed", title: "Roof inspection" }] as unknown as Appointment[],
  });
  assert.equal(completed.find((event) => event.id === "apt-completed-a1")?.label, "Appointment completed");

  const noShow = buildPersonTimeline({
    ...emptyParams,
    appointments: [{ id: "a2", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-03T00:00:00.000Z", status: "no_show", title: "Roof inspection" }] as unknown as Appointment[],
  });
  assert.equal(noShow.find((event) => event.id === "apt-noshow-a2")?.label, "Missed appointment");

  const cancelled = buildPersonTimeline({
    ...emptyParams,
    appointments: [{ id: "a3", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-03T00:00:00.000Z", status: "cancelled", title: "Roof inspection" }] as unknown as Appointment[],
  });
  assert.equal(cancelled.find((event) => event.id === "apt-cancelled-a3")?.label, "Appointment cancelled");
});

test("an appointment still in an open status (scheduled/confirmed) contributes no terminal-state event", () => {
  const events = buildPersonTimeline({
    ...emptyParams,
    appointments: [
      { id: "a1", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", status: "scheduled", title: "Roof inspection" },
    ] as unknown as Appointment[],
  });
  const terminalStateEvents = events.filter((event) => event.id.startsWith("apt-completed-") || event.id.startsWith("apt-noshow-") || event.id.startsWith("apt-cancelled-"));
  assert.equal(terminalStateEvents.length, 0);
});

test("review and referral requests contribute a requested event and, once resolved, a resolved event with an outcome-specific label", () => {
  const events = buildPersonTimeline({
    ...emptyParams,
    reviewRequests: [
      { id: "r1", requested_at: "2026-01-01T00:00:00.000Z", resolved_at: "2026-01-03T00:00:00.000Z", status: "completed" },
    ] as unknown as ReviewRequest[],
    referralRequests: [
      { id: "f1", requested_at: "2026-01-01T00:00:00.000Z", resolved_at: "2026-01-04T00:00:00.000Z", status: "converted" },
    ] as unknown as ReferralRequest[],
  });
  const labelsById = new Map(events.map((event) => [event.id, event.label]));
  assert.equal(labelsById.get("review-requested-r1"), "Review requested");
  assert.equal(labelsById.get("review-resolved-r1"), "Review received");
  assert.equal(labelsById.get("referral-requested-f1"), "Referral requested");
  assert.equal(labelsById.get("referral-resolved-f1"), "Referral converted");
});

test("a review/referral request still 'requested' (not yet resolved) contributes only the requested event, never a fabricated resolution", () => {
  const events = buildPersonTimeline({
    ...emptyParams,
    reviewRequests: [{ id: "r1", requested_at: "2026-01-01T00:00:00.000Z", resolved_at: null, status: "requested" }] as unknown as ReviewRequest[],
  });
  assert.deepEqual(
    events.map((event) => event.id),
    ["review-requested-r1"],
  );
});

test("an empty person (no records anywhere) yields an empty timeline, not an error", () => {
  const events = buildPersonTimeline(emptyParams);
  assert.deepEqual(events, []);
});

// Phase 3 (W1): a message's label says what actually happened - only a sent / delivered outbound "was sent".
test("messageTimelineLabel (Phase 3): failed / undelivered sends failed, queued is still sending, a logged entry is a note; sent / delivered keep the existing labels", () => {
  const { messageTimelineLabel }: typeof import("./timeline") = require("./timeline.ts");
  const label = (direction: string, status: string, sender_type: string) => messageTimelineLabel({ direction, status, sender_type });
  assert.equal(label("inbound", "received", "customer"), "Customer replied");
  assert.equal(label("outbound", "delivered", "ai"), "Automated follow-up sent");
  assert.equal(label("outbound", "sent", "system"), "System message sent");
  assert.equal(label("outbound", "delivered", "user"), "You sent a message");
  assert.equal(label("outbound", "failed", "ai"), "Automated follow-up failed to send");
  assert.equal(label("outbound", "undelivered", "user"), "Your message failed to send");
  assert.equal(label("outbound", "queued", "system"), "System message sending");
  assert.equal(label("outbound", "logged", "user"), "Note added");
});
