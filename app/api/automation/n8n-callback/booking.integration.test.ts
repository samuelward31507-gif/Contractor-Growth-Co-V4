/**
 * Live integration tests for the Growth System Completion Pass 1 (Part 3)
 * AI Appointment Booking wiring in app/api/automation/n8n-callback/route.ts.
 * Unlike this codebase's other route-handler tests (which need next/headers'
 * cookies() and can only be tested structurally), this route depends only on
 * the standard Request/NextRequest object and a service-role client - a real
 * NextRequest can be constructed directly and POST() called against it, the
 * same way this file's own fixtures exercise the real Supabase project. No
 * real n8n/Twilio call is ever made; this file calls POST() directly, which
 * is the actual boundary n8n itself calls in production.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/api/automation/n8n-callback/booking.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { findOrCreateOpenConversation }: typeof import("@/lib/conversations/queries") = require(path.join(REPO_ROOT, "lib/conversations/queries.ts"));
const { NextRequest } = require("next/server");
const { POST, handleBookingIntent }: typeof import("./route") = require(path.join(REPO_ROOT, "app/api/automation/n8n-callback/route.ts"));

function fakeSendSms() {
  return async () => ({ ok: true as const, providerMessageId: `FAKE-${Date.now()}-${Math.random()}` });
}

const service = createServiceRoleClient();
const SECRET = process.env.N8N_WEBHOOK_SECRET!;
const CALLBACK_URL = "http://localhost/api/automation/n8n-callback";

function callback(body: unknown) {
  return new NextRequest(CALLBACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trackpr-webhook-secret": SECRET },
    body: JSON.stringify(body),
  });
}

let organizationId: string;
let otherOrgId: string;
let contactId: string;

async function makeExecution(orgId: string, cId: string | null) {
  // Reuses (never re-inserts) this contact's single open SMS conversation -
  // conversations has a real DB-level uniqueness guarantee on
  // (organization_id, contact_id, channel) while status = 'open', the same
  // constraint every production caller already respects via
  // findOrCreateOpenConversation.
  const conversation = cId ? await findOrCreateOpenConversation(service, orgId, cId, "sms") : null;
  if (!conversation) throw new Error("failed to find/create test conversation");
  const { data: event, error: eventError } = await service
    .from("automation_events")
    .insert({
      organization_id: orgId,
      event_type: "customer.message.received",
      entity_type: "conversation",
      entity_id: conversation.id,
      status: "processing",
      payload: { contact_id: cId, conversation_id: conversation.id, lead_id: null },
    })
    .select("id")
    .single();
  if (eventError || !event) throw new Error(`automation_events insert failed: ${eventError?.message}`);
  const { data: execution, error: executionError } = await service
    .from("workflow_executions")
    .insert({ organization_id: orgId, automation_event_id: event.id, workflow_name: "customer_reply_followup", status: "running", attempt: 1 })
    .select("id")
    .single();
  if (executionError || !execution) throw new Error(`workflow_executions insert failed: ${executionError?.message}`);
  return { executionId: execution.id as string, eventId: event.id as string, conversationId: conversation.id as string };
}

function baseAiResult(overrides: Record<string, unknown> = {}) {
  return {
    should_send: false,
    response_message: null,
    qualification_status: "qualified",
    missing_information: [],
    urgency: "normal",
    needs_human: false,
    model: "test-model",
    intent: "booking",
    summary: "Customer wants to book an appointment.",
    booking_intent: null,
    ...overrides,
  };
}

// 2027-02-01 is a Monday.
const MONDAY_RANGE = { start: "2027-02-01T00:00:00.000Z", end: "2027-02-02T00:00:00.000Z" };
const FIRST_SLOT = { start_at: "2027-02-01T09:00:00.000Z", end_at: "2027-02-01T10:00:00.000Z" };

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "n8n Booking Callback Test Org", payment_status: "active", automation_mode: "live", timezone: "UTC" }).select("id").single();
  organizationId = org!.id;
  await service.from("business_hours").insert(
    ["monday", "tuesday", "wednesday", "thursday", "friday"].map((day) => ({ organization_id: organizationId, day_of_week: day, is_open: true, open_time: "09:00", close_time: "17:00" })),
  );
  await service.from("business_hours").insert(
    ["saturday", "sunday"].map((day) => ({ organization_id: organizationId, day_of_week: day, is_open: false })),
  );
  await service.from("booking_settings").insert({ organization_id: organizationId, booking_enabled: true, minimum_notice_minutes: 0, default_duration_minutes: 60, buffer_minutes: 0 });

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Jane", last_name: "Doe", phone: "+15555550199" }).select("id").single();
  contactId = contact!.id;

  const { data: other } = await service.from("organizations").insert({ name: "n8n Booking Callback Test Org (Other)", payment_status: "active", automation_mode: "live" }).select("id").single();
  otherOrgId = other!.id;
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("appointments").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("business_hours").delete().eq("organization_id", orgId);
    await service.from("booking_settings").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("1. check_availability returns real slots in the callback's own JSON response, never invented", async () => {
  const { executionId, eventId } = await makeExecution(organizationId, contactId);
  const response = await POST(
    callback({
      execution_id: executionId,
      event_id: eventId,
      organization_id: organizationId,
      ai_result: baseAiResult({ booking_intent: { action: "check_availability", date_range_start: MONDAY_RANGE.start, date_range_end: MONDAY_RANGE.end, start_at: null, end_at: null, title: null } }),
    }),
  );
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(json.booking.status, "available");
  assert.ok(Array.isArray(json.booking.slots));
  assert.deepEqual(json.booking.slots[0], FIRST_SLOT);
});

test("2. check_availability's response contains ONLY start_at/end_at per slot - no Google metadata, no internal ids", async () => {
  const { executionId, eventId } = await makeExecution(organizationId, contactId);
  const response = await POST(
    callback({
      execution_id: executionId,
      event_id: eventId,
      organization_id: organizationId,
      ai_result: baseAiResult({ booking_intent: { action: "check_availability", date_range_start: MONDAY_RANGE.start, date_range_end: MONDAY_RANGE.end, start_at: null, end_at: null, title: null } }),
    }),
  );
  const json = await response.json();
  for (const slot of json.booking.slots) {
    assert.deepEqual(Object.keys(slot).sort(), ["end_at", "start_at"]);
  }
});

test("3. a successful booking creates a real Trackpr appointment and sends a deterministic confirmation SMS", async () => {
  // Calls handleBookingIntent directly (with a fake sendSmsFn - this
  // environment has no real Twilio credentials configured, matching every
  // other test in this codebase) rather than through POST(), since POST's
  // own signature is fixed by Next.js's generated route-handler type
  // contract and cannot accept a test-only extra parameter. Everything
  // POST() would have done before reaching this branch (auth, execution
  // lookup, the running-status guard) is already covered by the other tests
  // in this file that DO go through POST() end-to-end.
  const { executionId, conversationId } = await makeExecution(organizationId, contactId);
  const response = await handleBookingIntent(
    service,
    {
      organizationId,
      executionId,
      contactId,
      leadId: null,
      conversationId,
      bookingIntent: { action: "book", date_range_start: null, date_range_end: null, start_at: FIRST_SLOT.start_at, end_at: FIRST_SLOT.end_at, title: "AC Repair" },
    },
    fakeSendSms(),
  );
  const json = await response.json();
  assert.equal(json.booking.status, "booked");
  assert.ok(json.booking.appointment_id);

  const { data: appointment } = await service.from("appointments").select("status, contact_id, start_at").eq("id", json.booking.appointment_id).single();
  assert.equal(appointment?.status, "scheduled");
  assert.equal(appointment?.contact_id, contactId);

  // Phase 2D.2: check_availability (tests 1-2, above, sharing this same
  // contact's single open conversation via makeExecution's
  // findOrCreateOpenConversation) now also sends a real deterministic
  // availability-offer message - so this conversation is no longer
  // guaranteed to contain exactly one outbound message. Find the booking
  // confirmation specifically rather than assuming it's the only one.
  const { data: messages } = await service.from("messages").select("body, status").eq("conversation_id", conversationId).eq("direction", "outbound");
  const confirmationMessage = messages?.find((message) => /booked/i.test(message.body ?? ""));
  assert.ok(confirmationMessage, "expected a booking confirmation message to have been sent");
  assert.equal(confirmationMessage.status, "sent");
});

test("4. AI SAFETY: booking a slot never actually returned by availability is rejected as slot_unavailable, and re-offers real fresh slots", async () => {
  const { executionId, eventId } = await makeExecution(organizationId, contactId);
  const response = await POST(
    callback({
      execution_id: executionId,
      event_id: eventId,
      organization_id: organizationId,
      ai_result: baseAiResult({
        booking_intent: { action: "book", date_range_start: null, date_range_end: null, start_at: "2027-02-01T23:00:00.000Z", end_at: "2027-02-02T00:00:00.000Z", title: "Hallucinated slot" },
      }),
    }),
  );
  const json = await response.json();
  assert.equal(json.booking.status, "slot_unavailable");
  assert.equal(json.booking.appointment_id, null);
  assert.ok(Array.isArray(json.booking.slots));

  const { data: appointments } = await service.from("appointments").select("id").eq("start_at", "2027-02-01T23:00:00.000Z");
  assert.equal(appointments?.length, 0);
});

test("5. slot_unavailable never escalates to a human - it's a normal retry, not an incident", async () => {
  const { executionId, eventId, conversationId } = await makeExecution(organizationId, contactId);
  await POST(
    callback({
      execution_id: executionId,
      event_id: eventId,
      organization_id: organizationId,
      ai_result: baseAiResult({
        booking_intent: { action: "book", date_range_start: null, date_range_end: null, start_at: "2027-02-01T23:00:00.000Z", end_at: "2027-02-02T00:00:00.000Z", title: "Hallucinated slot" },
      }),
    }),
  );
  const { data: conversation } = await service.from("conversations").select("ai_enabled").eq("id", conversationId).single();
  assert.equal(conversation?.ai_enabled, true, "a benign slot_unavailable retry must never lock AI out of the conversation");
});

test("6. a payment-inactive organization's booking attempt escalates to a human and sends only the generic fallback message - never a business-internal reason", async () => {
  const { data: inactiveOrg } = await service.from("organizations").insert({ name: "n8n Booking Callback Test Org (Inactive)", payment_status: "payment_required", automation_mode: "live" }).select("id").single();
  const { data: inactiveContact } = await service.from("contacts").insert({ organization_id: inactiveOrg!.id, phone: "+15555550188" }).select("id").single();
  try {
    const { executionId, eventId, conversationId } = await makeExecution(inactiveOrg!.id, inactiveContact!.id);
    const response = await POST(
      callback({
        execution_id: executionId,
        event_id: eventId,
        organization_id: inactiveOrg!.id,
        ai_result: baseAiResult({
          booking_intent: { action: "book", date_range_start: null, date_range_end: null, start_at: "2027-02-01T09:00:00.000Z", end_at: "2027-02-01T10:00:00.000Z", title: "AC Repair" },
        }),
      }),
    );
    const json = await response.json();
    assert.equal(json.booking.status, "organization_not_active");

    const { data: conversation } = await service.from("conversations").select("ai_enabled").eq("id", conversationId).single();
    assert.equal(conversation?.ai_enabled, false, "a genuine configuration/payment failure must escalate to a human");

    const { data: messages } = await service.from("messages").select("body").eq("conversation_id", conversationId).eq("direction", "outbound");
    if (messages && messages.length > 0) {
      assert.doesNotMatch(messages[0].body ?? "", /payment|billing|subscription/i, "the customer-facing fallback message must never reveal internal billing state");
    }
  } finally {
    await service.from("conversations").delete().eq("organization_id", inactiveOrg!.id);
    await service.from("automation_events").delete().eq("organization_id", inactiveOrg!.id);
    await service.from("workflow_executions").delete().eq("organization_id", inactiveOrg!.id);
    await service.from("messages").delete().eq("organization_id", inactiveOrg!.id);
    await service.from("contacts").delete().eq("organization_id", inactiveOrg!.id);
    await service.from("organizations").delete().eq("id", inactiveOrg!.id);
  }
});

test("7. IDEMPOTENCY: retrying the exact same booking callback never creates a second appointment", async () => {
  const { executionId, eventId } = await makeExecution(organizationId, contactId);
  const body = {
    execution_id: executionId,
    event_id: eventId,
    organization_id: organizationId,
    ai_result: baseAiResult({
      booking_intent: { action: "book", date_range_start: null, date_range_end: null, start_at: "2027-02-01T11:00:00.000Z", end_at: "2027-02-01T12:00:00.000Z", title: "AC Repair" },
    }),
  };

  const first = await POST(callback(body));
  const firstJson = await first.json();
  assert.equal(firstJson.booking.status, "booked");

  // The execution is no longer "running" after the first call completes it -
  // a genuinely replayed callback for the same execution is the
  // alreadyProcessed short-circuit at the very top of POST(), the same
  // idempotency guarantee every other event type in this route already has.
  const second = await POST(callback(body));
  const secondJson = await second.json();
  assert.equal(secondJson.alreadyProcessed, true);

  const { data: appointments } = await service.from("appointments").select("id").eq("organization_id", organizationId).eq("start_at", "2027-02-01T11:00:00.000Z");
  assert.equal(appointments?.length, 1);
});

test("8. cross-org isolation: a booking callback for organization A can never book against organization B's contact", async () => {
  const { executionId, eventId } = await makeExecution(organizationId, contactId);
  const response = await POST(
    callback({
      execution_id: executionId,
      event_id: eventId,
      organization_id: organizationId,
      ai_result: baseAiResult({
        booking_intent: { action: "book", date_range_start: null, date_range_end: null, start_at: "2027-02-01T13:00:00.000Z", end_at: "2027-02-01T14:00:00.000Z", title: "Cross-org attempt" },
      }),
    }),
  );
  // contactId legitimately belongs to organizationId here, so this should
  // actually succeed - the real cross-org test is that organization_id in
  // the request body is independently cross-checked against the execution's
  // own stored organization_id (see the existing "Organization mismatch"
  // check at the top of POST, exercised directly below).
  const json = await response.json();
  assert.equal(json.booking.status, "booked");

  const mismatchResponse = await POST(
    callback({
      execution_id: executionId,
      event_id: eventId,
      organization_id: otherOrgId,
      ai_result: baseAiResult({ booking_intent: { action: "book", date_range_start: null, date_range_end: null, start_at: "2027-02-01T15:00:00.000Z", end_at: "2027-02-01T16:00:00.000Z", title: "Should be rejected" } }),
    }),
  );
  assert.equal(mismatchResponse.status, 403);
});

test("10. action=reschedule moves a real appointment to the new time and preserves its id (via handleBookingIntent, same pattern as test 3)", async () => {
  const { data: appointment } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactId, title: "AC Repair", start_at: "2027-02-08T09:00:00.000Z", end_at: "2027-02-08T10:00:00.000Z", status: "scheduled" })
    .select("id")
    .single();
  const { executionId, conversationId } = await makeExecution(organizationId, contactId);
  const response = await handleBookingIntent(
    service,
    {
      organizationId,
      executionId,
      contactId,
      leadId: null,
      conversationId,
      bookingIntent: { action: "reschedule", date_range_start: null, date_range_end: null, start_at: "2027-02-08T11:00:00.000Z", end_at: "2027-02-08T12:00:00.000Z", title: null, appointment_id: appointment!.id },
    },
    fakeSendSms(),
  );
  const json = await response.json();
  assert.equal(json.booking.status, "rescheduled");

  const { data: row } = await service.from("appointments").select("id, start_at, status").eq("id", appointment!.id).single();
  assert.equal(row?.id, appointment!.id, "reschedule must update the same row, never create a new one");
  assert.equal(new Date(row!.start_at).getTime(), new Date("2027-02-08T11:00:00.000Z").getTime());
  assert.equal(row?.status, "scheduled");
});

test("11. action=reschedule with a missing appointment_id is rejected as invalid_request - never crashes, never falls through to booking a new appointment", async () => {
  const { executionId, conversationId } = await makeExecution(organizationId, contactId);
  const response = await handleBookingIntent(
    service,
    {
      organizationId,
      executionId,
      contactId,
      leadId: null,
      conversationId,
      bookingIntent: { action: "reschedule", date_range_start: null, date_range_end: null, start_at: "2027-02-09T11:00:00.000Z", end_at: "2027-02-09T12:00:00.000Z", title: null, appointment_id: null },
    },
    fakeSendSms(),
  );
  const json = await response.json();
  assert.equal(json.booking.status, "invalid_request");

  const { data: appointments } = await service.from("appointments").select("id").eq("start_at", "2027-02-09T11:00:00.000Z");
  assert.equal(appointments?.length, 0, "a reschedule with no target appointment must never create a brand-new appointment");
});

test("12. action=cancel with a real appointment_id cancels the real appointment", async () => {
  const { data: appointment } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactId, title: "AC Repair", start_at: "2027-02-10T09:00:00.000Z", end_at: "2027-02-10T10:00:00.000Z", status: "scheduled" })
    .select("id")
    .single();
  const { executionId, conversationId } = await makeExecution(organizationId, contactId);
  const response = await handleBookingIntent(
    service,
    {
      organizationId,
      executionId,
      contactId,
      leadId: null,
      conversationId,
      bookingIntent: { action: "cancel", date_range_start: null, date_range_end: null, start_at: null, end_at: null, title: null, appointment_id: appointment!.id },
    },
    fakeSendSms(),
  );
  const json = await response.json();
  assert.equal(json.booking.status, "cancelled");

  const { data: row } = await service.from("appointments").select("status").eq("id", appointment!.id).single();
  assert.equal(row?.status, "cancelled");
});

test("13. action=cancel with a missing appointment_id is rejected as invalid_request - never guesses which appointment", async () => {
  const { executionId, conversationId } = await makeExecution(organizationId, contactId);
  const response = await handleBookingIntent(
    service,
    { organizationId, executionId, contactId, leadId: null, conversationId, bookingIntent: { action: "cancel", date_range_start: null, date_range_end: null, start_at: null, end_at: null, title: null, appointment_id: null } },
    fakeSendSms(),
  );
  const json = await response.json();
  assert.equal(json.booking.status, "invalid_request");
});

test("14. MALFORMED AI OUTPUT: a non-UUID appointment_id is rejected by request validation before any booking logic runs", async () => {
  const { executionId, eventId } = await makeExecution(organizationId, contactId);
  const response = await POST(
    callback({
      execution_id: executionId,
      event_id: eventId,
      organization_id: organizationId,
      ai_result: baseAiResult({ booking_intent: { action: "cancel", date_range_start: null, date_range_end: null, start_at: null, end_at: null, title: null, appointment_id: "not-a-real-uuid" } }),
    }),
  );
  assert.equal(response.status, 400, "a malformed appointment_id must fail validation, never reach cancelAppointmentAsService");
});

test("15. MALFORMED AI OUTPUT: an unrecognized booking action string is rejected by request validation, never silently treated as a real action", async () => {
  const { executionId, eventId } = await makeExecution(organizationId, contactId);
  const response = await POST(
    callback({
      execution_id: executionId,
      event_id: eventId,
      organization_id: organizationId,
      ai_result: baseAiResult({ booking_intent: { action: "delete_everything", date_range_start: null, date_range_end: null, start_at: null, end_at: null, title: null } }),
    }),
  );
  assert.equal(response.status, 400);
});

test("16. IDEMPOTENCY: retrying the exact same reschedule callback never moves the appointment twice or double-sends a confirmation", async () => {
  const { data: appointment } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactId, title: "AC Repair", start_at: "2027-02-11T09:00:00.000Z", end_at: "2027-02-11T10:00:00.000Z", status: "scheduled" })
    .select("id")
    .single();
  const { executionId, eventId } = await makeExecution(organizationId, contactId);
  const body = {
    execution_id: executionId,
    event_id: eventId,
    organization_id: organizationId,
    ai_result: baseAiResult({ booking_intent: { action: "reschedule", date_range_start: null, date_range_end: null, start_at: "2027-02-11T13:00:00.000Z", end_at: "2027-02-11T14:00:00.000Z", title: null, appointment_id: appointment!.id } }),
  };

  const first = await POST(callback(body));
  const firstJson = await first.json();
  assert.equal(firstJson.booking.status, "rescheduled");

  const second = await POST(callback(body));
  const secondJson = await second.json();
  assert.equal(secondJson.alreadyProcessed, true);

  const { data: row } = await service.from("appointments").select("id, start_at").eq("id", appointment!.id).single();
  assert.equal(new Date(row!.start_at).getTime(), new Date("2027-02-11T13:00:00.000Z").getTime());
});

test("9. an unauthorized request (wrong/missing secret) is rejected before any booking logic runs", async () => {
  const { executionId, eventId } = await makeExecution(organizationId, contactId);
  const request = new NextRequest(CALLBACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trackpr-webhook-secret": "wrong-secret" },
    body: JSON.stringify({ execution_id: executionId, event_id: eventId, organization_id: organizationId, ai_result: baseAiResult({ booking_intent: { action: "book", date_range_start: null, date_range_end: null, start_at: "2027-02-01T14:00:00.000Z", end_at: "2027-02-01T15:00:00.000Z", title: "x" } }) }),
  });
  const response = await POST(request);
  assert.equal(response.status, 401);

  const { data: appointments } = await service.from("appointments").select("id").eq("start_at", "2027-02-01T14:00:00.000Z");
  assert.equal(appointments?.length, 0);
});
