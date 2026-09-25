import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import {
  getAutomationEnabled,
  getAutomationConfig,
  getAutomationConfigByOrganization,
  readAppointmentReminderConfig,
  REMINDER_LEAD_TIME_MAX_HOURS,
  type AppointmentReminderConfig,
} from "./settings";
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
 *
 * Pass 5B, Part A2: extends this SAME existing reminder to also ask for
 * confirmation, rather than building a second, competing reminder/
 * confirmation-request system - per that pass's own explicit instruction.
 * Only asks when the appointment isn't already 'confirmed' (a manual
 * contractor confirm, or an earlier customer YES) - a customer who already
 * confirmed should just get a plain factual reminder, never asked again.
 */
function composeReminderBody(appointment: CandidateAppointment, timezone: string): string {
  const dateLabel = formatAppointmentDate(appointment.start_at, timezone);
  const timeLabel = formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timezone);
  const confirmationAsk = appointment.status === "confirmed" ? "" : " Reply YES to confirm, or let us know if you need to reschedule.";
  return `Reminder: your appointment "${appointment.title}" is scheduled for ${dateLabel} at ${timeLabel}.${confirmationAsk} Reply STOP to opt out of texts.`;
}

/**
 * Finds appointments due for their configured-lead-time-before reminder
 * right now, and for each one: creates the appointment.reminder automation
 * event/execution (idempotent per appointment+start_at - see idempotencyKey
 * below), sends the reminder through the exact same safe outbound gate +
 * sendOutboundMessage path every other automated message uses, and
 * completes/fails the execution accordingly. Designed to be called
 * repeatedly on a schedule (see app/api/automation/appointment-reminders/
 * route.ts) - every step is idempotent, so calling this twice in the same
 * window is always safe.
 *
 * Automation Configuration V1: reminder_lead_time_hours is per-organization
 * (automation_settings.config), defaulting to 24 for any organization that
 * hasn't configured it - identical to the hardcoded behavior before this
 * setting existed. Since this single query spans every organization at
 * once (the real cron path), the SQL pre-filter widens to the maximum
 * possible configured value (REMINDER_LEAD_TIME_MAX_HOURS) so it can never
 * exclude a row some organization's own configured window would still
 * consider due; the exact per-organization window is then re-applied as an
 * in-memory filter below, using getAutomationConfigByOrganization's map -
 * the same "narrow a wider SQL fetch with an in-memory check" pattern this
 * function already used for the updated_at/dueAt guard. This means a
 * cron-wide scan may now fetch more candidate rows than before (up to the
 * existing 500-row cap) when any organization configures a long lead time -
 * an accepted, documented tradeoff for V1, not a correctness issue.
 *
 * Eligibility, computed entirely from existing columns (no new schema):
 * - status is 'scheduled' or 'confirmed' (never cancelled/completed/no_show)
 * - start_at is between now and now+leadTime (the reminder is "due")
 * - updated_at is at or before start_at-leadTime - i.e. this appointment's
 *   current start_at has been in place for at least the configured lead
 *   time already. This is the guard against inventing a "historical"
 *   reminder: an appointment created or rescheduled with less notice than
 *   the configured lead time never gets a reminder fired immediately just
 *   because the threshold has already technically passed - see the Phase
 *   4.4 report for the documented limitation (updated_at is a proxy for
 *   "when this start_at was set", not a dedicated column, since the schema
 *   has none).
 */
/**
 * The pure eligibility check behind both processAppointmentReminders and
 * previewAppointmentReminders below - extracted so "an appointment's own
 * configured lead time is what decides whether it's due" can be unit tested
 * directly, without standing up a mocked Supabase client. Takes an
 * already-resolved AppointmentReminderConfig (never a raw/unknown value) -
 * callers are responsible for resolving each appointment's own organization's
 * config via readAppointmentReminderConfig first.
 */
export function isReminderDue(
  appointment: Pick<CandidateAppointment, "start_at" | "updated_at">,
  config: AppointmentReminderConfig,
  now: Date,
): boolean {
  const leadTimeMs = config.reminder_lead_time_hours * 60 * 60 * 1000;
  const startAtMs = new Date(appointment.start_at).getTime();
  const nowMs = now.getTime();
  const withinWindow = startAtMs > nowMs && startAtMs <= nowMs + leadTimeMs;
  const dueAt = startAtMs - leadTimeMs;
  const isStable = new Date(appointment.updated_at).getTime() <= dueAt;
  return withinWindow && isStable;
}

export async function processAppointmentReminders(
  supabase: SupabaseClient,
  now: Date = new Date(),
  /** Test seam only - production callers must never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
  /** Phase D: "manual" when triggered by an org admin's "Run now" action; every real cron tick omits this and keeps the column's own 'event' default. */
  triggerSource: WorkflowExecutionTriggerSource = "event",
): Promise<ReminderRunResult> {
  const configByOrg = await getAutomationConfigByOrganization(supabase, "appointment-reminders");

  const maxWindowMs = REMINDER_LEAD_TIME_MAX_HOURS * 60 * 60 * 1000;
  const windowEnd = new Date(now.getTime() + maxWindowMs);

  const { data: rawCandidates } = await supabase
    .from("appointments")
    .select("id, organization_id, contact_id, lead_id, title, start_at, end_at, status, updated_at")
    .in("status", ELIGIBLE_STATUSES)
    .gt("start_at", now.toISOString())
    .lte("start_at", windowEnd.toISOString())
    .limit(500);

  const candidates = ((rawCandidates ?? []) as CandidateAppointment[]).filter((appointment) => {
    const config = readAppointmentReminderConfig(configByOrg.get(appointment.organization_id) ?? null);
    return isReminderDue(appointment, config, now);
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
    await failWorkflowExecutionAsService(supabase, executionId, sendResult.error, "sms_send_failed");
    return { appointmentId: appointment.id, outcome: "failed", error: sendResult.error };
  }

  // Pass 5B, Part A1/A2: materializes "a confirmation request genuinely
  // reached this customer" onto the row itself, only when the reminder
  // actually included the confirmation ask (i.e. wasn't already confirmed) -
  // see composeReminderBody's own comment. Best-effort: a failure to record
  // this must never be treated as the send itself failing, since the
  // message has already been genuinely sent by this point.
  if (appointment.status !== "confirmed") {
    const { error: requestedAtError } = await supabase
      .from("appointments")
      .update({ confirmation_requested_at: new Date().toISOString() })
      .eq("id", appointment.id)
      .eq("organization_id", appointment.organization_id);
    if (requestedAtError) {
      console.error("[automation] failed to record confirmation_requested_at", { appointmentId: appointment.id, error: requestedAtError.message });
    }
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
  const rawConfig = await getAutomationConfig(supabase, organizationId, "appointment-reminders");
  const config = readAppointmentReminderConfig(rawConfig);
  const leadTimeMs = config.reminder_lead_time_hours * 60 * 60 * 1000;

  const windowEnd = new Date(now.getTime() + leadTimeMs);

  const { data: rawCandidates } = await supabase
    .from("appointments")
    .select("id, organization_id, contact_id, lead_id, title, start_at, end_at, status, updated_at")
    .eq("organization_id", organizationId)
    .in("status", ELIGIBLE_STATUSES)
    .gt("start_at", now.toISOString())
    .lte("start_at", windowEnd.toISOString())
    .limit(500);

  const candidates = ((rawCandidates ?? []) as CandidateAppointment[]).filter((appointment) => isReminderDue(appointment, config, now));

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
    await failWorkflowExecution(supabase, executionId, sendResult.error, "sms_send_failed");
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
