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

const require = createRequire(import.meta.url);
const { buildPersonTimeline }: typeof import("./timeline") = require("./timeline.ts");

const emptyParams = {
  leads: [] as Lead[],
  stageHistoryByLeadId: new Map<string, LeadStageHistoryEntry[]>(),
  appointments: [] as Appointment[],
  estimates: [] as Estimate[],
  jobs: [] as Job[],
  messages: [] as Message[],
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

test("an empty person (no records anywhere) yields an empty timeline, not an error", () => {
  const events = buildPersonTimeline(emptyParams);
  assert.deepEqual(events, []);
});
