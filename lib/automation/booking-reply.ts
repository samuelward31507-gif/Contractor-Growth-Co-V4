import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import { startWorkflowExecutionAsService, completeWorkflowExecutionAsService, failWorkflowExecutionAsService } from "./executions";
import { evaluateOutboundGate } from "./outbound-gate";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { recordAutomationHealthSignal } from "../automation-health/service";
import { notifyFounder } from "@/lib/notifications/founder";
import { getAvailableBookingSlots, bookAppointment, rescheduleAppointment, type BookingSlot } from "@/lib/scheduling/booking";
import { cancelAppointmentAsService } from "./appointments";
import { getRecentBookingContext, openRescheduleContext, recordFreshAvailabilityOffer } from "./booking-context";
import { composeAvailabilityOfferMessage, resolveBookingFallbackTitle, BOOKING_FALLBACK_MESSAGE, serializeSlots } from "@/app/api/automation/n8n-callback/route";
import { formatAppointmentDate, formatAppointmentTimeRange } from "@/lib/appointments/format";
import type { SendSmsInput, SendSmsResult } from "./sms";

/**
 * Pass 1 (booking loop completion + AI receptionist contract hardening).
 *
 * The deterministic, Trackpr-side closing half of the booking loop this
 * codebase already opened (check_availability offering real slots by SMS).
 * Runs from the inbound SMS webhook BEFORE emitCustomerReplyFollowup - the
 * exact same placement and "intercept before AI dispatch" shape already
 * established by classifyAndEscalateReviewReply and
 * classifyAndProcessEstimateReply. A caller that gets `true` back must NOT
 * also call emitCustomerReplyFollowup for the same message - this module
 * fully owns the reply.
 *
 * Deliberately does NOT require an n8n/AI contract change: the AI already
 * offers real slots via the existing check_availability branch (unchanged),
 * and this module's own deterministic parsing resolves the customer's
 * NEXT reply against exactly those slots - "prefer existing conversation/
 * workflow metadata" per this pass's own instructions, not a new database
 * column and not a new n8n prompt.
 */

export type SendSmsFn = (input: SendSmsInput) => Promise<SendSmsResult>;

// ---------------------------------------------------------------------------
// Intent classification - deterministic, conservative. Never matches on the
// bare word "cancel" alone (every pattern below requires additional words),
// so a message that would already exact-match the SMS STOP keyword set
// (lib/messaging/keywords.ts) never reaches this file at all - the inbound
// webhook checks STOP/HELP/START first, before any classifier. This is the
// deliberate, load-bearing distinction between "cancel my appointment
// tomorrow" (handled here, was never a STOP match to begin with) and a bare
// "Cancel" (an existing, unchanged, carrier-mandated opt-out - preserved
// exactly, not touched by this pass).
// ---------------------------------------------------------------------------

const RESCHEDULE_PATTERNS: RegExp[] = [
  /\breschedule\b/i,
  /\bmove (my|the) appointment\b/i,
  /\bmove me to\b/i,
  /\bcan (we|you) do .+ instead\b/i,
  /\bcan (we|you) move\b/i,
  /\bchange my appointment\b/i,
  /\ba different (day|time)\b/i,
  /\bpick a different (day|time)\b/i,
];

const CANCEL_PATTERNS: RegExp[] = [
  /\bcancel my appointment\b/i,
  /\bcancel the appointment\b/i,
  /\bcancel my \d{1,2}(:\d{2})?\s*(am|pm)?\b/i,
  /\bneed to cancel\b/i,
  /\bplease cancel\b/i,
  /\bcan'?t make (it|my appointment)\b/i,
  /\bwon'?t be able to make (it|my appointment)\b/i,
  /\bunable to make (it|my appointment)\b/i,
];

export type BookingReplyIntent = "reschedule" | "cancel" | null;

export function classifyBookingReplyIntent(body: string): BookingReplyIntent {
  const text = body.trim();
  if (!text) return null;
  // Cancel checked first: "I need to cancel my appointment and reschedule
  // for later" should resolve to cancel, the more concrete, actionable
  // request - not left ambiguous between two matching patterns.
  if (CANCEL_PATTERNS.some((pattern) => pattern.test(text))) return "cancel";
  if (RESCHEDULE_PATTERNS.some((pattern) => pattern.test(text))) return "reschedule";
  return null;
}

// ---------------------------------------------------------------------------
// Slot-selection resolution - matches a customer's freeform reply against
// the EXACT slots Trackpr most recently offered. Deliberately conservative:
// a candidate that could plausibly match more than one offered slot resolves
// to "ambiguous", never a guess.
// ---------------------------------------------------------------------------

export type SlotSelectionResult =
  | { outcome: "matched"; slot: BookingSlot }
  | { outcome: "ambiguous" }
  | { outcome: "no_match" };

const ORDINAL_WORDS: Record<string, number> = {
  first: 0, "1st": 0,
  second: 1, "2nd": 1,
  third: 2, "3rd": 2,
  fourth: 3, "4th": 3,
  fifth: 4, "5th": 4,
};

const AFFIRMATIVE_PATTERN = /^\s*(yes|yep|yeah|yup|sure|ok|okay|perfect|great|sounds good|that works|works( for me)?|let'?s do that|i'?ll take that)[.!\s]*$/i;

function extractTimeCandidates(text: string): { hour: number; minute: number; meridiem: "am" | "pm" | null }[] {
  const candidates: { hour: number; minute: number; meridiem: "am" | "pm" | null }[] = [];
  const pattern = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const hour = Number(match[1]);
    if (hour < 1 || hour > 12) continue;
    const minute = match[2] ? Number(match[2]) : 0;
    if (minute > 59) continue;
    const meridiemRaw = match[3]?.toLowerCase().replace(/\./g, "");
    const meridiem: "am" | "pm" | null = meridiemRaw === "am" ? "am" : meridiemRaw === "pm" ? "pm" : null;
    candidates.push({ hour, minute, meridiem });
  }
  return candidates;
}

function localHourMinute(iso: string, timeZone: string): { hour24: number; minute: number } {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(date);
  const hour24 = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour24, minute };
}

export function resolveSlotSelection(messageBody: string, offeredSlots: BookingSlot[], timezone: string): SlotSelectionResult {
  const text = messageBody.trim();
  if (!text || offeredSlots.length === 0) return { outcome: "no_match" };
  const lower = text.toLowerCase();

  for (const [word, index] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(lower) && index < offeredSlots.length) {
      return { outcome: "matched", slot: offeredSlots[index] };
    }
  }
  if (/\blast\b/i.test(lower) && offeredSlots.length > 0) {
    return { outcome: "matched", slot: offeredSlots[offeredSlots.length - 1] };
  }

  const candidates = extractTimeCandidates(text);
  if (candidates.length > 0) {
    const matchedIndexes = new Set<number>();
    for (const candidate of candidates) {
      offeredSlots.forEach((slot, index) => {
        const { hour24, minute } = localHourMinute(slot.start_at, timezone);
        const hour12 = hour24 % 12 || 12;
        const impliedMeridiem: "am" | "pm" = hour24 >= 12 ? "pm" : "am";
        if (candidate.minute === minute && candidate.hour === hour12 && (candidate.meridiem === null || candidate.meridiem === impliedMeridiem)) {
          matchedIndexes.add(index);
        }
      });
    }
    if (matchedIndexes.size === 1) {
      return { outcome: "matched", slot: offeredSlots[[...matchedIndexes][0]] };
    }
    if (matchedIndexes.size > 1) {
      return { outcome: "ambiguous" };
    }
    // A number was present but matched nothing real - very likely unrelated
    // to the offer (e.g. a street address), never a booking reference.
    return { outcome: "no_match" };
  }

  if (AFFIRMATIVE_PATTERN.test(text)) {
    if (offeredSlots.length === 1) return { outcome: "matched", slot: offeredSlots[0] };
    return { outcome: "ambiguous" };
  }

  return { outcome: "no_match" };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function getOrganizationTimezone(supabase: SupabaseClient, organizationId: string): Promise<string> {
  const { data } = await supabase.from("organizations").select("timezone").eq("id", organizationId).maybeSingle();
  return data?.timezone ?? "UTC";
}

/** Never more than one - if a contact somehow has multiple upcoming appointments, that's exactly the "cannot confidently identify" case this pass requires escalating, not guessing. */
async function findUpcomingAppointments(supabase: SupabaseClient, organizationId: string, contactId: string): Promise<{ id: string; start_at: string; end_at: string; title: string }[]> {
  const { data } = await supabase
    .from("appointments")
    .select("id, start_at, end_at, title")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", ["scheduled", "confirmed"])
    .gt("start_at", new Date().toISOString())
    .order("start_at", { ascending: true });
  return data ?? [];
}

async function escalateToHuman(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  leadId: string | null,
  conversationId: string,
  reason: string,
): Promise<void> {
  const { data: lockedRow, error: lockError } = await supabase
    .from("conversations")
    .update({ ai_enabled: false })
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .eq("ai_enabled", true)
    .select("id")
    .maybeSingle();

  if (lockError) {
    console.error("[automation] failed to lock conversation after a booking-reply escalation", { organizationId, conversationId, error: lockError.message });
    return;
  }
  if (!lockedRow) return;

  await recordAutomationHealthSignal(supabase, {
    organizationId,
    category: "human_escalation_requested",
    severity: "warning",
    fingerprintContext: conversationId,
    title: "AI escalated a conversation to a human",
    description: reason,
    metadata: { conversationId, contactId, leadId },
  });
  await notifyFounder(supabase, {
    organizationId,
    kind: "ai_escalation",
    summary: reason,
    detailPath: `/conversations/${conversationId}`,
  });
}

/** A brief, safe, no-internal-detail message for the "can't confidently identify which appointment" case - the customer still gets an immediate, honest reply while a human is notified. */
async function sendDeterministicMessage(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  leadId: string | null,
  conversationId: string,
  body: string,
  eventType: string,
  workflowName: string,
  sendSmsFn?: SendSmsFn,
): Promise<boolean> {
  const eventResult = await createAutomationEventAsService(supabase, organizationId, {
    eventType,
    entityType: "conversation",
    entityId: conversationId,
    payload: { conversation_id: conversationId, contact_id: contactId },
    idempotencyKey: `${eventType}:${conversationId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
  });
  if (!eventResult.ok || eventResult.duplicate || eventResult.skipped) return false;

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, workflowName);
  if (!executionResult.ok) return false;
  const executionId = executionResult.execution.id;

  const gateResult = await evaluateOutboundGate(supabase, {
    organizationId,
    executionId,
    contactId,
    conversationId,
    leadId,
    aiResult: { should_send: true, response_message: body, needs_human: false },
  });

  let sent = false;
  if (gateResult.allowed) {
    const sendResult = await sendOutboundMessage(supabase, {
      organizationId,
      contactId: gateResult.contactId,
      conversationId: gateResult.conversationId,
      channel: "sms",
      body: gateResult.body,
      senderType: "system",
      workflowExecutionId: executionId,
      sendSmsFn,
    });
    sent = sendResult.ok;
    if (!sendResult.ok) {
      await failWorkflowExecutionAsService(supabase, executionId, sendResult.error, "sms_send_failed");
      return sent;
    }
  }
  await completeWorkflowExecutionAsService(supabase, executionId, { should_send: sent, blocked_reason: gateResult.allowed ? null : gateResult.reason });
  return sent;
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

async function handleCancelIntent(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  leadId: string | null,
  conversationId: string,
  sendSmsFn?: SendSmsFn,
): Promise<boolean> {
  const upcoming = await findUpcomingAppointments(supabase, organizationId, contactId);

  if (upcoming.length !== 1) {
    await escalateToHuman(
      supabase,
      organizationId,
      contactId,
      leadId,
      conversationId,
      upcoming.length === 0
        ? "A customer asked to cancel their appointment, but no upcoming appointment could be found for them."
        : "A customer asked to cancel their appointment, but they have more than one upcoming appointment and it wasn't safe to guess which one.",
    );
    return true;
  }

  const result = await cancelAppointmentAsService(supabase, organizationId, contactId, upcoming[0].id, sendSmsFn);
  if (!result.ok) {
    await escalateToHuman(supabase, organizationId, contactId, leadId, conversationId, "A customer asked to cancel their appointment, but it could not be cancelled automatically.");
  }
  // cancelAppointmentAsService's own emitAppointmentLifecycleEventAsService
  // call already sends the existing, deterministic cancellation SMS - no
  // separate confirmation is composed here.
  return true;
}

// ---------------------------------------------------------------------------
// Reschedule
// ---------------------------------------------------------------------------

async function handleRescheduleIntent(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  leadId: string | null,
  conversationId: string,
  sendSmsFn?: SendSmsFn,
): Promise<boolean> {
  const upcoming = await findUpcomingAppointments(supabase, organizationId, contactId);

  if (upcoming.length !== 1) {
    await escalateToHuman(
      supabase,
      organizationId,
      contactId,
      leadId,
      conversationId,
      upcoming.length === 0
        ? "A customer asked to reschedule, but no upcoming appointment could be found for them."
        : "A customer asked to reschedule, but they have more than one upcoming appointment and it wasn't safe to guess which one.",
    );
    return true;
  }

  const { opened } = await openRescheduleContext(supabase, organizationId, conversationId, upcoming[0].id, upcoming[0].start_at);
  if (!opened) {
    // Already an open reschedule request for this exact appointment/time -
    // a duplicate "I need to reschedule" sent again before anything else
    // happened. A safe no-op, matching this codebase's established
    // idempotency convention (see openRescheduleContext's own comment).
    return true;
  }

  await sendDeterministicMessage(
    supabase,
    organizationId,
    contactId,
    leadId,
    conversationId,
    "No problem - what day and time works better for you?",
    "appointment.reschedule_clarification_sent",
    "appointment_reschedule_clarification",
    sendSmsFn,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Slot selection -> book or reschedule
// ---------------------------------------------------------------------------

function composeBookedConfirmation(startAt: string, endAt: string, timezone: string): string {
  return `You're booked! Your appointment is confirmed for ${formatAppointmentDate(startAt, timezone)} at ${formatAppointmentTimeRange(startAt, endAt, timezone)}. Reply STOP to opt out of texts.`;
}

async function sendClarification(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  leadId: string | null,
  conversationId: string,
  slots: BookingSlot[],
  title: string,
  timezone: string,
  sendSmsFn?: SendSmsFn,
): Promise<void> {
  const lines = slots.map((slot) => `${formatAppointmentDate(slot.start_at, timezone)} at ${formatAppointmentTimeRange(slot.start_at, slot.end_at, timezone).split(" - ")[0]}`);
  const body = title
    ? `Absolutely - which works best for your ${title}: ${lines.join(", ")}?`
    : `Absolutely - which works best: ${lines.join(", ")}?`;
  await sendDeterministicMessage(supabase, organizationId, contactId, leadId, conversationId, body, "appointment.slot_clarification_sent", "appointment_slot_clarification", sendSmsFn);
}

async function handleStaleSlot(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  leadId: string | null,
  conversationId: string,
  title: string,
  timezone: string,
  rescheduleAppointmentId: string | null,
  sendSmsFn?: SendSmsFn,
): Promise<void> {
  const now = new Date();
  const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const availability = await getAvailableBookingSlots(supabase, organizationId, now, weekOut);

  const body =
    availability.status === "available" && availability.slots.length > 0
      ? `Sorry, that time was just taken. ${composeAvailabilityOfferMessage(availability.slots, title || "appointment", timezone)}`
      : BOOKING_FALLBACK_MESSAGE;

  await sendDeterministicMessage(supabase, organizationId, contactId, leadId, conversationId, body, "appointment.stale_slot_reoffered", "appointment_stale_slot_reoffer", sendSmsFn);

  if (availability.status === "available" && availability.slots.length > 0) {
    await recordFreshAvailabilityOffer(supabase, organizationId, conversationId, serializeSlots(availability.slots), title, rescheduleAppointmentId);
  } else {
    await escalateToHuman(supabase, organizationId, contactId, leadId, conversationId, "A customer's selected appointment slot was no longer available and no alternative slots could be computed.");
  }
}

async function finalizeSlotSelection(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  leadId: string | null,
  conversationId: string,
  slot: BookingSlot,
  title: string,
  timezone: string,
  rescheduleAppointmentId: string | null,
  sendSmsFn?: SendSmsFn,
): Promise<void> {
  if (rescheduleAppointmentId) {
    const result = await rescheduleAppointment(
      supabase,
      {
        organizationId,
        contactId,
        appointmentId: rescheduleAppointmentId,
        startAt: slot.start_at,
        endAt: slot.end_at,
        idempotencyKey: `reschedule:${conversationId}:${slot.start_at}`,
      },
      undefined,
      sendSmsFn,
    );
    if (result.success) return; // rescheduleAppointment's own lifecycle dispatch already sent the confirmation.
    if (result.reason === "slot_unavailable") {
      await handleStaleSlot(supabase, organizationId, contactId, leadId, conversationId, title, timezone, rescheduleAppointmentId, sendSmsFn);
      return;
    }
    await escalateToHuman(supabase, organizationId, contactId, leadId, conversationId, "A customer's appointment reschedule could not complete safely and needs a human.");
    return;
  }

  const result = await bookAppointment(supabase, {
    organizationId,
    contactId,
    leadId,
    startAt: slot.start_at,
    endAt: slot.end_at,
    title: title || (await resolveBookingFallbackTitle(supabase, organizationId)),
    idempotencyKey: `booking:${conversationId}:${slot.start_at}`,
  });

  if (result.success) {
    await sendDeterministicMessage(
      supabase,
      organizationId,
      contactId,
      leadId,
      conversationId,
      composeBookedConfirmation(result.startAt, result.endAt, result.timezone),
      "appointment.booked_confirmation_sent",
      "appointment_booked_confirmation",
      sendSmsFn,
    );
    await notifyFounder(supabase, {
      organizationId,
      kind: "appointment_booked",
      summary: `AI-booked appointment on ${formatAppointmentDate(result.startAt, result.timezone)}.`,
      detailPath: `/appointments/${result.appointmentId}`,
    });
    return;
  }

  if (result.reason === "slot_unavailable") {
    await handleStaleSlot(supabase, organizationId, contactId, leadId, conversationId, title, timezone, null, sendSmsFn);
    return;
  }

  await escalateToHuman(supabase, organizationId, contactId, leadId, conversationId, "A customer's appointment booking could not complete safely and needs a human.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Returns true when this call fully handled the customer's reply (the
 * caller must NOT also dispatch to the AI for the same message). Returns
 * false for any message this module has no opinion about, letting normal
 * AI qualification/booking continue exactly as before.
 */
export async function classifyAndProcessBookingReply(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  leadId: string | null,
  conversationId: string,
  messageBody: string,
  sendSmsFn?: SendSmsFn,
): Promise<boolean> {
  const intent = classifyBookingReplyIntent(messageBody);
  if (intent === "cancel") {
    return handleCancelIntent(supabase, organizationId, contactId, leadId, conversationId, sendSmsFn);
  }
  if (intent === "reschedule") {
    return handleRescheduleIntent(supabase, organizationId, contactId, leadId, conversationId, sendSmsFn);
  }

  const context = await getRecentBookingContext(supabase, organizationId, conversationId);
  if (!context || context.type !== "offer") return false;

  const timezone = await getOrganizationTimezone(supabase, organizationId);
  const resolution = resolveSlotSelection(messageBody, context.slots, timezone);

  if (resolution.outcome === "no_match") return false;

  if (resolution.outcome === "ambiguous") {
    await sendClarification(supabase, organizationId, contactId, leadId, conversationId, context.slots, context.title, timezone, sendSmsFn);
    return true;
  }

  await finalizeSlotSelection(supabase, organizationId, contactId, leadId, conversationId, resolution.slot, context.title, timezone, context.rescheduleAppointmentId, sendSmsFn);
  return true;
}
