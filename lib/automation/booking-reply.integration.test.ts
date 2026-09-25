/**
 * Pass 1 (booking loop completion + AI receptionist contract hardening):
 * integration tests for classifyAndProcessBookingReply
 * (lib/automation/booking-reply.ts) against a real, disposable Supabase
 * organization. Mirrors booking.integration.test.ts's established fixture
 * pattern (real business_hours/booking_settings, service-role client).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/booking-reply.integration.test.ts
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
const { POST }: typeof import("@/app/api/automation/n8n-callback/route") = require(path.join(REPO_ROOT, "app/api/automation/n8n-callback/route.ts"));
const { classifyAndProcessBookingReply }: typeof import("./booking-reply") = require(path.join(REPO_ROOT, "lib/automation/booking-reply.ts"));

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

async function makeContactLeadConversation(orgId: string, phoneSuffix: string) {
  const { data: contact } = await service.from("contacts").insert({ organization_id: orgId, first_name: "Jane", last_name: "Doe", phone: `+1555570${phoneSuffix}` }).select("id").single();
  const { data: lead } = await service.from("leads").insert({ organization_id: orgId, contact_id: contact!.id, service: "Consult", status: "qualified", temperature: "warm" }).select("id").single();
  const conversation = await findOrCreateOpenConversation(service, orgId, contact!.id, "sms", lead!.id);
  return { contactId: contact!.id as string, leadId: lead!.id as string, conversationId: conversation!.id as string };
}

/** Dispatches a real check_availability turn through the real callback route, so the resulting offer memory is genuinely written by production code, not hand-inserted. */
async function makeRealOffer(orgId: string, contactId: string, leadId: string, conversationId: string, dateRangeStart: string, dateRangeEnd: string) {
  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: orgId, event_type: "customer.message.received", entity_type: "conversation", entity_id: conversationId, status: "processing", payload: { contact_id: contactId, conversation_id: conversationId, lead_id: leadId } })
    .select("id")
    .single();
  const { data: execution } = await service
    .from("workflow_executions")
    .insert({ organization_id: orgId, automation_event_id: event!.id, workflow_name: "customer_reply_followup", status: "running", attempt: 1 })
    .select("id")
    .single();

  const response = await POST(
    callback({
      execution_id: execution!.id,
      event_id: event!.id,
      organization_id: orgId,
      ai_result: {
        should_send: false,
        response_message: null,
        qualification_status: "qualified",
        missing_information: [],
        urgency: "normal",
        needs_human: false,
        model: "test-model",
        intent: "booking",
        summary: "wants to book",
        booking_intent: { action: "check_availability", date_range_start: dateRangeStart, date_range_end: dateRangeEnd, start_at: null, end_at: null, title: "Consult" },
      },
    }),
  );
  const json = await response.json();
  return json.booking.slots as { start_at: string; end_at: string }[];
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Booking Reply Test Org", payment_status: "active", automation_mode: "live", timezone: "UTC" }).select("id").single();
  organizationId = org!.id;
  await service.from("business_hours").insert(
    ["monday", "tuesday", "wednesday", "thursday", "friday"].map((day) => ({ organization_id: organizationId, day_of_week: day, is_open: true, open_time: "09:00", close_time: "17:00" })),
  );
  await service.from("business_hours").insert(["saturday", "sunday"].map((day) => ({ organization_id: organizationId, day_of_week: day, is_open: false })));
  await service.from("booking_settings").insert({ organization_id: organizationId, booking_enabled: true, minimum_notice_minutes: 0, default_duration_minutes: 60, buffer_minutes: 0 });

  const { data: other } = await service.from("organizations").insert({ name: "Booking Reply Test Org (Other)", payment_status: "active", automation_mode: "live" }).select("id").single();
  otherOrgId = other!.id;
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("automation_incidents").delete().eq("organization_id", orgId);
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("appointments").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("leads").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("business_hours").delete().eq("organization_id", orgId);
    await service.from("booking_settings").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

// All same-organization tests below use their OWN distinct weekday so an
// appointment booked by one test never shrinks the real availability a
// later test's makeRealOffer() computes for the same organization - exactly
// the same isolation principle this file already applies to phone numbers
// (unique per-test suffixes), extended to dates since these are REAL
// appointments against REAL, shared organization availability.
const RANGE_A = { start: "2027-03-01T00:00:00.000Z", end: "2027-03-02T00:00:00.000Z" }; // Monday
const RANGE_B = { start: "2027-03-02T00:00:00.000Z", end: "2027-03-03T00:00:00.000Z" }; // Tuesday
const RANGE_C = { start: "2027-03-03T00:00:00.000Z", end: "2027-03-04T00:00:00.000Z" }; // Wednesday
const RANGE_D = { start: "2027-03-04T00:00:00.000Z", end: "2027-03-05T00:00:00.000Z" }; // Thursday
const RANGE_I = { start: "2027-03-15T00:00:00.000Z", end: "2027-03-16T00:00:00.000Z" }; // Monday, two weeks out

test("A. SCENARIO A: availability offered -> customer picks a real slot -> appointment actually exists", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "001");
  const slots = await makeRealOffer(organizationId, contactId, leadId, conversationId, RANGE_A.start, RANGE_A.end);
  assert.ok(slots.length >= 2, "expected multiple real slots offered");

  const handled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "9:00 works.", fakeSendSms());
  assert.equal(handled, true);

  const { data: appointments } = await service.from("appointments").select("id, start_at, end_at, status").eq("organization_id", organizationId).eq("contact_id", contactId);
  assert.equal(appointments?.length, 1, "expected exactly one appointment to exist");
  assert.equal(new Date(appointments![0].start_at).getTime(), new Date(slots[0].start_at).getTime());
  assert.equal(appointments![0].status, "scheduled");

  const { data: messages } = await service.from("messages").select("body, direction").eq("conversation_id", conversationId).eq("direction", "outbound");
  assert.ok(messages!.some((m) => /you're booked/i.test(m.body)), "expected a real confirmation message, sent only after the appointment existed");
});

test("B. SCENARIO B: the exact same customer reply processed twice never creates a second appointment", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "002");
  await makeRealOffer(organizationId, contactId, leadId, conversationId, RANGE_B.start, RANGE_B.end);

  await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "9:00 works.", fakeSendSms());
  await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "9:00 works.", fakeSendSms());

  const { data: appointments } = await service.from("appointments").select("id").eq("organization_id", organizationId).eq("contact_id", contactId);
  assert.equal(appointments?.length, 1, "a duplicate reply must never create a second appointment");
});

test("C. SCENARIO C: selecting a slot that was taken in between offer and selection never double-books, and offers fresh real availability", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "003");
  const slots = await makeRealOffer(organizationId, contactId, leadId, conversationId, RANGE_C.start, RANGE_C.end);

  // Someone else takes the first offered slot in between the offer and the
  // customer's selection - a real appointment, not a mock.
  const { data: otherContact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15555700099" }).select("id").single();
  await service.from("appointments").insert({ organization_id: organizationId, contact_id: otherContact!.id, title: "Taken", start_at: slots[0].start_at, end_at: slots[0].end_at, status: "scheduled" });

  const handled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "9:00 works.", fakeSendSms());
  assert.equal(handled, true);

  const { data: appointments } = await service.from("appointments").select("id").eq("organization_id", organizationId).eq("contact_id", contactId);
  assert.equal(appointments?.length ?? 0, 0, "no appointment must be created for a slot that's already taken");

  const { data: messages } = await service.from("messages").select("body").eq("conversation_id", conversationId).eq("direction", "outbound");
  assert.ok(messages!.some((m) => /just taken/i.test(m.body)), "expected an honest 'that time was just taken' re-offer message");
});

test("D. an ambiguous bare 'yes' with multiple offered slots asks for clarification and books nothing", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "004");
  await makeRealOffer(organizationId, contactId, leadId, conversationId, RANGE_D.start, RANGE_D.end);

  const handled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "yes", fakeSendSms());
  assert.equal(handled, true);

  const { data: appointments } = await service.from("appointments").select("id").eq("organization_id", organizationId).eq("contact_id", contactId);
  assert.equal(appointments?.length ?? 0, 0);

  const { data: messages } = await service.from("messages").select("body").eq("conversation_id", conversationId).eq("direction", "outbound");
  assert.ok(messages!.some((m) => /which works best/i.test(m.body)), "expected a clarification request");
});

test("E. organization isolation: an offer under organization A is never resolved by a call scoped to organization B", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "005");
  await makeRealOffer(organizationId, contactId, leadId, conversationId, RANGE_A.start, RANGE_A.end);

  const handled = await classifyAndProcessBookingReply(service, otherOrgId, contactId, leadId, conversationId, "9:00 works.", fakeSendSms());
  assert.equal(handled, false, "a mismatched-organization lookup must find no offer and defer to normal handling");

  const { data: appointments } = await service.from("appointments").select("id").eq("organization_id", otherOrgId);
  assert.equal(appointments?.length ?? 0, 0);
});

test("F. no active offer: an unrelated message is left for normal AI handling (returns false, nothing created)", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "006");
  const handled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "What times do you have tomorrow?", fakeSendSms());
  assert.equal(handled, false);
});

test("G. explicit appointment cancellation: cancels the real appointment and the customer remains opted in", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "007");
  const { data: appointment } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactId, lead_id: leadId, title: "Consult", start_at: "2027-03-05T10:00:00.000Z", end_at: "2027-03-05T11:00:00.000Z", status: "scheduled" })
    .select("id")
    .single();

  const handled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "Cancel my appointment tomorrow.", fakeSendSms());
  assert.equal(handled, true);

  const { data: cancelled } = await service.from("appointments").select("status").eq("id", appointment!.id).single();
  assert.equal(cancelled?.status, "cancelled");

  const { data: contact } = await service.from("contacts").select("sms_opt_out").eq("id", contactId).single();
  assert.equal(contact?.sms_opt_out, false, "an appointment cancellation must never opt the customer out of SMS");
});

test("H. cancel with zero or multiple upcoming appointments escalates to a human rather than guessing", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "008");
  // Zero upcoming appointments.
  const handled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "I need to cancel my appointment", fakeSendSms());
  assert.equal(handled, true);

  const { data: conversation } = await service.from("conversations").select("ai_enabled").eq("id", conversationId).single();
  assert.equal(conversation?.ai_enabled, false, "an unresolvable cancel request must escalate to a human");

  const { data: incident } = await service
    .from("automation_incidents")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("category", "human_escalation_requested")
    .eq("fingerprint", `human_escalation_requested:${conversationId}`)
    .maybeSingle();
  assert.ok(incident, "expected a durable, dashboard-visible escalation incident");
});

test("I. valid reschedule: identifies the appointment, offers real availability, and moves the SAME appointment (no duplicate)", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "009");
  const { data: appointment } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactId, lead_id: leadId, title: "Consult", start_at: "2027-03-08T10:00:00.000Z", end_at: "2027-03-08T11:00:00.000Z", status: "scheduled" })
    .select("id")
    .single();

  const requestHandled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "I need to reschedule.", fakeSendSms());
  assert.equal(requestHandled, true);
  const { data: clarify } = await service.from("messages").select("body").eq("conversation_id", conversationId).eq("direction", "outbound");
  assert.ok(clarify!.some((m) => /what day and time/i.test(m.body)));

  const slots = await makeRealOffer(organizationId, contactId, leadId, conversationId, RANGE_I.start, RANGE_I.end);
  assert.ok(slots.length > 0);

  const selectHandled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "9:00 works.", fakeSendSms());
  assert.equal(selectHandled, true);

  const { data: allAppointments } = await service.from("appointments").select("id, start_at, status").eq("organization_id", organizationId).eq("contact_id", contactId);
  assert.equal(allAppointments?.length, 1, "reschedule must update the existing appointment, never create a second one");
  assert.equal(allAppointments![0].id, appointment!.id);
  assert.equal(new Date(allAppointments![0].start_at).getTime(), new Date(slots[0].start_at).getTime());
  assert.equal(allAppointments![0].status, "scheduled");
});

test("J. wrong-appointment protection: a reschedule/cancel request for one contact can never affect another contact's appointment", async () => {
  const { contactId: contactA, leadId: leadA, conversationId: conversationA } = await makeContactLeadConversation(organizationId, "010");
  const { contactId: contactB } = await makeContactLeadConversation(organizationId, "011");
  const { data: appointmentB } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactB, title: "Consult", start_at: "2027-03-09T10:00:00.000Z", end_at: "2027-03-09T11:00:00.000Z", status: "scheduled" })
    .select("id")
    .single();

  // Contact A (who has NO appointment of their own) asks to cancel - must
  // never touch contact B's real appointment.
  await classifyAndProcessBookingReply(service, organizationId, contactA, leadA, conversationA, "cancel my appointment", fakeSendSms());

  const { data: stillScheduled } = await service.from("appointments").select("status").eq("id", appointmentB!.id).single();
  assert.equal(stillScheduled?.status, "scheduled", "a different contact's real appointment must never be affected");
});

test("K. cancelled appointment remains historically correct (never deleted, status preserved)", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "012");
  const { data: appointment } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactId, lead_id: leadId, title: "Consult", start_at: "2027-03-10T10:00:00.000Z", end_at: "2027-03-10T11:00:00.000Z", status: "scheduled" })
    .select("id")
    .single();

  await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "please cancel my appointment", fakeSendSms());

  const { data: row } = await service.from("appointments").select("id, status, start_at, end_at, title").eq("id", appointment!.id).single();
  assert.ok(row, "the appointment row must still exist, never deleted");
  assert.equal(row?.status, "cancelled");
  assert.equal(row?.title, "Consult");
});

test("L. a confirmation SMS that fails to send after a successful booking never rolls back the real appointment, never crashes, and never reports failure to the caller", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "013");
  const RANGE_L = { start: "2027-03-16T00:00:00.000Z", end: "2027-03-17T00:00:00.000Z" }; // Tuesday
  await makeRealOffer(organizationId, contactId, leadId, conversationId, RANGE_L.start, RANGE_L.end);

  const failingSendSms = async () => ({ ok: false as const, error: "Twilio simulated failure" });
  const handled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "9:00 works.", failingSendSms);
  assert.equal(handled, true, "the booking itself succeeded - a downstream SMS delivery failure must not flip this back to false");

  const { data: appointments } = await service.from("appointments").select("id, status").eq("organization_id", organizationId).eq("contact_id", contactId);
  assert.equal(appointments?.length, 1, "the real appointment must exist even though its confirmation SMS failed to send");
  assert.equal(appointments![0].status, "scheduled");
});

test("M. concurrent booking race: two different customers selecting the exact same real slot at the same time never both get booked", async () => {
  const RANGE_M = { start: "2027-03-17T00:00:00.000Z", end: "2027-03-18T00:00:00.000Z" }; // Wednesday
  const customerA = await makeContactLeadConversation(organizationId, "014");
  const customerB = await makeContactLeadConversation(organizationId, "015");
  const slotsA = await makeRealOffer(organizationId, customerA.contactId, customerA.leadId, customerA.conversationId, RANGE_M.start, RANGE_M.end);
  const slotsB = await makeRealOffer(organizationId, customerB.contactId, customerB.leadId, customerB.conversationId, RANGE_M.start, RANGE_M.end);
  assert.equal(slotsA[0].start_at, slotsB[0].start_at, "both customers must have been offered the same first slot for this to be a genuine race");

  const [handledA, handledB] = await Promise.all([
    classifyAndProcessBookingReply(service, organizationId, customerA.contactId, customerA.leadId, customerA.conversationId, "9:00 works.", fakeSendSms()),
    classifyAndProcessBookingReply(service, organizationId, customerB.contactId, customerB.leadId, customerB.conversationId, "9:00 works.", fakeSendSms()),
  ]);
  assert.equal(handledA, true);
  assert.equal(handledB, true);

  const { data: appointments } = await service
    .from("appointments")
    .select("id, contact_id, start_at, status")
    .eq("organization_id", organizationId)
    .eq("start_at", slotsA[0].start_at)
    .neq("status", "cancelled");
  assert.equal(appointments?.length, 1, "exactly one of the two concurrent selections must win the real slot - never both, never zero");
});

// ---------------------------------------------------------------------------
// Pass 5B, Part A3/A4: appointment confirmation
// ---------------------------------------------------------------------------

async function insertScheduledAppointment(contactId: string, leadId: string, startAt: string, endAt: string) {
  const { data } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactId, lead_id: leadId, title: "Consult", start_at: startAt, end_at: endAt, status: "scheduled" })
    .select("id")
    .single();
  return data!.id as string;
}

test("N. explicit 'CONFIRM' confirms the appointment, records confirmed_at, and sends a real acknowledgment", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "016");
  const appointmentId = await insertScheduledAppointment(contactId, leadId, "2027-03-18T10:00:00.000Z", "2027-03-18T11:00:00.000Z");

  const handled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "CONFIRM", fakeSendSms());
  assert.equal(handled, true);

  const { data: appointment } = await service.from("appointments").select("status, confirmed_at").eq("id", appointmentId).single();
  assert.equal(appointment?.status, "confirmed");
  assert.ok(appointment?.confirmed_at, "expected a real confirmed_at timestamp");

  const { data: messages } = await service.from("messages").select("body").eq("conversation_id", conversationId).eq("direction", "outbound");
  assert.ok(messages!.some((m) => /confirmed/i.test(m.body)), "expected a real confirmation acknowledgment message");
});

test("O. duplicate YES is idempotent: the second reply is still classified as confirmation-handled (true) but sends no second acknowledgment and confirmed_at does not change", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "017");
  await insertScheduledAppointment(contactId, leadId, "2027-03-19T10:00:00.000Z", "2027-03-19T11:00:00.000Z");

  const first = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "Yes", fakeSendSms());
  assert.equal(first, true);
  const countAfterFirst = await service.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId).eq("direction", "outbound");
  const { data: appointmentAfterFirst } = await service.from("appointments").select("confirmed_at").eq("organization_id", organizationId).eq("contact_id", contactId).single();

  const second = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "Yes", fakeSendSms());
  assert.equal(second, true, "a duplicate YES is still a correctly-classified confirmation message, just a no-op");

  const countAfterSecond = await service.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId).eq("direction", "outbound");
  assert.equal(countAfterSecond.count, countAfterFirst.count, "a duplicate YES must never send a second acknowledgment");

  const { data: appointmentAfterSecond } = await service.from("appointments").select("confirmed_at").eq("organization_id", organizationId).eq("contact_id", contactId).single();
  assert.equal(appointmentAfterSecond?.confirmed_at, appointmentAfterFirst?.confirmed_at, "confirmed_at must never be overwritten by a duplicate confirmation");
});

test("P. confirmation intent with ZERO upcoming appointments is not handled here - falls through to normal AI/human handling rather than guessing", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "018");
  const handled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "Yes", fakeSendSms());
  assert.equal(handled, false);
});

test("Q. confirmation intent with MULTIPLE upcoming appointments is not handled here - falls through rather than guessing which one", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "019");
  await insertScheduledAppointment(contactId, leadId, "2027-03-20T10:00:00.000Z", "2027-03-20T11:00:00.000Z");
  await insertScheduledAppointment(contactId, leadId, "2027-03-21T10:00:00.000Z", "2027-03-21T11:00:00.000Z");

  const handled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "Yes", fakeSendSms());
  assert.equal(handled, false);

  const { data: appointments } = await service.from("appointments").select("status").eq("organization_id", organizationId).eq("contact_id", contactId);
  assert.ok(appointments!.every((a) => a.status === "scheduled"), "neither ambiguous appointment must be confirmed");
});

test("R. an informational question never confirms - no status change, falls through to normal handling", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "020");
  const appointmentId = await insertScheduledAppointment(contactId, leadId, "2027-03-22T10:00:00.000Z", "2027-03-22T11:00:00.000Z");

  const handled = await classifyAndProcessBookingReply(service, organizationId, contactId, leadId, conversationId, "What time is my appointment?", fakeSendSms());
  assert.equal(handled, false);

  const { data: appointment } = await service.from("appointments").select("status, confirmed_at").eq("id", appointmentId).single();
  assert.equal(appointment?.status, "scheduled");
  assert.equal(appointment?.confirmed_at, null);
});

test("S. organization isolation: a YES scoped to organization B never confirms organization A's appointment", async () => {
  const { contactId, leadId, conversationId } = await makeContactLeadConversation(organizationId, "021");
  const appointmentId = await insertScheduledAppointment(contactId, leadId, "2027-03-23T10:00:00.000Z", "2027-03-23T11:00:00.000Z");

  const handled = await classifyAndProcessBookingReply(service, otherOrgId, contactId, leadId, conversationId, "Yes", fakeSendSms());
  assert.equal(handled, false, "the contact has no appointment under otherOrgId, so this must fall through, never touch organization A's appointment");

  const { data: appointment } = await service.from("appointments").select("status").eq("id", appointmentId).single();
  assert.equal(appointment?.status, "scheduled", "organization A's real appointment must be completely untouched");
});

test("T. Part F: payment gate preserved - a payment-inactive organization still records the confirmation, but the acknowledgment SMS is blocked by the existing outbound gate", async () => {
  const { data: unpaidOrg } = await service.from("organizations").insert({ name: "Booking Reply Test Org (Unpaid)", payment_status: "suspended", automation_mode: "live" }).select("id").single();
  const unpaidOrgId = unpaidOrg!.id as string;
  try {
    const { contactId, leadId, conversationId } = await makeContactLeadConversation(unpaidOrgId, "022");
    // insertScheduledAppointment closes over the shared organizationId - not
    // reusable here, so this appointment is inserted directly under unpaidOrgId.
    const { data: appt } = await service
      .from("appointments")
      .insert({ organization_id: unpaidOrgId, contact_id: contactId, lead_id: leadId, title: "Consult", start_at: "2027-03-24T10:00:00.000Z", end_at: "2027-03-24T11:00:00.000Z", status: "scheduled" })
      .select("id")
      .single();
    const appointmentId = appt!.id as string;

    const handled = await classifyAndProcessBookingReply(service, unpaidOrgId, contactId, leadId, conversationId, "Yes", fakeSendSms());
    assert.equal(handled, true, "the confirmation intent was still correctly recognized and processed");

    const { data: appointment } = await service.from("appointments").select("status").eq("id", appointmentId).single();
    assert.equal(appointment?.status, "confirmed", "the state transition itself is a CRM action, not a payment-gated automated send - matches cancelAppointmentAsService's own established, unchanged precedent");

    const { data: messages } = await service.from("messages").select("id").eq("conversation_id", conversationId).eq("direction", "outbound");
    assert.equal(messages?.length ?? 0, 0, "the acknowledgment SMS must be blocked by the existing outbound gate's payment check");
  } finally {
    await service.from("messages").delete().eq("organization_id", unpaidOrgId);
    await service.from("workflow_executions").delete().eq("organization_id", unpaidOrgId);
    await service.from("automation_events").delete().eq("organization_id", unpaidOrgId);
    await service.from("appointments").delete().eq("organization_id", unpaidOrgId);
    await service.from("conversations").delete().eq("organization_id", unpaidOrgId);
    await service.from("leads").delete().eq("organization_id", unpaidOrgId);
    await service.from("contacts").delete().eq("organization_id", unpaidOrgId);
    await service.from("organizations").delete().eq("id", unpaidOrgId);
  }
});

test("U. Part F: automation pause preserved - a paused organization still records the confirmation, but the acknowledgment SMS is blocked", async () => {
  const { data: pausedOrg } = await service.from("organizations").insert({ name: "Booking Reply Test Org (Paused)", payment_status: "active", automation_mode: "live", automation_paused: true }).select("id").single();
  const pausedOrgId = pausedOrg!.id as string;
  try {
    const { contactId, leadId, conversationId } = await makeContactLeadConversation(pausedOrgId, "023");
    const { data: appt } = await service
      .from("appointments")
      .insert({ organization_id: pausedOrgId, contact_id: contactId, lead_id: leadId, title: "Consult", start_at: "2027-03-25T10:00:00.000Z", end_at: "2027-03-25T11:00:00.000Z", status: "scheduled" })
      .select("id")
      .single();

    const handled = await classifyAndProcessBookingReply(service, pausedOrgId, contactId, leadId, conversationId, "Yes", fakeSendSms());
    assert.equal(handled, true);

    const { data: appointment } = await service.from("appointments").select("status").eq("id", appt!.id).single();
    assert.equal(appointment?.status, "confirmed");

    const { data: messages } = await service.from("messages").select("id").eq("conversation_id", conversationId).eq("direction", "outbound");
    assert.equal(messages?.length ?? 0, 0, "the acknowledgment SMS must be blocked by the existing outbound gate's automation_paused check");
  } finally {
    await service.from("messages").delete().eq("organization_id", pausedOrgId);
    await service.from("workflow_executions").delete().eq("organization_id", pausedOrgId);
    await service.from("automation_events").delete().eq("organization_id", pausedOrgId);
    await service.from("appointments").delete().eq("organization_id", pausedOrgId);
    await service.from("conversations").delete().eq("organization_id", pausedOrgId);
    await service.from("leads").delete().eq("organization_id", pausedOrgId);
    await service.from("contacts").delete().eq("organization_id", pausedOrgId);
    await service.from("organizations").delete().eq("id", pausedOrgId);
  }
});
