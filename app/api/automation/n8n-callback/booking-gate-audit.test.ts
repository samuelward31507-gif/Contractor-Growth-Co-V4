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
mock.module(lib("lib/automation/outbound-gate.ts"), { namedExports: { evaluateOutboundGate: async () => state.gate } });
mock.module(lib("lib/scheduling/booking.ts"), {
  namedExports: {
    getAvailableBookingSlots: async (_c: unknown, _org: string, start: Date, end: Date) => {
      state.availabilityRange = [start.toISOString(), end.toISOString()];
      return { status: "available", slots: SLOTS };
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

const { handleBookingIntent } = await import(lib("app/api/automation/n8n-callback/route.ts"));

const params = (bookingIntent: Record<string, unknown>) => ({
  organizationId: "org-1",
  executionId: "exec-1",
  contactId: "contact-1",
  leadId: "lead-1",
  conversationId: "conv-1",
  bookingIntent: { action: "check_availability", date_range_start: null, date_range_end: null, start_at: null, end_at: null, title: "Roof inspection", appointment_id: null, ...bookingIntent },
});

beforeEach(() => {
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
