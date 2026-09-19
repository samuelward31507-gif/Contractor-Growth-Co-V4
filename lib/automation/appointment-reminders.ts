import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import { getAutomationEnabled } from "./settings";
import {
  startWorkflowExecutionAsService,
  completeWorkflowExecutionAsService,
  failWorkflowExecutionAsService,
  completeWorkflowExecution,
  failWorkflowExecution,
  type WorkflowExecutionTriggerSource,
} from "./executions";
import { evaluateOutboundGate } from "./outbound-gate";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getBusinessProfile } from "@/lib/settings/queries";
import { formatAppointmentDate, formatAppointmentTimeRange } from "@/lib/appointments/format";
import type { AppointmentStatus } from "@/lib/appointments/queries";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";

export const APPOINTMENT_REMINDER_WORKFLOW = "appointment_reminder";
export const REMINDER_LEAD_TIME_MS = 24 * 60 * 60 * 1000; // 24 hours - the Phase 4.4 default interval

const ELIGIBLE_STATUSES: AppointmentStatus[] = ["scheduled", "confirmed"];

type CandidateAppointment = {
  id: string;
  organization_id: string;
  contact_id: string | null;
  lead_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  updated_at: string;
};

export type ReminderOutcome =
  | { appointmentId: string; outcome: "sent"; messageId: string }
  | { appointmentId: string; outcome: "blocked"; reason: string }
  | { appointmentId: string; outcome: "skipped_duplicate" }
  | { appointmentId: string; outcome: "skipped_disabled" }
  | { appointmentId: string; outcome: "failed"; error: string };

export type ReminderRunResult = {
  candidates: number;
  outcomes: ReminderOutcome[];
};

/**
 * Composes the reminder body directly in Trackpr, with no AI/n8n round
 * trip: a reminder is pure fact-recitation (title, date, time) with no
 * judgment call for a model to make, so involving the LLM would only add
 * latency, cost, and a hallucination surface for zero benefit. This keeps
 * "Trackpr is the source of truth" as strict as possible for this message
 * type - see the Phase 4.4 report for the full architectural rationale.
 */
function composeReminderBody(appointment: CandidateAppointment, timezone: string): string {
  const dateLabel = formatAppointmentDate(appointment.start_at, timezone);
  const timeLabel = formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timezone);
  return `Reminder: your appointment "${appointment.title}" is scheduled for ${dateLabel} at ${timeLabel}. Reply STOP to opt out of texts.`;
}

/**
 * Finds appointments due for their 24-hour-before reminder right now, and
 * for each one: creates the appointment.reminder automation event/execution
 * (idempotent per appointment+start_at - see idempotencyKey below), sends
 * the reminder through the exact same safe outbound gate + sendOutboundMessage
 * path every other automated message uses, and completes/fails the
 * execution accordingly. Designed to be called repeatedly on a schedule
 * (see app/api/automation/appointment-reminders/route.ts) - every step is
 * idempotent, so calling this twice in the same window is always safe.
 *
 * Eligibility, computed entirely from existing columns (no new schema):
 * - status is 'scheduled' or 'confirmed' (never cancelled/completed/no_show)
 * - start_at is between now and now+24h (the reminder is "due")
 * - updated_at is at or before start_at-24h - i.e. this appointment's
 *   current start_at has been in place for at least 24 hours already. This
 *   is the guard against inventing a "historical" reminder: an appointment
 *   created or rescheduled with less than 24 hours' notice never gets a
 *   reminder fired immediately just because the 24-hour mark has already
 *   technically passed - see the Phase 4.4 report for the documented
 *   limitation (updated_at is a proxy for "when this start_at was set",
 *   not a dedicated column, since the schema has none).
 */
export async function processAppointmentReminders(
  supabase: SupabaseClient,
  now: Date = new Date(),
  /** Test seam only - production callers must never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
  /** Phase D: "manual" when triggered by an org admin's "Run now" action; every real cron tick omits this and keeps the column's own 'event' default. */
  triggerSource: WorkflowExecutionTriggerSource = "event",
): Promise<ReminderRunResult> {
  const windowEnd = new Date(now.getTime() + REMINDER_LEAD_TIME_MS);

  const { data: rawCandidates } = await supabase
    .from("appointments")
    .select("id, organization_id, contact_id, lead_id, title, start_at, end_at, status, updated_at")
    .in("status", ELIGIBLE_STATUSES)
    .gt("start_at", now.toISOString())
    .lte("start_at", windowEnd.toISOString())
    .limit(500);

  const candidates = ((rawCandidates ?? []) as CandidateAppointment[]).filter((appointment) => {
    const dueAt = new Date(appointment.start_at).getTime() - REMINDER_LEAD_TIME_MS;
    return new Date(appointment.updated_at).getTime() <= dueAt;
  });

  const outcomes: ReminderOutcome[] = [];

  for (const appointment of candidates) {
    outcomes.push(await processOneReminder(supabase, appointment, sendSmsFn, triggerSource));
  }

  return { candidates: candidates.length, outcomes };
}

async function processOneReminder(
  supabase: SupabaseClient,
  appointment: CandidateAppointment,
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
  triggerSource: WorkflowExecutionTriggerSource = "event",
): Promise<ReminderOutcome> {
  // Phase C: checked here too (not only inside createAutomationEventAsService's
  // own chokepoint) so a disabled organization skips the businessProfile/
  // conversation lookups below entirely, not just the event insert.
  if (!(await getAutomationEnabled(supabase, appointment.organization_id, "appointment-reminders"))) {
    return { appointmentId: appointment.id, outcome: "skipped_disabled" };
  }

  const idempotencyKey = `appointment.reminder:${appointment.id}:${appointment.start_at}`;

  const eventResult = await createAutomationEventAsService(supabase, appointment.organization_id, {
    eventType: "appointment.reminder",
    entityType: "appointment",
    entityId: appointment.id,
    payload: {
      appointment_id: appointment.id,
      contact_id: appointment.contact_id,
      lead_id: appointment.lead_id,
      start_at: appointment.start_at,
    },
    idempotencyKey,
  });

  if (!eventResult.ok) {
    return { appointmentId: appointment.id, outcome: "failed", error: eventResult.error };
  }
  if (eventResult.duplicate) {
    return { appointmentId: appointment.id, outcome: "skipped_duplicate" };
  }
  if (eventResult.skipped) {
    return { appointmentId: appointment.id, outcome: "skipped_disabled" };
  }

  const executionResult = await startWorkflowExecutionAsService(
    supabase,
    eventResult.event.id,
    APPOINTMENT_REMINDER_WORKFLOW,
    {},
    triggerSource,
  );
  if (!executionResult.ok) {
    return { appointmentId: appointment.id, outcome: "failed", error: executionResult.error };
  }

  const executionId = executionResult.execution.id;
  const businessProfile = await getBusinessProfile(supabase, appointment.organization_id);
  const timezone = businessProfile?.timezone ?? "UTC";

  let conversationId: string | null = null;
  if (appointment.contact_id) {
    const conversation = await findOrCreateOpenConversation(
      supabase,
      appointment.organization_id,
      appointment.contact_id,
      "sms",
      appointment.lead_id,
    );
    conversationId = conversation?.id ?? null;
  }

  const body = composeReminderBody(appointment, timezone);

  const gateResult = await evaluateOutboundGate(supabase, {
    organizationId: appointment.organization_id,
    executionId,
    contactId: appointment.contact_id,
    conversationId,
    leadId: appointment.lead_id,
    aiResult: { should_send: true, response_message: body, needs_human: false },
    appointmentId: appointment.id,
    appointmentEligibleStatuses: ELIGIBLE_STATUSES,
  });

  if (!gateResult.allowed) {
    await completeWorkflowExecutionAsService(supabase, executionId, {
      should_send: false,
      blocked_reason: gateResult.reason,
      blocked_detail: gateResult.detail ?? null,
      appointment_id: appointment.id,
    });
    return { appointmentId: appointment.id, outcome: "blocked", reason: gateResult.reason };
  }

  const sendResult = await sendOutboundMessage(supabase, {
    organizationId: appointment.organization_id,
    contactId: gateResult.contactId,
    conversationId: gateResult.conversationId,
    channel: "sms",
    body: gateResult.body,
    senderType: "ai",
    workflowExecutionId: executionId,
    sendSmsFn,
  });

  if (!sendResult.ok) {
    await failWorkflowExecutionAsService(supabase, executionId, sendResult.error);
    return { appointmentId: appointment.id, outcome: "failed", error: sendResult.error };
  }

  await completeWorkflowExecutionAsService(supabase, executionId, {
    should_send: true,
    message_id: sendResult.messageId,
    conversation_id: sendResult.conversationId,
    provider_message_id: sendResult.providerMessageId,
    appointment_id: appointment.id,
  });

  return { appointmentId: appointment.id, outcome: "sent", messageId: sendResult.messageId };
}

export type ReminderPreview =
  | { outcome: "would_send"; appointmentId: string; body: string }
  | { outcome: "no_candidates" }
  | { outcome: "no_contact"; appointmentId: string }
  | { outcome: "contact_opted_out"; appointmentId: string };

/**
 * Phase D dry run: a read-only preview, never a fake execution. Reuses the
 * exact same candidate-finding query and eligibility window as
 * processAppointmentReminders (scoped to one organization here, since this
 * is only ever called from a session-authenticated, single-org context -
 * see app/(app)/automations/actions.ts), and the same composeReminderBody()
 * used for a real send - but creates no automation_events/workflow_executions
 * row, and never calls sendOutboundMessage, evaluateOutboundGate, or any
 * provider/n8n code path. There is nothing here that could send a message:
 * the function does not import sendOutboundMessage or any Twilio/n8n
 * dependency at all.
 */
export async function previewAppointmentReminders(
  supabase: SupabaseClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<ReminderPreview> {
  const windowEnd = new Date(now.getTime() + REMINDER_LEAD_TIME_MS);

  const { data: rawCandidates } = await supabase
    .from("appointments")
    .select("id, organization_id, contact_id, lead_id, title, start_at, end_at, status, updated_at")
    .eq("organization_id", organizationId)
    .in("status", ELIGIBLE_STATUSES)
    .gt("start_at", now.toISOString())
    .lte("start_at", windowEnd.toISOString())
    .limit(500);

  const candidates = ((rawCandidates ?? []) as CandidateAppointment[]).filter((appointment) => {
    const dueAt = new Date(appointment.start_at).getTime() - REMINDER_LEAD_TIME_MS;
    return new Date(appointment.updated_at).getTime() <= dueAt;
  });

  const appointment = candidates[0];
  if (!appointment) {
    return { outcome: "no_candidates" };
  }

  if (!appointment.contact_id) {
    return { outcome: "no_contact", appointmentId: appointment.id };
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("sms_opt_out")
    .eq("id", appointment.contact_id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (contact?.sms_opt_out) {
    return { outcome: "contact_opted_out", appointmentId: appointment.id };
  }

  const businessProfile = await getBusinessProfile(supabase, organizationId);
  const timezone = businessProfile?.timezone ?? "UTC";
  const body = composeReminderBody(appointment, timezone);

  return { outcome: "would_send", appointmentId: appointment.id, body };
}

/**
 * Phase E retry redispatch for a failed appointment_reminder execution.
 * Deliberately duplicates processOneReminder's post-event-creation tail
 * (compose -> gate -> send -> complete/fail) rather than refactoring that
 * already-shipped function to share code, to guarantee zero behavior change
 * to the existing cron path - see the Phase E report. Never creates a new
 * automation_events row (the caller already reused the existing event via
 * start_workflow_execution) and never sends anything before the caller's
 * new execution row already exists. Uses the session-scoped
 * completeWorkflowExecution/failWorkflowExecution (not the AsService
 * variants) since retry always runs with a real admin session, re-verifying
 * is_org_member as defense in depth.
 *
 * Returns whether the retry handoff itself was successfully initiated -
 * NOT whether the underlying automation "eventually completed". A message
 * correctly BLOCKED by the outbound gate (e.g. the appointment is no longer
 * in an eligible status) is `{ ok: true }`: the retry mechanism did exactly
 * what it should. Only a genuine failure of the retry itself (missing
 * reference, entity no longer exists, the send call failing) is
 * `{ ok: false }`.
 */
export async function retryAppointmentReminder(
  supabase: SupabaseClient,
  event: { organizationId: string; entityType: string | null; entityId: string | null; payload: Record<string, unknown> },
  executionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const appointmentId =
    event.entityType === "appointment"
      ? event.entityId
      : typeof event.payload?.appointment_id === "string"
        ? (event.payload.appointment_id as string)
        : null;

  if (!appointmentId) {
    await failWorkflowExecution(supabase, executionId, "Missing appointment reference.");
    return { ok: false, error: "Missing appointment reference." };
  }

  const { data: appointment } = await supabase
    .from("appointments")
    .select("id, organization_id, contact_id, lead_id, title, start_at, end_at, status, updated_at")
    .eq("id", appointmentId)
    .eq("organization_id", event.organizationId)
    .maybeSingle();

  if (!appointment) {
    await failWorkflowExecution(supabase, executionId, "The appointment no longer exists.");
    return { ok: false, error: "The appointment no longer exists." };
  }

  const businessProfile = await getBusinessProfile(supabase, event.organizationId);
  const timezone = businessProfile?.timezone ?? "UTC";

  let conversationId: string | null = null;
  if (appointment.contact_id) {
    const conversation = await findOrCreateOpenConversation(
      supabase,
      event.organizationId,
      appointment.contact_id,
      "sms",
      appointment.lead_id,
    );
    conversationId = conversation?.id ?? null;
  }

  const body = composeReminderBody(appointment as CandidateAppointment, timezone);

  const gateResult = await evaluateOutboundGate(supabase, {
    organizationId: event.organizationId,
    executionId,
    contactId: appointment.contact_id,
    conversationId,
    leadId: appointment.lead_id,
    aiResult: { should_send: true, response_message: body, needs_human: false },
    appointmentId: appointment.id,
    appointmentEligibleStatuses: ELIGIBLE_STATUSES,
  });

  if (!gateResult.allowed) {
    await completeWorkflowExecution(supabase, executionId, {
      should_send: false,
      blocked_reason: gateResult.reason,
      blocked_detail: gateResult.detail ?? null,
      appointment_id: appointment.id,
    });
    return { ok: true };
  }

  const sendResult = await sendOutboundMessage(supabase, {
    organizationId: event.organizationId,
    contactId: gateResult.contactId,
    conversationId: gateResult.conversationId,
    channel: "sms",
    body: gateResult.body,
    senderType: "ai",
    workflowExecutionId: executionId,
  });

  if (!sendResult.ok) {
    await failWorkflowExecution(supabase, executionId, sendResult.error);
    return { ok: false, error: sendResult.error };
  }

  await completeWorkflowExecution(supabase, executionId, {
    should_send: true,
    message_id: sendResult.messageId,
    conversation_id: sendResult.conversationId,
    provider_message_id: sendResult.providerMessageId,
    appointment_id: appointment.id,
  });

  return { ok: true };
}
