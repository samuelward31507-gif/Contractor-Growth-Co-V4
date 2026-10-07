/**
 * The booking branches of the n8n callback record their outbound gate
 * decision on the execution, like every other gated send - so a TEST-mode
 * availability offer or booking confirmation is provably blocked by
 * organization_not_live rather than just "should_send: false". Runs the REAL
 * handleBookingIntent with every database/network dependency mocked; nothing
 * reaches TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/api/automation/n8n-callback/booking-gate-audit.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

const SLOTS = [
  { start_at: "2026-10-13T15:00:00.000Z", end_at: "2026-10-13T16:00:00.000Z" },
  { start_at: "2026-10-13T16:00:00.000Z", end_at: "2026-10-13T17:00:00.000Z" },
];

const state = {
  slots: SLOTS as { start_at: string; end_at: string }[],
  gateBody: null as string | null,
  gate: { allowed: false, reason: "organization_not_live" } as Record<string, unknown>,
  availabilityRange: null as [string, string] | null,
  completion: null as Record<string, unknown> | null,
  sends: 0,
};

const service = {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { timezone: "America/Denver" } }) }) }) }),
};

mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => service } });
mock.module(lib("lib/automation/executions.ts"), {
  namedExports: {
    completeWorkflowExecutionAsService: async (_c: unknown, _id: string, metadata: Record<string, unknown>) => {
      state.completion = metadata;
      return { ok: true };
    },
    failWorkflowExecutionAsService: async () => ({ ok: true }),
  },
});
mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async () => {
      state.sends += 1;
      return { ok: true, messageId: "m1" };
    },
  },
});
mock.module(lib("lib/automation/outbound-gate.ts"), {
  namedExports: {
    evaluateOutboundGate: async (_c: unknown, input: { aiResult: { response_message: string } }) => {
      state.gateBody = input.aiResult.response_message;
      return state.gate;
    },
    // Final Batch 1: the automated-action safeguards are covered in lib/automation/communication-core.test.ts; here they pass.
    evaluateAutomatedActionPreconditions: async () => ({ allowed: true }),
  },
});
mock.module(lib("lib/scheduling/booking.ts"), {
  namedExports: {
    getAvailableBookingSlots: async (_c: unknown, _org: string, start: Date, end: Date) => {
      state.availabilityRange = [start.toISOString(), end.toISOString()];
      return { status: "available", slots: state.slots };
    },
    bookAppointment: async () => ({ success: true, appointmentId: "appt-1", startAt: SLOTS[0]!.start_at, endAt: SLOTS[0]!.end_at, timezone: "America/Denver" }),
    rescheduleAppointment: async () => ({ success: false, reason: "unused" }),
  },
});
mock.module(lib("lib/automation/booking-context.ts"), { namedExports: { getRecentBookingContext: async () => null } });
mock.module(lib("lib/automation/appointments.ts"), { namedExports: { cancelAppointmentAsService: async () => ({ ok: false, reason: "unused" }) } });
mock.module(lib("lib/settings/queries.ts"), { namedExports: { getAiSettings: async () => ({ ai_enabled: true }) } });
mock.module(lib("lib/notifications/founder.ts"), { namedExports: { notifyFounder: async () => undefined } });
mock.module(lib("lib/automation-health/service.ts"), { namedExports: { recordAutomationHealthSignal: async () => undefined } });
mock.module(lib("lib/reviews-referrals/tracking.ts"), { namedExports: { recordPostJobFollowupOutcome: async () => undefined } });

const { handleBookingIntent, selectOfferedSlots, composeAvailabilityOfferMessage, MAX_OFFERED_SLOTS } = await import(lib("app/api/automation/n8n-callback/route.ts"));
const { evaluateContentSafety } = await import(lib("lib/automation/content-safety.ts"));

const params = (bookingIntent: Record<string, unknown>) => ({
  organizationId: "org-1",
  executionId: "exec-1",
  contactId: "contact-1",
  leadId: "lead-1",
  conversationId: "conv-1",
  bookingIntent: { action: "check_availability", date_range_start: null, date_range_end: null, start_at: null, end_at: null, title: "Roof inspection", appointment_id: null, ...bookingIntent },
});

beforeEach(() => {
  state.slots = SLOTS;
  state.gateBody = null;
  state.gate = { allowed: false, reason: "organization_not_live" };
  state.availabilityRange = null;
  state.completion = null;
  state.sends = 0;
});

test("check_availability: the AI's exact local-day range drives the real availability lookup, slots are stored, and the TEST-mode block is recorded", async () => {
  // "next Tuesday" for a Denver org on Monday 2026-10-05, as resolved from the scheduling context.
  await handleBookingIntent(service, params({ date_range_start: "2026-10-13T06:00:00.000Z", date_range_end: "2026-10-14T05:59:59.999Z" }));

  assert.deepEqual(state.availabilityRange, ["2026-10-13T06:00:00.000Z", "2026-10-14T05:59:59.999Z"]);
  assert.equal(state.sends, 0);
  assert.equal(state.completion?.should_send, false);
  assert.equal(state.completion?.blocked_reason, "organization_not_live");
  assert.equal(state.completion?.slot_count, 2);
  assert.deepEqual(state.completion?.offered_slots, SLOTS);
});

test("check_availability: a missing range is still rejected as missing_date_range (ambiguous requests are never guessed)", async () => {
  await handleBookingIntent(service, params({}));
  assert.equal(state.availabilityRange, null);
  assert.equal(state.completion?.error, "missing_date_range");
});

test("check_availability: an allowed offer records no block reason", async () => {
  state.gate = { allowed: true, contactId: "contact-1", conversationId: "conv-1", body: "offer" };
  await handleBookingIntent(service, params({ date_range_start: "2026-10-13T06:00:00.000Z", date_range_end: "2026-10-14T05:59:59.999Z" }), async () => ({ ok: true }) as never);
  assert.equal(state.completion?.blocked_reason, null);
});

test("book: the confirmation's TEST-mode block is recorded alongside the booking result", async () => {
  await handleBookingIntent(service, params({ action: "book", start_at: SLOTS[0]!.start_at, end_at: SLOTS[0]!.end_at }));
  assert.equal(state.completion?.booking_action, "book");
  assert.equal(state.completion?.blocked_reason, "organization_not_live");
  assert.equal(state.sends, 0);
});

// ---------------------------------------------------------------------------
// Offered slots == displayed slots
// ---------------------------------------------------------------------------

/** Sarah's real case: 11 one-hour openings, 7:00 AM - 5:00 PM Denver (13:00Z - 23:00Z) on 2026-10-13. */
const ELEVEN = Array.from({ length: 11 }, (_, i) => ({
  start_at: new Date(Date.UTC(2026, 9, 13, 13 + i)).toISOString(),
  end_at: new Date(Date.UTC(2026, 9, 13, 14 + i)).toISOString(),
}));

test("11 available slots: exactly 5 are offered, spread across the day, and those 5 are the stored selectable offer", async () => {
  state.slots = ELEVEN;
  await handleBookingIntent(service, params({ date_range_start: "2026-10-13T06:00:00.000Z", date_range_end: "2026-10-14T05:59:59.999Z" }));

  const offered = state.completion?.offered_slots as { start_at: string }[];
  assert.equal(offered.length, MAX_OFFERED_SLOTS);
  // 7 AM, 10 AM, 12 PM, 3 PM, 5 PM Denver - first and last opening included, chronological.
  assert.deepEqual(offered.map((slot) => slot.start_at), ["2026-10-13T13:00:00.000Z", "2026-10-13T16:00:00.000Z", "2026-10-13T18:00:00.000Z", "2026-10-13T21:00:00.000Z", "2026-10-13T23:00:00.000Z"]);
  assert.equal(state.completion?.slot_count, 11, "slot_count still reports the real availability");
});

test("displayed slots and selectable slots are identical, and the message says more times exist", async () => {
  state.slots = ELEVEN;
  await handleBookingIntent(service, params({ date_range_start: "2026-10-13T06:00:00.000Z", date_range_end: "2026-10-14T05:59:59.999Z" }));

  const body = state.gateBody!;
  assert.deepEqual(
    body.split("\n").filter((line) => line.includes(" at ")),
    ["7:00 AM", "10:00 AM", "12:00 PM", "3:00 PM", "5:00 PM"].map((time) => `Tuesday, October 13, 2026 at ${time}`),
  );
  assert.equal(body.split("\n").filter((line) => line.includes(" at ")).length, (state.completion?.offered_slots as unknown[]).length);
  assert.match(body, /If none of these suit you, reply with a time that does/);
  assert.deepEqual(evaluateContentSafety(body), { safe: true }, "still passes the outbound content-safety screen");
});

test("1-5 available slots: all offered, message unchanged (no extra line)", async () => {
  for (const count of [1, 2, 5]) {
    const slots = ELEVEN.slice(0, count);
    assert.deepEqual(selectOfferedSlots(slots), slots);
    const message: string = composeAvailabilityOfferMessage(slots, "Roof inspection", "America/Denver");
    assert.ok(message.endsWith("Which works best for you?"), `count ${count}`);
    assert.equal(message.split("\n").filter((line: string) => line.includes(" at ")).length, count);
  }
});
