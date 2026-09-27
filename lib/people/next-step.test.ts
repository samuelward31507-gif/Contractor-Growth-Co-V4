/**
 * Unit tests for findPersonNextStep - pure, no I/O. Mirrors the priority
 * chain app/(app)/leads/[id]/page.tsx's own "What happens next" already
 * uses, generalized across a whole person's records. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test "lib/people/next-step.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Lead } from "@/lib/leads/queries";
import type { Appointment } from "@/lib/appointments/queries";
import type { Estimate } from "@/lib/estimates/queries";
import type { Job } from "@/lib/jobs/queries";
import type { Conversation } from "@/lib/conversations/queries";

const require = createRequire(import.meta.url);
const { findPersonNextStep }: typeof import("./next-step") = require("./next-step.ts");

const NOW = new Date("2026-01-15T12:00:00.000Z").getTime();

const emptyParams = { leads: [] as Lead[], appointments: [] as Appointment[], estimates: [] as Estimate[], jobs: [] as Job[], conversations: [] as Conversation[], now: NOW };

test("a conversation waiting for a human reply outranks everything else", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    conversations: [{ id: "c1", status: "open", ai_enabled: false }] as unknown as Conversation[],
    appointments: [{ id: "a1", status: "scheduled", start_at: "2026-02-01T00:00:00.000Z" }] as unknown as Appointment[],
  });
  assert.equal(result?.href, "/conversations/c1");
  assert.equal(result?.attention, true);
});

test("an AI-handled open conversation does not count as waiting for a human", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    conversations: [{ id: "c1", status: "open", ai_enabled: true }] as unknown as Conversation[],
  });
  assert.equal(result, null);
});

test("a future scheduled appointment outranks a pending estimate", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    appointments: [{ id: "a1", status: "confirmed", start_at: "2026-02-01T00:00:00.000Z", end_at: "2026-02-01T01:00:00.000Z", title: "Site visit" }] as unknown as Appointment[],
    estimates: [{ id: "e1", status: "sent", title: "Roof estimate" }] as unknown as Estimate[],
  });
  assert.equal(result?.href, "/appointments/a1");
  assert.equal(result?.label, "Appointment scheduled");
});

test("a past appointment is not treated as the next step", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    appointments: [{ id: "a1", status: "confirmed", start_at: "2025-01-01T00:00:00.000Z" }] as unknown as Appointment[],
  });
  assert.equal(result, null);
});

test("a pending estimate outranks a plain follow-up nudge", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    estimates: [{ id: "e1", status: "sent", title: "Roof estimate" }] as unknown as Estimate[],
    leads: [{ id: "l1", status: "qualified", created_at: "2026-01-01T00:00:00.000Z" }] as unknown as Lead[],
  });
  assert.equal(result?.href, "/estimates/e1");
  assert.equal(result?.label, "Estimate awaiting response");
});

test("the most recently created lead decides the won branch - a job in progress is surfaced", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    leads: [
      { id: "l-old", status: "lost", created_at: "2025-01-01T00:00:00.000Z" },
      { id: "l-new", status: "won", created_at: "2026-01-10T00:00:00.000Z" },
    ] as unknown as Lead[],
    jobs: [{ id: "j1", lead_id: "l-new", title: "Kitchen remodel" }] as unknown as Job[],
  });
  assert.equal(result?.href, "/jobs/j1");
  assert.equal(result?.label, "Job in progress");
});

test("the most recent lead won with no matching job yields no next step, not a fabricated one", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    leads: [{ id: "l1", status: "won", created_at: "2026-01-10T00:00:00.000Z" }] as unknown as Lead[],
    jobs: [{ id: "j1", lead_id: "some-other-lead" }] as unknown as Job[],
  });
  assert.equal(result, null);
});

test("the most recent lead lost yields no next step", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    leads: [{ id: "l1", status: "lost", created_at: "2026-01-10T00:00:00.000Z" }] as unknown as Lead[],
  });
  assert.equal(result, null);
});

test("an open, un-won, un-lost lead with nothing else in motion yields a follow-up nudge, flagged for attention", () => {
  const result = findPersonNextStep({
    ...emptyParams,
    leads: [{ id: "l1", status: "contacted", created_at: "2026-01-10T00:00:00.000Z" }] as unknown as Lead[],
  });
  assert.equal(result?.label, "Follow up with customer");
  assert.equal(result?.attention, true);
});

test("no leads at all yields no next step", () => {
  const result = findPersonNextStep(emptyParams);
  assert.equal(result, null);
});
