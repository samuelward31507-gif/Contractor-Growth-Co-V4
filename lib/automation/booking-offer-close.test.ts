/**
 * A booked availability offer is closed: once a customer's slot selection
 * books an appointment, that offer is no longer the conversation's active
 * booking context, so a following "YES" reaches the appointment-confirmation
 * path instead of being read as an ambiguous multi-slot selection.
 *
 * Runs the REAL classifyAndProcessBookingReply, getRecentBookingContext and
 * confirmAppointmentAsService against an in-memory table store. Event /
 * execution bookkeeping, the outbound gate (always blocking, as in TEST
 * mode), sending and bookAppointment's write are mocked; nothing reaches
 * TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/booking-offer-close.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "org-1";
const CONTACT = "contact-1";
const LEAD = "lead-1";
const CONV = "conv-1";
const SLOTS = [
  { start_at: "2099-03-03T15:00:00.000Z", end_at: "2099-03-03T16:00:00.000Z" },
  { start_at: "2099-03-03T16:00:00.000Z", end_at: "2099-03-03T17:00:00.000Z" },
  { start_at: "2099-03-03T17:00:00.000Z", end_at: "2099-03-03T18:00:00.000Z" },
];

let store: Record<string, Row[]> = {};
let clock = 0;
let ids = 0;
const tick = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString();
const nextId = (prefix: string) => `${prefix}-${++ids}`;
const sends = { count: 0 };

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private insertRows: Row[] | null = null;
  private sortBy: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private singleRow = false;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  gt(column: string, value: string) { this.filters.push((row) => String(row[column]) > value); return this; }
  gte(column: string, value: string) { this.filters.push((row) => String(row[column]) >= value); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.sortBy = { column, ascending: options?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  update(values: Row) { this.updateValues = values; return this; }
  insert(values: Row | Row[]) { this.insertRows = Array.isArray(values) ? values : [values]; return this; }
  single() { return this.maybeSingle(); }
  maybeSingle() { this.singleRow = true; return this.run(); }
  then<T>(resolve: (value: { data: unknown; error: null }) => T, reject?: (reason: unknown) => T) { return this.run().then(resolve, reject); }
  private async run() {
    if (this.insertRows) {
      const now = tick();
      const inserted = this.insertRows.map((row) => ({ id: nextId(this.table), created_at: now, updated_at: now, ...row }));
      (store[this.table] ??= []).push(...inserted);
      return { data: this.singleRow ? inserted[0] : inserted, error: null };
    }
    let rows = (store[this.table] ?? []).filter((row) => this.filters.every((f) => f(row)));
    if (this.updateValues) for (const row of rows) Object.assign(row, this.updateValues, { updated_at: tick() });
    if (this.sortBy) {
      const { column, ascending } = this.sortBy;
      rows = [...rows].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return { data: this.singleRow ? (rows[0] ?? null) : rows, error: null };
  }
}
const supabase = { from: (table: string) => new Query(table) };

const createEvent = async (_s: unknown, organizationId: string, input: Row) => {
  const duplicate = (store.automation_events ?? []).find((e) => e.idempotency_key === input.idempotencyKey);
  if (duplicate) return { ok: true, duplicate: true, skipped: false, event: duplicate };
  const event = { id: nextId("evt"), organization_id: organizationId, event_type: input.eventType, entity_type: input.entityType, entity_id: input.entityId, idempotency_key: input.idempotencyKey, created_at: tick() };
  store.automation_events.push(event);
  return { ok: true, duplicate: false, skipped: false, event };
};
const startExecution = async (_s: unknown, eventId: string, workflowName: string) => {
  const event = store.automation_events.find((e) => e.id === eventId)!;
  const execution = { id: nextId("exec"), automation_event_id: eventId, organization_id: event.organization_id, workflow_name: workflowName, status: "running", started_at: tick(), metadata: null };
  store.workflow_executions.push(execution);
  return { ok: true, execution: { id: execution.id, attempt: 1 } };
};
const completeExecution = async (_s: unknown, id: string, metadata: Row) => {
  Object.assign(store.workflow_executions.find((e) => e.id === id)!, { status: "completed", metadata });
  return { ok: true };
};
const failExecution = async (_s: unknown, id: string) => {
  Object.assign(store.workflow_executions.find((e) => e.id === id)!, { status: "failed" });
  return { ok: true };
};

mock.module(lib("lib/automation/events.ts"), { namedExports: { createAutomationEventAsService: createEvent, createAutomationEvent: createEvent } });
mock.module(lib("lib/automation/executions.ts"), {
  namedExports: {
    startWorkflowExecutionAsService: startExecution,
    completeWorkflowExecutionAsService: completeExecution,
    failWorkflowExecutionAsService: failExecution,
    startWorkflowExecution: startExecution,
    completeWorkflowExecution: completeExecution,
    failWorkflowExecution: failExecution,
  },
});
mock.module(lib("lib/automation/outbound-gate.ts"), { namedExports: { evaluateOutboundGate: async () => ({ allowed: false, reason: "organization_not_live" }) } });
mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async () => {
      sends.count += 1;
      return { ok: true, messageId: "m" };
    },
  },
});
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => supabase } });
mock.module(lib("lib/notifications/founder.ts"), { namedExports: { notifyFounder: async () => ({ outcome: "no_recipient" }) } });
mock.module(lib("lib/automation-health/service.ts"), { namedExports: { recordAutomationHealthSignal: async () => undefined } });
mock.module(lib("app/api/automation/n8n-callback/route.ts"), {
  namedExports: {
    composeAvailabilityOfferMessage: () => "offer",
    resolveBookingFallbackTitle: async () => "Appointment",
    BOOKING_FALLBACK_MESSAGE: "fallback",
    serializeSlots: (slots: unknown) => slots,
  },
});
mock.module(lib("lib/scheduling/booking.ts"), {
  namedExports: {
    getAvailableBookingSlots: async () => ({ status: "available", slots: SLOTS }),
    rescheduleAppointment: async () => ({ success: false, reason: "unused" }),
    // The real bookAppointment's idempotency key makes a replayed selection
    // resolve to the same appointment; mirrored here.
    bookAppointment: async (_s: unknown, input: Row) => {
      const existing = store.appointments.find((a) => a.idempotency_key === input.idempotencyKey);
      if (existing) return { success: true, appointmentId: existing.id, startAt: existing.start_at, endAt: existing.end_at, timezone: "UTC", calendarSyncStatus: "synced" };
      const now = tick();
      const appointment = {
        id: nextId("appt"),
        organization_id: input.organizationId,
        contact_id: input.contactId,
        lead_id: input.leadId,
        start_at: input.startAt,
        end_at: input.endAt,
        title: input.title,
        status: "scheduled",
        confirmed_at: null,
        idempotency_key: input.idempotencyKey,
        created_at: now,
        updated_at: now,
      };
      store.appointments.push(appointment);
      return { success: true, appointmentId: appointment.id, startAt: appointment.start_at, endAt: appointment.end_at, timezone: "UTC", calendarSyncStatus: "synced" };
    },
  },
});

const { classifyAndProcessBookingReply } = await import(lib("lib/automation/booking-reply.ts"));
const { getRecentBookingContext } = await import(lib("lib/automation/booking-context.ts"));

/** The stored check_availability offer, exactly as the n8n callback records it. */
async function recordOffer() {
  const { event } = await createEvent(null, ORG, { eventType: "customer.message.received", entityType: "conversation", entityId: CONV, idempotencyKey: `customer.message.received:${nextId("sim")}` });
  const { execution } = await startExecution(null, event.id as string, "customer_reply_followup");
  await completeExecution(null, execution.id, { booking_action: "check_availability", availability_status: "available", offered_slots: SLOTS, offered_title: "Roof inspection", reschedule_appointment_id: null, should_send: false, blocked_reason: "organization_not_live" });
}

/** An already-booked upcoming appointment (no booking context left open). */
function addUpcomingAppointment(startAt: string) {
  const now = tick();
  const appointment = { id: nextId("appt"), organization_id: ORG, contact_id: CONTACT, lead_id: LEAD, start_at: startAt, end_at: startAt, title: "Roof inspection", status: "scheduled", confirmed_at: null, created_at: now, updated_at: now };
  store.appointments.push(appointment);
  return appointment;
}

const reply = (body: string) => classifyAndProcessBookingReply(supabase, ORG, CONTACT, LEAD, CONV, body);
const eventsOfType = (type: string) => store.automation_events.filter((e) => e.event_type === type);

beforeEach(() => {
  store = {
    automation_events: [],
    workflow_executions: [],
    appointments: [],
    conversations: [{ id: CONV, organization_id: ORG, contact_id: CONTACT }],
    organizations: [{ id: ORG, timezone: "UTC" }],
  };
  clock = 0;
  ids = 0;
  sends.count = 0;
});

test("1. open offer + ambiguous YES -> clarification, unchanged: nothing booked or confirmed, offer stays open", async () => {
  await recordOffer();

  assert.equal(await reply("YES"), true);

  assert.equal(eventsOfType("appointment.slot_clarification_sent").length, 1);
  assert.equal(store.appointments.length, 0);
  assert.equal(eventsOfType("appointment.confirmation_acknowledged").length, 0);
  const context = await getRecentBookingContext(supabase, ORG, CONV);
  assert.equal(context?.type, "offer");
  assert.equal(sends.count, 0, "the TEST-mode gate blocks the clarification");
});

test("2. open offer + valid slot -> the appointment is created and the offer becomes inactive", async () => {
  await recordOffer();
  assert.equal((await getRecentBookingContext(supabase, ORG, CONV))?.type, "offer");

  assert.equal(await reply("4:00 PM works for me"), true);

  assert.equal(store.appointments.length, 1);
  assert.equal(store.appointments[0]!.start_at, SLOTS[1]!.start_at);
  assert.equal(store.appointments[0]!.status, "scheduled");
  assert.equal(eventsOfType("appointment.booked_confirmation_sent").length, 1);
  assert.equal(await getRecentBookingContext(supabase, ORG, CONV), null, "a booked offer is never an active offer again");
});

test("3. booked offer + YES -> the confirmation path runs and confirmed_at is recorded", async () => {
  await recordOffer();
  await reply("4:00 PM works for me");

  assert.equal(await reply("YES"), true);

  const [appointment] = store.appointments;
  assert.equal(appointment!.status, "confirmed");
  assert.ok(typeof appointment!.confirmed_at === "string" && appointment!.confirmed_at.length > 0);
  assert.equal(eventsOfType("appointment.slot_clarification_sent").length, 0, "YES is not read as a slot selection");
  assert.equal(eventsOfType("appointment.confirmation_acknowledged").length, 1);
  assert.equal(store.appointments.length, 1);
  assert.equal(sends.count, 0, "the TEST-mode gate blocks the acknowledgement");
});

test("4. repeated YES after confirmation -> no duplicate side effects", async () => {
  await recordOffer();
  await reply("4:00 PM works for me");
  await reply("YES");
  const confirmedAt = store.appointments[0]!.confirmed_at;
  const eventCount = store.automation_events.length;

  assert.equal(await reply("YES"), true, "handled silently, never handed to the AI");
  assert.equal(await reply("yes"), true);

  assert.equal(store.appointments.length, 1);
  assert.equal(store.appointments[0]!.confirmed_at, confirmedAt, "confirmed_at is never re-stamped");
  assert.equal(store.automation_events.length, eventCount, "no second acknowledgement, clarification or booking");
});

test("a replayed slot selection after booking books nothing new (offer closed, no duplicate appointment)", async () => {
  await recordOffer();
  await reply("4:00 PM works for me");

  await reply("4:00 PM works for me");

  assert.equal(store.appointments.length, 1);
  assert.equal(eventsOfType("appointment.booked_confirmation_sent").length, 1);
});

test("an appointment at an offered time that predates the offer does not close it", async () => {
  store.appointments.push({ id: "appt-old", organization_id: ORG, contact_id: CONTACT, start_at: SLOTS[0]!.start_at, end_at: SLOTS[0]!.end_at, status: "cancelled", created_at: tick(), updated_at: tick() });
  await recordOffer();

  assert.equal((await getRecentBookingContext(supabase, ORG, CONV))?.type, "offer");
});

test("an appointment for a different contact does not close this conversation's offer", async () => {
  await recordOffer();
  store.appointments.push({ id: "appt-other", organization_id: ORG, contact_id: "contact-2", start_at: SLOTS[0]!.start_at, end_at: SLOTS[0]!.end_at, status: "scheduled", created_at: tick(), updated_at: tick() });

  assert.equal((await getRecentBookingContext(supabase, ORG, CONV))?.type, "offer");
});

// ---------------------------------------------------------------------------
// Natural-language confirmation through the real reply handler
// ---------------------------------------------------------------------------

for (const body of ["YES", "Yes, that time works for me.", "Yes, that works.", "That time works for me"]) {
  test(`booked offer + "${body}" -> confirms the one upcoming appointment and records confirmed_at`, async () => {
    await recordOffer();
    await reply("4:00 PM works for me");

    assert.equal(await reply(body), true);

    assert.equal(store.appointments[0]!.status, "confirmed");
    assert.ok(store.appointments[0]!.confirmed_at);
    assert.equal(eventsOfType("appointment.confirmation_acknowledged").length, 1);
    assert.equal(eventsOfType("appointment.slot_clarification_sent").length, 0);
  });
}

test("a negative or ambiguous reply never confirms (handed on to the normal AI flow)", async () => {
  const appointment = addUpcomingAppointment("2099-04-01T15:00:00.000Z");
  for (const body of ["No, that time does not work", "Maybe", "Yes, but can we do 10 instead?"]) {
    await reply(body);
  }
  assert.equal(appointment.status, "scheduled");
  assert.equal(appointment.confirmed_at, null);
  assert.equal(eventsOfType("appointment.confirmation_acknowledged").length, 0);
});

test("a cancellation or reschedule request never confirms", async () => {
  const appointment = addUpcomingAppointment("2099-04-01T15:00:00.000Z");
  await reply("Yes, I need to reschedule");
  await reply("Yes, please cancel it");
  assert.notEqual(appointment.status, "confirmed");
  assert.equal(appointment.confirmed_at, null);
  assert.equal(eventsOfType("appointment.confirmation_acknowledged").length, 0);
});

test("multiple upcoming appointments stay safe: neither the strict nor the natural form confirms either one", async () => {
  const first = addUpcomingAppointment("2099-04-01T15:00:00.000Z");
  const second = addUpcomingAppointment("2099-04-02T15:00:00.000Z");

  assert.equal(await reply("Yes, that time works for me."), false, "handed on, never guessed");
  assert.equal(await reply("YES"), false);

  assert.equal(first.status, "scheduled");
  assert.equal(second.status, "scheduled");
  assert.equal(eventsOfType("appointment.confirmation_acknowledged").length, 0);
});

test("with an OPEN offer the natural form is never trusted: no appointment is confirmed or booked", async () => {
  const existing = addUpcomingAppointment("2099-04-01T15:00:00.000Z");
  await recordOffer();

  await reply("Yes, that time works for me.");

  assert.equal(existing.status, "scheduled", "an open offer means the customer may be choosing a slot, not confirming");
  assert.equal(store.appointments.length, 1);
  assert.equal(eventsOfType("appointment.confirmation_acknowledged").length, 0);
});

test("repeated natural confirmations add nothing after the first", async () => {
  const appointment = addUpcomingAppointment("2099-04-01T15:00:00.000Z");
  await reply("Yes, that time works for me.");
  const confirmedAt = appointment.confirmed_at;
  const eventCount = store.automation_events.length;

  assert.equal(await reply("Yes, that works."), true);

  assert.equal(appointment.confirmed_at, confirmedAt);
  assert.equal(store.automation_events.length, eventCount);
});
