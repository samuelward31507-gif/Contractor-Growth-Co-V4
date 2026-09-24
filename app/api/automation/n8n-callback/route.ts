import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { completeWorkflowExecutionAsService, failWorkflowExecutionAsService } from "@/lib/automation/executions";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { evaluateOutboundGate } from "@/lib/automation/outbound-gate";
import { getAutomationForEventType } from "@/lib/automation/catalog";
import {
  getAutomationConfig,
  getAutomationEnabled,
  readInstantLeadFollowupConfig,
  readInboundCustomerReplyConfig,
  readAppointmentLifecycleConfig,
  readJobLifecycleConfig,
  readReviewReferralFollowupConfig,
} from "@/lib/automation/settings";
import { recordPostJobFollowupOutcome } from "@/lib/reviews-referrals/tracking";
import { recordAutomationHealthSignal } from "@/lib/automation-health/service";
import { notifyFounder } from "@/lib/notifications/founder";
import { getAvailableBookingSlots, bookAppointment, type BookingSlot } from "@/lib/scheduling/booking";
import { formatAppointmentDate, formatAppointmentTimeRange } from "@/lib/appointments/format";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";
import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 1600;
const MAX_SHORT_FIELD_LENGTH = 200;
const MAX_MISSING_INFO_ITEMS = 10;

const QUALIFICATION_STATUSES = new Set(["new", "qualifying", "qualified", "needs_human"]);
const URGENCY_LEVELS = new Set(["low", "normal", "high", "emergency"]);
const BOOKING_ACTIONS = new Set(["none", "check_availability", "book"]);

type QualificationStatus = "new" | "qualifying" | "qualified" | "needs_human";
type Urgency = "low" | "normal" | "high" | "emergency";
type BookingAction = "none" | "check_availability" | "book";

/**
 * Growth System Completion Pass 1 (Part 3): the minimal extension to the
 * AI/n8n contract for appointment booking. The AI (via n8n) only ever
 * expresses INTENT here - it never computes availability itself and never
 * touches the Trackpr booking interface directly; this route is the only
 * caller of lib/scheduling/booking.ts (Stage 6, completely unchanged). When
 * action is "check_availability", date_range_start/date_range_end drive a
 * real getAvailableBookingSlots() call, and the real slots are returned in
 * this callback's own JSON response (never invented, never Google metadata)
 * for n8n's own next AI step to present. When action is "book", start_at/
 * end_at/title drive a real bookAppointment() call; Trackpr - never the AI -
 * composes the resulting confirmation/decline message, exactly like every
 * other deterministic, fact-only message in this codebase (see
 * lib/automation/appointment-reminders.ts's own established precedent).
 * should_send/response_message are ignored for any turn where action is not
 * "none" - n8n should send should_send:false/response_message:null on a
 * booking-intent turn, since Trackpr owns messaging for it.
 */
export type BookingIntent = {
  action: BookingAction;
  date_range_start: string | null;
  date_range_end: string | null;
  start_at: string | null;
  end_at: string | null;
  title: string | null;
};

/**
 * Growth System Completion Pass 2 (Part 4): the minimal extension to the
 * AI/n8n contract for usage tracking. n8n's own AI call is the only place
 * real provider token counts exist - Trackpr never estimates or invents
 * them. Every field is independently nullable: a provider or n8n workflow
 * that doesn't expose one (or any) of these must send null for it rather
 * than omitting `usage` entirely or guessing - "if provider metadata is
 * unavailable, store null rather than inventing usage," per the task's own
 * instruction.
 */
export type AiUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

type AiResult = {
  should_send: boolean;
  response_message: string | null;
  qualification_status: QualificationStatus;
  missing_information: string[];
  urgency: Urgency;
  needs_human: boolean;
  model: string | null;
  // Optional: present for customer.message.received (Phase 4.2), absent for
  // lead.created - both are valid, existing behavior is unchanged either way.
  intent: string | null;
  summary: string | null;
  /** Optional - absent/null means "no booking intent this turn", identical to the pre-Part-3 contract. */
  booking_intent: BookingIntent | null;
  /** Optional - absent/null means "no usage data this turn" (e.g. n8n's workflow doesn't expose it yet). */
  usage: AiUsage | null;
};

type CallbackBody = {
  execution_id: string;
  event_id: string;
  organization_id: string;
  ai_result: AiResult | null;
};

type ValidationResult = { ok: true; body: CallbackBody } | { ok: false; error: string };

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isOptionalString(value: unknown, maxLength: number): value is string | null {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.length <= maxLength;
}

/**
 * Manual, dependency-free validation of the untrusted n8n callback body.
 * Nothing here is used for authorization - organization_id is only ever
 * cross-checked against the database-derived value below, never trusted on
 * its own - this only guards the shape of what downstream code (AI output
 * handling, ai_interactions, sendSms) is allowed to see.
 */
function validateBody(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const body = raw as Record<string, unknown>;

  if (!isUuid(body.execution_id)) return { ok: false, error: "execution_id must be a UUID." };
  if (!isUuid(body.event_id)) return { ok: false, error: "event_id must be a UUID." };
  if (!isUuid(body.organization_id)) return { ok: false, error: "organization_id must be a UUID." };

  let aiResult: AiResult | null = null;
  if (body.ai_result !== null && body.ai_result !== undefined) {
    if (typeof body.ai_result !== "object") {
      return { ok: false, error: "ai_result must be an object or null." };
    }
    const raw2 = body.ai_result as Record<string, unknown>;

    if (typeof raw2.should_send !== "boolean") {
      return { ok: false, error: "ai_result.should_send must be a boolean." };
    }
    if (typeof raw2.needs_human !== "boolean") {
      return { ok: false, error: "ai_result.needs_human must be a boolean." };
    }
    if (!isOptionalString(raw2.response_message, MAX_MESSAGE_LENGTH)) {
      return { ok: false, error: "ai_result.response_message must be a string within the length limit, or null." };
    }
    if (typeof raw2.qualification_status !== "string" || !QUALIFICATION_STATUSES.has(raw2.qualification_status)) {
      return { ok: false, error: "ai_result.qualification_status must be one of new, qualifying, qualified, needs_human." };
    }
    if (
      !Array.isArray(raw2.missing_information) ||
      raw2.missing_information.length > MAX_MISSING_INFO_ITEMS ||
      !raw2.missing_information.every((item) => typeof item === "string" && item.length <= MAX_SHORT_FIELD_LENGTH)
    ) {
      return { ok: false, error: "ai_result.missing_information must be an array of short strings." };
    }
    if (typeof raw2.urgency !== "string" || !URGENCY_LEVELS.has(raw2.urgency)) {
      return { ok: false, error: "ai_result.urgency must be one of low, normal, high, emergency." };
    }
    if (!isOptionalString(raw2.model, MAX_SHORT_FIELD_LENGTH)) {
      return { ok: false, error: "ai_result.model must be a short string or null." };
    }
    if (!isOptionalString(raw2.intent, MAX_SHORT_FIELD_LENGTH)) {
      return { ok: false, error: "ai_result.intent must be a short string or null." };
    }
    if (!isOptionalString(raw2.summary, MAX_SHORT_FIELD_LENGTH * 4)) {
      return { ok: false, error: "ai_result.summary must be a string within the length limit, or null." };
    }
    if (raw2.should_send && !raw2.response_message) {
      return { ok: false, error: "ai_result.response_message is required when should_send is true." };
    }

    let bookingIntent: BookingIntent | null = null;
    if (raw2.booking_intent !== null && raw2.booking_intent !== undefined) {
      if (typeof raw2.booking_intent !== "object") {
        return { ok: false, error: "ai_result.booking_intent must be an object or null." };
      }
      const rawIntent = raw2.booking_intent as Record<string, unknown>;

      if (typeof rawIntent.action !== "string" || !BOOKING_ACTIONS.has(rawIntent.action)) {
        return { ok: false, error: "ai_result.booking_intent.action must be one of none, check_availability, book." };
      }

      const isIsoDateOrNull = (value: unknown): value is string | null => {
        if (value === null || value === undefined) return true;
        return typeof value === "string" && value.length <= MAX_SHORT_FIELD_LENGTH && !Number.isNaN(Date.parse(value));
      };
      if (!isIsoDateOrNull(rawIntent.date_range_start) || !isIsoDateOrNull(rawIntent.date_range_end) || !isIsoDateOrNull(rawIntent.start_at) || !isIsoDateOrNull(rawIntent.end_at)) {
        return { ok: false, error: "ai_result.booking_intent date/time fields must be ISO 8601 strings or null." };
      }
      if (!isOptionalString(rawIntent.title, MAX_SHORT_FIELD_LENGTH)) {
        return { ok: false, error: "ai_result.booking_intent.title must be a short string or null." };
      }

      bookingIntent = {
        action: rawIntent.action as BookingAction,
        date_range_start: (rawIntent.date_range_start as string | null) ?? null,
        date_range_end: (rawIntent.date_range_end as string | null) ?? null,
        start_at: (rawIntent.start_at as string | null) ?? null,
        end_at: (rawIntent.end_at as string | null) ?? null,
        title: (rawIntent.title as string | null) ?? null,
      };
    }

    let usage: AiUsage | null = null;
    if (raw2.usage !== null && raw2.usage !== undefined) {
      if (typeof raw2.usage !== "object") {
        return { ok: false, error: "ai_result.usage must be an object or null." };
      }
      const rawUsage = raw2.usage as Record<string, unknown>;

      const isNonNegativeIntOrNull = (value: unknown): value is number | null => {
        if (value === null || value === undefined) return true;
        return typeof value === "number" && Number.isInteger(value) && value >= 0;
      };
      if (!isNonNegativeIntOrNull(rawUsage.input_tokens) || !isNonNegativeIntOrNull(rawUsage.output_tokens) || !isNonNegativeIntOrNull(rawUsage.total_tokens)) {
        return { ok: false, error: "ai_result.usage.input_tokens/output_tokens/total_tokens must each be a non-negative integer or null." };
      }

      usage = {
        input_tokens: (rawUsage.input_tokens as number | null) ?? null,
        output_tokens: (rawUsage.output_tokens as number | null) ?? null,
        total_tokens: (rawUsage.total_tokens as number | null) ?? null,
      };
    }

    aiResult = {
      should_send: raw2.should_send,
      response_message: (raw2.response_message as string | null) ?? null,
      qualification_status: raw2.qualification_status as QualificationStatus,
      missing_information: raw2.missing_information as string[],
      urgency: raw2.urgency as Urgency,
      needs_human: raw2.needs_human,
      model: (raw2.model as string | null) ?? null,
      intent: (raw2.intent as string | null) ?? null,
      summary: (raw2.summary as string | null) ?? null,
      booking_intent: bookingIntent,
      usage,
    };
  }

  return {
    ok: true,
    body: {
      execution_id: body.execution_id as string,
      event_id: body.event_id as string,
      organization_id: body.organization_id as string,
      ai_result: aiResult,
    },
  };
}

function isAuthorized(request: NextRequest): boolean {
  const configuredSecret = process.env.N8N_WEBHOOK_SECRET;
  // No secret configured means no request can ever be trusted - reject
  // everything rather than accepting unauthenticated callbacks.
  if (!configuredSecret) return false;

  const provided = request.headers.get("x-trackpr-webhook-secret");
  if (!provided) return false;

  const expected = Buffer.from(configuredSecret);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}

type EmbeddedEvent = {
  id: string;
  organization_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
};

function normalizeEvent(value: EmbeddedEvent | EmbeddedEvent[] | null): EmbeddedEvent | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * The RPCs' own UPDATE ... WHERE status = 'running' is the actual source of
 * truth for "did this call win the race" - the earlier status check in this
 * route is only a fast path to skip unnecessary work for an obviously
 * already-processed execution. If two callbacks for the same execution
 * genuinely race, the loser lands here: that's an expected, benign outcome
 * (someone else already recorded the result), not a server error.
 */
function isAlreadyProcessedError(error: string): boolean {
  return error === "Execution is not running";
}

/**
 * Automation Health + Alerting V1: records an n8n_callback_failed signal
 * when this route itself could not persist an n8n callback's outcome
 * (complete_workflow_execution/fail_workflow_execution returning an
 * unexpected, non-"already processed" error) - a genuinely urgent case,
 * since the execution is left in an inconsistent state no later callback
 * will retry. Fingerprint context is the execution id (not the automation):
 * a botched callback for one execution says nothing about a different
 * execution of the same automation, and a retried/duplicate callback for
 * the SAME execution correctly collapses into one incident. Never throws -
 * matches recordAutomationHealthSignal's own best-effort contract.
 */
async function recordCallbackFailureSignal(service: SupabaseClient, event: EmbeddedEvent, executionId: string, rpcError: string): Promise<void> {
  const automation = getAutomationForEventType(event.event_type);
  await recordAutomationHealthSignal(service, {
    organizationId: event.organization_id,
    category: "n8n_callback_failed",
    severity: "critical",
    fingerprintContext: executionId,
    title: `Callback processing failed for ${automation?.name ?? event.event_type}`,
    description: rpcError,
    automationId: automation?.id ?? null,
    workflowExecutionId: executionId,
  });
}

/**
 * Maps an automation event_type to the ai_interactions.interaction_type
 * label it should be recorded under. interaction_type has no CHECK
 * constraint (free text), so adding a new event type here never needs a
 * migration - only this mapping.
 */
function interactionTypeFor(eventType: string): string {
  switch (eventType) {
    case "customer.message.received":
      return "customer_reply_response";
    case "appointment.created":
      return "appointment_created_response";
    case "appointment.no_show":
      return "appointment_no_show_response";
    case "estimate.sent":
      return "estimate_sent_response";
    case "job.created":
      return "job_created_response";
    case "job.post_followup":
      return "post_job_followup_response";
    case "lead.lost_nurture":
      return "lead_lost_nurture_response";
    case "lead.reactivation":
      return "lead_reactivation_response";
    default:
      return "lead_followup_response";
  }
}

/**
 * Phase 4.4: appointment-context sends (confirmation, no-show follow-up)
 * are only allowed while the appointment is still in the specific state
 * that message type makes sense for - re-checked live by the gate, never
 * trusted from when the automation event was originally created.
 */
function appointmentEligibleStatusesFor(eventType: string): ("scheduled" | "confirmed" | "completed" | "cancelled" | "no_show")[] | null {
  if (eventType === "appointment.created") return ["scheduled", "confirmed"];
  if (eventType === "appointment.no_show") return ["no_show"];
  return null;
}

/**
 * Phase 4.5: same pattern as appointmentEligibleStatusesFor, for
 * estimate.sent's initial notification - only sendable while the estimate
 * is still 'sent' (not yet accepted/declined/cancelled/expired).
 */
function estimateEligibleStatusesFor(eventType: string): ("draft" | "sent" | "accepted" | "declined" | "cancelled" | "expired")[] | null {
  if (eventType === "estimate.sent") return ["sent"];
  return null;
}

/**
 * Phase 4.6: same pattern, for job.created's kickoff notification - only
 * sendable while the job is still scheduled/in_progress (requirement M:
 * completed/cancelled jobs can never receive it, even if it was eligible
 * when the automation event was first created).
 */
function jobEligibleStatusesFor(eventType: string): ("scheduled" | "in_progress" | "completed" | "cancelled")[] | null {
  if (eventType === "job.created") return ["scheduled", "in_progress"];
  // Phase 4.7: the post-job thank-you/review/referral message is only
  // sendable while the job is still 'completed' (requirement K) - re-checked
  // live, not trusted from when the automation event was first created.
  if (eventType === "job.post_followup") return ["completed"];
  return null;
}

/**
 * Phase 4.8: same pattern, for lead.lost_nurture's touch 1/2 - only
 * sendable while the lead is still 'lost' (the core stale-lead protection:
 * a lead that became active again after the nurture event/cron tick fired
 * must never receive the stale touch, re-checked live here).
 */
function leadEligibleStatusesFor(eventType: string): ("new" | "contacted" | "qualified" | "appointment" | "estimate" | "won" | "lost")[] | null {
  if (eventType === "lead.lost_nurture") return ["lost"];
  // Phase 4.9: lead.reactivation's touch 1/2 are only sendable while the
  // lead is still in one of the exact statuses the reactivation candidate
  // scan itself uses (new/contacted/qualified) - re-checked live here,
  // never trusted from when the cron tick first found the lead eligible.
  if (eventType === "lead.reactivation") return ["new", "contacted", "qualified"];
  return null;
}

/**
 * Phase 4.9: whether this event type additionally requires the gate to
 * re-verify, live, that the lead has no active appointment/estimate/job
 * right now - the audit found leads.status is never auto-synced when one of
 * those is created for a lead, so leadEligibleStatusesFor alone cannot
 * detect it.
 */
function leadMustHaveNoActiveEngagementFor(eventType: string): boolean {
  return eventType === "lead.reactivation";
}

/**
 * Review & Referral Tracking V1: the only place this route calls into
 * lib/reviews-referrals/tracking.ts, and only ever for job.post_followup -
 * every other event type is a complete no-op here. jobId/reviewUrl are read
 * straight from the already-validated event fields this function receives
 * (never re-derived or re-fetched), and workflowExecutionId is always the
 * execution this callback is for - the exact same values the gate/send path
 * just used to decide and record the real outcome, not a second, possibly
 * inconsistent source of truth.
 */
async function recordReviewReferralOutcomeIfApplicable(
  service: SupabaseClient,
  params: {
    eventType: string;
    organizationId: string;
    jobId: string | null;
    contactId: string | null;
    conversationId: string | null;
    reviewUrl: string | null;
    executionId: string;
  },
  outcome:
    | { kind: "sent"; messageId: string }
    | { kind: "blocked"; reason: string }
    | { kind: "send_failed"; reason: string },
): Promise<void> {
  if (params.eventType !== "job.post_followup" || !params.jobId) return;

  const input = { organizationId: params.organizationId, jobId: params.jobId, contactId: params.contactId, conversationId: params.conversationId, reviewUrl: params.reviewUrl };

  if (outcome.kind === "sent") {
    await recordPostJobFollowupOutcome(service, input, { kind: "sent", messageId: outcome.messageId, workflowExecutionId: params.executionId });
  } else {
    await recordPostJobFollowupOutcome(service, input, { kind: outcome.kind, workflowExecutionId: params.executionId, reason: outcome.reason });
  }
}

/**
 * Automation Configuration V2.2: resolves whether the gate should require
 * business hours for this specific event's automation, reading that
 * automation's own automation_settings.config fresh on every callback - no
 * caching. Only instant-lead-followup (lead.created) and
 * inbound-customer-reply (customer.message.received) have this setting;
 * every other event type is unaffected and returns false, exactly like
 * omitting respectBusinessHours entirely from the gate call.
 */
async function respectBusinessHoursFor(service: SupabaseClient, organizationId: string, eventType: string): Promise<boolean> {
  if (eventType === "lead.created") {
    const raw = await getAutomationConfig(service, organizationId, "instant-lead-followup");
    return readInstantLeadFollowupConfig(raw).respect_business_hours;
  }
  if (eventType === "customer.message.received") {
    const raw = await getAutomationConfig(service, organizationId, "inbound-customer-reply");
    return readInboundCustomerReplyConfig(raw).respect_business_hours;
  }
  // Automation Configuration V5: appointment-lifecycle covers both of its
  // catalog event types (appointment.created, appointment.no_show) under
  // one shared config row, matching how the catalog itself groups them
  // under the single "appointment-lifecycle" automation id.
  if (eventType === "appointment.created" || eventType === "appointment.no_show") {
    const raw = await getAutomationConfig(service, organizationId, "appointment-lifecycle");
    return readAppointmentLifecycleConfig(raw).respect_business_hours;
  }
  if (eventType === "job.created") {
    const raw = await getAutomationConfig(service, organizationId, "job-lifecycle");
    return readJobLifecycleConfig(raw).respect_business_hours;
  }
  if (eventType === "job.post_followup") {
    const raw = await getAutomationConfig(service, organizationId, "review-referral-followup");
    return readReviewReferralFollowupConfig(raw).respect_business_hours;
  }
  return false;
}

/**
 * Instant Lead Follow-Up V1 (Safe Automatic SMS): re-resolves whether the
 * automation this event's type maps to is still enabled, live, at send
 * time - never trusted from the event-creation-time check alone (see
 * createAutomationEvent/createAutomationEventAsService), which only proves
 * it was enabled when the event was first created, not that it still is by
 * the time n8n's callback lands. Uses the exact same
 * getAutomationForEventType/getAutomationEnabled lookup those functions
 * already use - not a second, divergent enable/disable mechanism.
 * Undefined (no catalog automation maps to this event type at all) is
 * treated by the gate as "no additional restriction", identical to how it
 * treats respectBusinessHours being omitted.
 */
async function automationEnabledFor(
  service: SupabaseClient,
  organizationId: string,
  eventType: string,
): Promise<boolean | undefined> {
  const automation = getAutomationForEventType(eventType);
  if (!automation) return undefined;
  return getAutomationEnabled(service, organizationId, automation.id);
}

const BOOKING_ELIGIBLE_APPOINTMENT_STATUSES = ["scheduled", "confirmed"] as const;
const BOOKING_DECLINE_MESSAGE = "Sorry, that time is no longer available. Let us know another time that works for you.";
const BOOKING_FALLBACK_MESSAGE = "We're having trouble booking that automatically right now. Our team will reach out shortly to get you scheduled.";
/** Reasons that mean something is genuinely wrong (config, payment, an internal error, an untrustworthy contact) - these escalate to a human. slot_unavailable is a normal, non-escalating retry case: someone else took the slot, or the AI proposed a time that's no longer offered. */
const BOOKING_ESCALATING_FAILURE_REASONS = new Set(["invalid_contact", "organization_not_active", "booking_disabled", "configuration_error", "internal_error"]);

function serializeSlots(slots: BookingSlot[]): { start_at: string; end_at: string }[] {
  return slots.map((slot) => ({ start_at: slot.start_at, end_at: slot.end_at }));
}

const CONTRACTOR_BOOKING_FALLBACK_TITLE = "Service Appointment";
const GYM_BOOKING_FALLBACK_TITLE = "Gym Appointment";

/**
 * Gym Revenue Engine, Slice 1: the AI is always expected to supply its own
 * booking_intent.title (the normal path, unchanged) - this only resolves a
 * fallback for the rare case it doesn't, so paying the extra query here
 * never affects the common path. Fails closed to the contractor title on any
 * error or unrecognized value, matching lib/auth/organization.ts's own
 * fail-closed "unrecognized -> contractor" convention - never silently
 * assumes gym.
 */
async function resolveBookingFallbackTitle(service: SupabaseClient, organizationId: string): Promise<string> {
  const { data } = await service.from("organizations").select("vertical").eq("id", organizationId).maybeSingle();
  return data?.vertical === "gym" ? GYM_BOOKING_FALLBACK_TITLE : CONTRACTOR_BOOKING_FALLBACK_TITLE;
}

/**
 * Growth System Completion Pass 1 (Part 3): the entire AI appointment
 * booking branch, kept as its own self-contained function rather than woven
 * into the existing should_send/gate/send flow - the same "each concern is
 * its own legible function" choice this codebase already made for
 * lib/automation/appointment-reminders.ts's deterministic sends. Reuses
 * lib/scheduling/booking.ts (Stage 6) completely unchanged: payment check,
 * organization isolation, contact ownership, a fresh availability recheck
 * immediately before insert, Stage 1's exclusion constraint as the final
 * concurrency guarantee, idempotency (via `idempotencyKey`), and Stage 5's
 * Google sync are ALL still enforced by that module, not re-implemented
 * here. This route never sees Google credentials, event ids, or calendar
 * metadata - only what getAvailableBookingSlots/bookAppointment already
 * expose ({start_at, end_at} and a safe success/failure result).
 */
/** Exported only so a test can exercise a real successful send (via the sendSmsFn seam below) without fighting Next.js's own generated type contract for POST's signature - POST itself is never given an extra parameter, matching every other route handler in this codebase. */
export async function handleBookingIntent(
  service: SupabaseClient,
  params: {
    organizationId: string;
    executionId: string;
    contactId: string | null;
    leadId: string | null;
    conversationId: string | null;
    bookingIntent: BookingIntent;
  },
  /** Test seam only - production (real n8n) callers never pass this; see lib/messaging/outbound.ts's own identical seam. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<NextResponse> {
  const { organizationId, executionId, contactId, leadId, conversationId, bookingIntent } = params;

  if (bookingIntent.action === "check_availability") {
    if (!bookingIntent.date_range_start || !bookingIntent.date_range_end) {
      const result = await completeWorkflowExecutionAsService(service, executionId, { should_send: false, booking_action: "check_availability", error: "missing_date_range" });
      if (!result.ok && !isAlreadyProcessedError(result.error)) {
        console.error("[automation] failed to complete check_availability execution", { executionId, error: result.error });
      }
      return NextResponse.json({ ok: true, booking: { status: "invalid_request", slots: [] } });
    }

    const availability = await getAvailableBookingSlots(service, organizationId, new Date(bookingIntent.date_range_start), new Date(bookingIntent.date_range_end));

    const result = await completeWorkflowExecutionAsService(service, executionId, {
      should_send: false,
      booking_action: "check_availability",
      availability_status: availability.status,
      slot_count: availability.status === "available" ? availability.slots.length : 0,
    });
    if (!result.ok) {
      if (isAlreadyProcessedError(result.error)) return NextResponse.json({ ok: true, alreadyProcessed: true });
      console.error("[automation] failed to complete check_availability execution", { executionId, error: result.error });
      return NextResponse.json({ ok: false, error: "Could not record the availability check." }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      booking: {
        status: availability.status,
        slots: availability.status === "available" ? serializeSlots(availability.slots) : [],
      },
    });
  }

  // action === "book"
  if (!bookingIntent.start_at || !bookingIntent.end_at || !contactId) {
    const result = await completeWorkflowExecutionAsService(service, executionId, { should_send: false, booking_action: "book", error: "missing_required_fields" });
    if (!result.ok && !isAlreadyProcessedError(result.error)) {
      console.error("[automation] failed to complete book execution", { executionId, error: result.error });
    }
    return NextResponse.json({ ok: true, booking: { status: "invalid_request" } });
  }

  const bookingResult = await bookAppointment(service, {
    organizationId,
    contactId,
    leadId,
    startAt: bookingIntent.start_at,
    endAt: bookingIntent.end_at,
    title: bookingIntent.title ?? (await resolveBookingFallbackTitle(service, organizationId)),
    // Deterministic and derivable again from this exact execution id alone -
    // a retried/replayed callback for the same execution resolves to the
    // same idempotency key bookAppointment() itself already de-duplicates
    // on (see lib/scheduling/booking.ts), never a second booking attempt.
    idempotencyKey: `booking:${executionId}`,
  });

  let body: string;
  let needsHuman = false;
  let appointmentIdForGate: string | null = null;
  let freshSlots: { start_at: string; end_at: string }[] = [];

  if (bookingResult.success) {
    const timezone = bookingResult.timezone;
    body = `You're booked! Your appointment is confirmed for ${formatAppointmentDate(bookingResult.startAt, timezone)} at ${formatAppointmentTimeRange(bookingResult.startAt, bookingResult.endAt, timezone)}. Reply STOP to opt out of texts.`;
    appointmentIdForGate = bookingResult.appointmentId;

    // Founder Notifications V1: the AI-booking equivalent of
    // lib/automation/appointments.ts's own notifyFounder call in
    // emitAppointmentCreated (the manual-creation path) - bookAppointment()
    // itself is never modified to call emitAppointmentCreated (that would
    // dispatch a SECOND, AI-drafted confirmation via n8n, double-messaging
    // the customer), so this is the one place an AI-driven booking's
    // "appointment booked" notification fires.
    await notifyFounder(service, {
      organizationId,
      kind: "appointment_booked",
      summary: `AI-booked appointment on ${formatAppointmentDate(bookingResult.startAt, timezone)}.`,
      detailPath: `/appointments/${bookingResult.appointmentId}`,
    });
  } else if (bookingResult.reason === "slot_unavailable") {
    body = BOOKING_DECLINE_MESSAGE;
    // Re-offers real, freshly-computed alternatives in the same response -
    // never a second round trip needed just to recover from a benign race.
    const recheckStart = new Date(bookingIntent.start_at);
    const recheckEnd = new Date(recheckStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const availability = await getAvailableBookingSlots(service, organizationId, recheckStart, recheckEnd);
    freshSlots = availability.status === "available" ? serializeSlots(availability.slots) : [];
  } else {
    body = BOOKING_FALLBACK_MESSAGE;
    needsHuman = BOOKING_ESCALATING_FAILURE_REASONS.has(bookingResult.reason);
  }

  if (needsHuman && conversationId) {
    const { data: lockedRow, error: lockError } = await service
      .from("conversations")
      .update({ ai_enabled: false })
      .eq("id", conversationId)
      .eq("organization_id", organizationId)
      .eq("ai_enabled", true)
      .select("id")
      .maybeSingle();
    if (lockError) {
      console.error("[automation] failed to lock conversation after a booking failure", { executionId, error: lockError.message });
    } else if (lockedRow) {
      await notifyFounder(service, {
        organizationId,
        kind: "ai_escalation",
        summary: "AI appointment booking could not complete safely and needs a human.",
        detailPath: conversationId ? `/conversations/${conversationId}` : null,
      });
    }
  }

  const gateResult = await evaluateOutboundGate(service, {
    organizationId,
    executionId,
    contactId,
    conversationId,
    leadId,
    aiResult: { should_send: true, response_message: body, needs_human: false },
    appointmentId: appointmentIdForGate,
    appointmentEligibleStatuses: appointmentIdForGate ? [...BOOKING_ELIGIBLE_APPOINTMENT_STATUSES] : undefined,
  });

  let sent = false;
  if (gateResult.allowed) {
    const sendResult = await sendOutboundMessage(service, {
      organizationId,
      contactId: gateResult.contactId,
      conversationId: gateResult.conversationId,
      channel: "sms",
      body: gateResult.body,
      senderType: "ai",
      workflowExecutionId: executionId,
      sendSmsFn,
    });
    sent = sendResult.ok;
  }

  const completed = await completeWorkflowExecutionAsService(service, executionId, {
    should_send: sent,
    booking_action: "book",
    booking_success: bookingResult.success,
    booking_failure_reason: bookingResult.success ? null : bookingResult.reason,
    appointment_id: bookingResult.success ? bookingResult.appointmentId : null,
  });
  if (!completed.ok && !isAlreadyProcessedError(completed.error)) {
    console.error("[automation] failed to complete book execution", { executionId, error: completed.error });
  }

  return NextResponse.json({
    ok: true,
    booking: {
      status: bookingResult.success ? "booked" : bookingResult.reason,
      appointment_id: bookingResult.success ? bookingResult.appointmentId : null,
      slots: freshSlots,
    },
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const validation = validateBody(raw);
  if (!validation.ok) {
    return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
  }
  const body = validation.body;

  const service = createServiceRoleClient();

  const { data: execution, error: lookupError } = await service
    .from("workflow_executions")
    .select(
      "id, status, workflow_name, automation_event_id, organization_id, automation_events(id, organization_id, event_type, entity_type, entity_id, payload)",
    )
    .eq("id", body.execution_id)
    .maybeSingle();

  if (lookupError || !execution) {
    return NextResponse.json({ ok: false, error: "Execution not found." }, { status: 404 });
  }

  const event = normalizeEvent(
    execution.automation_events as EmbeddedEvent | EmbeddedEvent[] | null,
  );

  if (!event) {
    return NextResponse.json({ ok: false, error: "Execution not found." }, { status: 404 });
  }

  // Never trust organization_id/event_id from the request body for
  // authorization - only use them as a consistency check against the
  // relationships actually stored in the database.
  if (execution.automation_event_id !== body.event_id) {
    return NextResponse.json({ ok: false, error: "Execution does not belong to the referenced event." }, { status: 400 });
  }
  if (event.organization_id !== body.organization_id || execution.organization_id !== event.organization_id) {
    return NextResponse.json({ ok: false, error: "Organization mismatch." }, { status: 403 });
  }

  if (execution.status !== "running") {
    // Replayed/duplicate callback for an execution that's already been
    // completed or failed - a clean, idempotent no-op rather than an error
    // or a second mutation.
    return NextResponse.json({ ok: true, alreadyProcessed: true });
  }

  const aiResult = body.ai_result;

  // entity_id/entity_type covers lead.created (entity_type: "lead").
  // customer.message.received's entity is the conversation, with lead_id
  // (possibly null - not every conversation has an associated lead) carried
  // in the payload instead.
  const leadId =
    event.entity_type === "lead"
      ? event.entity_id
      : typeof event.payload?.lead_id === "string"
        ? (event.payload.lead_id as string)
        : null;

  // Phase 4.3: should_send is no longer forced false for
  // customer.message.received - the AI may now recommend sending, but that
  // recommendation only ever reaches sendOutboundMessage() after passing
  // the safe outbound gate below. lead.created's should_send remains
  // hardcoded false in n8n itself (that branch is intentionally unchanged
  // this phase), so it never reaches the gate in practice, but the gate
  // path is fully generic and would apply to it the same way if that ever
  // changed.
  const contactId =
    typeof event.payload?.contact_id === "string" ? (event.payload.contact_id as string) : null;
  const conversationId =
    typeof event.payload?.conversation_id === "string" ? (event.payload.conversation_id as string) : null;

  if (aiResult) {
    const interactionType = interactionTypeFor(event.event_type);

    // Upsert on workflow_execution_id (unique, nullable-safe) rather than a
    // plain insert: two genuinely concurrent callback deliveries for the
    // same execution could otherwise both pass the running-status check
    // above before either finishes and each write their own AI interaction.
    // ignoreDuplicates makes the loser a no-op instead of a duplicate row.
    const { error: aiInsertError } = await service.from("ai_interactions").upsert(
      {
        organization_id: event.organization_id,
        lead_id: leadId,
        contact_id: contactId,
        conversation_id: conversationId,
        workflow_execution_id: execution.id,
        interaction_type: interactionType,
        input: { event_type: event.event_type, entity_type: event.entity_type, entity_id: event.entity_id, payload: event.payload },
        output: aiResult,
        model: aiResult.model,
        // Growth System Completion Pass 2 (Part 4): the existing
        // tokens_used column, populated only when n8n's own AI call
        // actually reported a total - left null otherwise (never
        // estimated), so a real SQL SUM/AVG over this column never silently
        // includes a fabricated number.
        tokens_used: aiResult.usage?.total_tokens ?? null,
      },
      { onConflict: "workflow_execution_id", ignoreDuplicates: true },
    );

    if (aiInsertError) {
      console.error("[automation] failed to record ai_interaction", { executionId: execution.id, error: aiInsertError.message });
    }

    // leads.ai_summary already exists for exactly this purpose - a short,
    // human-readable AI rollup on the lead itself, queryable without
    // parsing ai_interactions.output. ai_score is deliberately left
    // untouched: qualification_status/urgency are categorical, not a score,
    // and inventing a numeric mapping would be exactly the "elaborate
    // scoring system" this phase avoids.
    if (leadId) {
      const summaryParts = [
        `Qualification: ${aiResult.qualification_status}`,
        `Urgency: ${aiResult.urgency}`,
      ];
      if (aiResult.missing_information.length > 0) {
        summaryParts.push(`Missing: ${aiResult.missing_information.join(", ")}`);
      }
      if (aiResult.needs_human) {
        summaryParts.push("Needs human follow-up");
      }
      if (aiResult.summary) {
        summaryParts.push(aiResult.summary);
      }

      const { error: leadUpdateError } = await service
        .from("leads")
        .update({ ai_summary: summaryParts.join(" · ") })
        .eq("id", leadId)
        .eq("organization_id", event.organization_id);

      if (leadUpdateError) {
        console.error("[automation] failed to update lead ai_summary", { executionId: execution.id, error: leadUpdateError.message });
      }

      // Founder Notifications V1: "hot lead" reuses the AI's own existing
      // urgency signal directly - never a second, competing definition of
      // "hot". Guarded by this same aiResult block only ever running once
      // per execution (the `execution.status !== "running"` early return
      // above), so a replayed/retried callback for the same execution can
      // never send this twice; a lead independently flagged high/emergency
      // urgency again on a LATER, different execution is a legitimately new
      // occurrence, not a duplicate.
      if (aiResult.urgency === "high" || aiResult.urgency === "emergency") {
        await notifyFounder(service, {
          organizationId: event.organization_id,
          kind: "hot_lead",
          summary: aiResult.summary
            ? `Urgency: ${aiResult.urgency}. ${aiResult.summary}`
            : `A lead was flagged as ${aiResult.urgency} urgency.`,
          detailPath: `/leads/${leadId}`,
        });
      }
    }

    // Fast-Track Production Readiness, Pass 2: durable needs_human lockout.
    // Reuses the existing conversations.ai_enabled column/toggle (see
    // lib/automation/outbound-gate.ts's own comment) rather than adding a
    // new one - once any AI result for this conversation says a human is
    // needed, AI stays locked out of it for every future automated send
    // until staff explicitly re-enable it from the conversation itself.
    if (aiResult.needs_human && conversationId) {
      // Founder Notifications V1: `.eq("ai_enabled", true)` turns this from
      // an unconditional set into a real "only if this is the first time"
      // transition - if the conversation was already locked, the UPDATE
      // matches zero rows (still succeeds, still a no-op, identical net
      // effect on the table as before) and `lockedRow` is null, so the
      // notification is sent exactly once per lockout, never on a replayed
      // callback or a second needs_human result for an already-locked
      // conversation.
      const { data: lockedRow, error: aiLockError } = await service
        .from("conversations")
        .update({ ai_enabled: false })
        .eq("id", conversationId)
        .eq("organization_id", event.organization_id)
        .eq("ai_enabled", true)
        .select("id")
        .maybeSingle();

      if (aiLockError) {
        console.error("[automation] failed to lock conversation ai_enabled after needs_human", { executionId: execution.id, error: aiLockError.message });
      } else if (lockedRow) {
        await notifyFounder(service, {
          organizationId: event.organization_id,
          kind: "ai_escalation",
          summary: aiResult.summary ? `AI handed off to a human: ${aiResult.summary}` : "The AI handed a conversation off to a human.",
          detailPath: `/conversations/${conversationId}`,
        });
      }
    }

    // Growth System Completion Pass 1 (Part 3): a booking-intent turn is
    // handled entirely separately from the should_send/gate/send flow below
    // - Trackpr, not the AI, owns every message this branch produces. Runs
    // only once per execution, for the same reason every other branch in
    // this aiResult block does (the running-status guard at the top of this
    // function).
    if (aiResult.booking_intent && aiResult.booking_intent.action !== "none") {
      return handleBookingIntent(service, {
        organizationId: event.organization_id,
        executionId: execution.id,
        contactId,
        leadId,
        conversationId,
        bookingIntent: aiResult.booking_intent,
      });
    }
  }

  if (!aiResult || !aiResult.should_send) {
    const result = await completeWorkflowExecutionAsService(service, execution.id, {
      should_send: false,
      needs_human: aiResult?.needs_human ?? null,
      qualification_status: aiResult?.qualification_status ?? null,
      urgency: aiResult?.urgency ?? null,
      missing_information: aiResult?.missing_information ?? null,
      intent: aiResult?.intent ?? null,
      summary: aiResult?.summary ?? null,
    });
    if (!result.ok) {
      if (isAlreadyProcessedError(result.error)) {
        return NextResponse.json({ ok: true, alreadyProcessed: true });
      }
      console.error("[automation] failed to complete execution", { executionId: execution.id, error: result.error });
      await recordCallbackFailureSignal(service, event, execution.id, result.error);
      return NextResponse.json({ ok: false, error: "Could not record the automation result." }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  const appointmentId =
    event.entity_type === "appointment"
      ? event.entity_id
      : typeof event.payload?.appointment_id === "string"
        ? (event.payload.appointment_id as string)
        : null;
  const appointmentEligibleStatuses = appointmentEligibleStatusesFor(event.event_type);

  const estimateId =
    event.entity_type === "estimate"
      ? event.entity_id
      : typeof event.payload?.estimate_id === "string"
        ? (event.payload.estimate_id as string)
        : null;
  const estimateEligibleStatuses = estimateEligibleStatusesFor(event.event_type);

  const jobId =
    event.entity_type === "job"
      ? event.entity_id
      : typeof event.payload?.job_id === "string"
        ? (event.payload.job_id as string)
        : null;
  const jobEligibleStatuses = jobEligibleStatusesFor(event.event_type);
  // Review & Referral Tracking V1: the exact review_url Trackpr sent with
  // the original request (snapshotted in the stored event payload by
  // emitPostJobFollowup) - never re-fetched from organizations here, since
  // the org's configured URL could have changed since the request was made.
  const reviewUrl = typeof event.payload?.review_url === "string" ? (event.payload.review_url as string) : null;

  const leadEligibleStatuses = leadEligibleStatusesFor(event.event_type);
  const leadMustHaveNoActiveEngagement = leadMustHaveNoActiveEngagementFor(event.event_type);
  const respectBusinessHours = await respectBusinessHoursFor(service, event.organization_id, event.event_type);
  const automationEnabled = await automationEnabledFor(service, event.organization_id, event.event_type);

  // Trackpr is the final send authority: the AI/n8n may recommend sending,
  // but nothing reaches the customer without independently passing this
  // gate. Every condition it checks is re-derived from the database, not
  // trusted from this request's payload - see lib/automation/outbound-gate.
  const gateResult = await evaluateOutboundGate(service, {
    organizationId: event.organization_id,
    executionId: execution.id,
    contactId,
    conversationId,
    leadId,
    aiResult: {
      should_send: aiResult.should_send,
      response_message: aiResult.response_message,
      needs_human: aiResult.needs_human,
    },
    appointmentId: appointmentEligibleStatuses ? appointmentId : null,
    appointmentEligibleStatuses: appointmentEligibleStatuses ?? undefined,
    estimateId: estimateEligibleStatuses ? estimateId : null,
    estimateEligibleStatuses: estimateEligibleStatuses ?? undefined,
    jobId: jobEligibleStatuses ? jobId : null,
    jobEligibleStatuses: jobEligibleStatuses ?? undefined,
    leadEligibleStatuses: leadEligibleStatuses ?? undefined,
    leadMustHaveNoActiveEngagement: leadMustHaveNoActiveEngagement || undefined,
    respectBusinessHours: respectBusinessHours || undefined,
    automationEnabled,
  });

  if (!gateResult.allowed) {
    // Blocked by Trackpr's own safety decision - not an error. Recorded as
    // a normal completion with should_send:false, exactly like the AI
    // itself returning should_send:false, plus the specific reason so it's
    // inspectable later (metadata is never surfaced to the customer).
    const result = await completeWorkflowExecutionAsService(service, execution.id, {
      should_send: false,
      blocked_reason: gateResult.reason,
      blocked_detail: gateResult.detail ?? null,
      needs_human: aiResult.needs_human,
      qualification_status: aiResult.qualification_status,
      urgency: aiResult.urgency,
      missing_information: aiResult.missing_information,
      intent: aiResult.intent,
      summary: aiResult.summary,
    });
    if (!result.ok) {
      if (isAlreadyProcessedError(result.error)) {
        return NextResponse.json({ ok: true, alreadyProcessed: true });
      }
      console.error("[automation] failed to complete execution", { executionId: execution.id, error: result.error });
      await recordCallbackFailureSignal(service, event, execution.id, result.error);
      return NextResponse.json({ ok: false, error: "Could not record the automation result." }, { status: 500 });
    }
    await recordReviewReferralOutcomeIfApplicable(
      service,
      { eventType: event.event_type, organizationId: event.organization_id, jobId, contactId, conversationId, reviewUrl, executionId: execution.id },
      { kind: "blocked", reason: gateResult.reason },
    );
    return NextResponse.json({ ok: true, sent: false, blockedReason: gateResult.reason });
  }

  // sendOutboundMessage is the single path every outbound SMS goes through:
  // it opens/reuses the conversation, writes the messages row first
  // (status: queued), then calls the Twilio provider and updates that same
  // row to sent/failed.
  const sendResult = await sendOutboundMessage(service, {
    organizationId: event.organization_id,
    contactId: gateResult.contactId,
    conversationId: gateResult.conversationId,
    channel: "sms",
    body: gateResult.body,
    senderType: "ai",
    workflowExecutionId: execution.id,
  });

  if (!sendResult.ok) {
    // The execution must clearly reflect that delivery could not complete;
    // it must never be marked completed as if the customer-facing message
    // went out.
    const failed = await failWorkflowExecutionAsService(service, execution.id, sendResult.error, "sms_send_failed");
    if (!failed.ok && !isAlreadyProcessedError(failed.error)) {
      console.error("[automation] failed to record execution failure", { executionId: execution.id, error: failed.error });
      await recordCallbackFailureSignal(service, event, execution.id, failed.error);
    }
    await recordReviewReferralOutcomeIfApplicable(
      service,
      { eventType: event.event_type, organizationId: event.organization_id, jobId, contactId, conversationId, reviewUrl, executionId: execution.id },
      { kind: "send_failed", reason: sendResult.error },
    );
    return NextResponse.json({ ok: true });
  }

  const completed = await completeWorkflowExecutionAsService(service, execution.id, {
    should_send: true,
    message_id: sendResult.messageId,
    conversation_id: sendResult.conversationId,
    provider_message_id: sendResult.providerMessageId,
    lead_id: leadId,
  });
  if (!completed.ok) {
    if (isAlreadyProcessedError(completed.error)) {
      return NextResponse.json({ ok: true, alreadyProcessed: true });
    }
    console.error("[automation] failed to complete execution", { executionId: execution.id, error: completed.error });
    await recordCallbackFailureSignal(service, event, execution.id, completed.error);
    return NextResponse.json({ ok: false, error: "Could not record the automation result." }, { status: 500 });
  }

  await recordReviewReferralOutcomeIfApplicable(
    service,
    { eventType: event.event_type, organizationId: event.organization_id, jobId, contactId, conversationId, reviewUrl, executionId: execution.id },
    { kind: "sent", messageId: sendResult.messageId },
  );

  return NextResponse.json({ ok: true });
}
