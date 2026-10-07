import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAutomationEnabled,
  getAutomationConfig,
  getAutomationConfigByOrganization,
  readAppointmentReminderConfig,
  REMINDER_LEAD_TIME_MAX_HOURS,
  type AppointmentReminderConfig,
} from "./settings";
import { SESSION_EXECUTION_OPS, type ExecutionOps } from "./executions";
import { runDerivedTouch, retryDerivedTouch, type DerivedTouchAdapter } from "./touch-runtime";
import type { ExecutionContext } from "@/lib/followups/engine";
import { getBusinessProfile } from "@/lib/settings/queries";
import { formatAppointmentDate, formatAppointmentTimeRange } from "@/lib/appointments/format";
import type { AppointmentStatus } from "@/lib/appointments/queries";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";
import { readAllPages } from "@/lib/bi/revenue-attribution";

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
 * contractor confirm, or an earlier customer CONFIRM) - a customer who already
 * confirmed should just get a plain factual reminder, never asked again.
 *
 * The ask is "Reply CONFIRM", never a YES: a bare "YES" is a carrier
 * START keyword (lib/messaging/keywords.ts), consumed by the inbound
 * compliance layer before any confirmation handling runs, so a customer who
 * followed such an instruction could never be confirmed.
 */
export function composeReminderBody(appointment: CandidateAppointment, timezone: string): string {
  const dateLabel = formatAppointmentDate(appointment.start_at, timezone);
  const timeLabel = formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timezone);
  const confirmationAsk = appointment.status === "confirmed" ? "" : " Reply CONFIRM to confirm, or let us know if you need to reschedule.";
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
  triggerSource: ReminderRunTriggerSource = "event",
): Promise<ReminderRunResult> {
  const configByOrg = await getAutomationConfigByOrganization(supabase, "appointment-reminders");

  const maxWindowMs = REMINDER_LEAD_TIME_MAX_HOURS * 60 * 60 * 1000;
  const windowEnd = new Date(now.getTime() + maxWindowMs);

  // Phase 3 (W2): every upcoming appointment in the reminder window, paged in a stable order - the old single
  // read was capped at 500 rows across every organization. Window-based, so there is no backlog to guard. A
  // failed page stops the run with nothing processed.
  const read = await readAllPages<CandidateAppointment>(() =>
    supabase
      .from("appointments")
      .select("id, organization_id, contact_id, lead_id, title, start_at, end_at, status, updated_at")
      .in("status", ELIGIBLE_STATUSES)
      .gt("start_at", now.toISOString())
      .lte("start_at", windowEnd.toISOString())
      .order("start_at")
      .order("id"),
  );
  if (read.failed) {
    throw new Error("Appointment reminders: the candidate read failed or reached the row limit - no appointment was processed.");
  }

  const candidates = read.rows.filter((appointment) => {
    const config = readAppointmentReminderConfig(configByOrg.get(appointment.organization_id) ?? null);
    return isReminderDue(appointment, config, now);
  });

  const outcomes: ReminderOutcome[] = [];

  for (const appointment of candidates) {
    const config = readAppointmentReminderConfig(configByOrg.get(appointment.organization_id) ?? null);
    outcomes.push(await processOneReminder(supabase, appointment, config, now, sendSmsFn, triggerSource));
  }

  return { candidates: candidates.length, outcomes };
}

/** How a reminder run was initiated: the cron tick ("event") or an admin's Run now ("manual"). A2 owns "retry". */
export type ReminderRunTriggerSource = ExecutionContext["triggerSource"];

/** One appointment reminder. `config` is null only on an A2 retry, which never re-evaluates the reminder window. */
type ReminderItem = { appointment: CandidateAppointment; config: AppointmentReminderConfig | null };

/**
 * P0-B B2.6: appointment reminders' kind adapter for the shared touch
 * runtime (lib/automation/touch-runtime.ts). Every value is this
 * automation's existing behavior: one reminder per (appointment, start_at)
 * under the legacy key appointment.reminder:<id>:<start_at> - a reschedule
 * is a new start_at, so a new reminder; due inside the organization's
 * reminder_lead_time_hours window before start_at, and only once that
 * start_at has been in place since the reminder's own due point
 * (isReminderDue); no lateness rule (window-based - a past appointment is
 * never due); no engagement, payment or business-hours rule and no enabled
 * re-check at the gate; the gate re-checks the appointment is still
 * scheduled/confirmed; the deterministic message in the organization's
 * timezone; sender "ai"; {appointment_id} on every execution. A contact that
 * is not the organization's is recorded as blocked contact_not_found
 * (B2.5a). The confirmation_requested_at write is NOT here - it is the
 * producer's, after a sent reminder.
 */
export const APPOINTMENT_REMINDER_ADAPTER: DerivedTouchAdapter<ReminderItem, { timezone: string }> = {
  identity: { automationId: "appointment-reminders", eventType: "appointment.reminder", workflowName: APPOINTMENT_REMINDER_WORKFLOW },
  policy: { requiresActivePayment: false, stale: { mode: "none" }, missingSubject: "record_blocked", gateChecksAutomationEnabled: false, senderType: "ai" },
  subject: ({ appointment }) => ({ organizationId: appointment.organization_id, contactId: appointment.contact_id, leadId: appointment.lead_id, entityType: "appointment", entityId: appointment.id }),
  idempotencyKey: ({ appointment }) => `appointment.reminder:${appointment.id}:${appointment.start_at}`,
  isDue: ({ appointment, config }, now) => config !== null && isReminderDue(appointment, config, now),
  dueAt: ({ appointment, config }) => {
    if (!config) throw new Error("appointment reminder: no reminder window for this touch");
    return { anchorMs: new Date(appointment.start_at).getTime(), delayMs: -config.reminder_lead_time_hours * 60 * 60 * 1000 };
  },
  // Nothing is re-checked before the claim (the gate re-checks the appointment); the facts are the organization's timezone for the message.
  stillOwed: async (service, { appointment }) => {
    const businessProfile = await getBusinessProfile(service, appointment.organization_id);
    return { owed: true, facts: { timezone: businessProfile?.timezone ?? "UTC" } };
  },
  payload: ({ appointment }) => ({ appointment_id: appointment.id, contact_id: appointment.contact_id, lead_id: appointment.lead_id, start_at: appointment.start_at }),
  compose: ({ appointment }, { timezone }) => composeReminderBody(appointment, timezone),
  gateOptions: ({ appointment }) => ({ appointmentId: appointment.id, appointmentEligibleStatuses: ELIGIBLE_STATUSES }),
  auditFields: ({ appointment }) => ({ appointment_id: appointment.id }),
};

async function processOneReminder(
  supabase: SupabaseClient,
  appointment: CandidateAppointment,
  config: AppointmentReminderConfig,
  now: Date,
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
  triggerSource: ReminderRunTriggerSource = "event",
): Promise<ReminderOutcome> {
  const appointmentId = appointment.id;
  // P0-B B2.6: the reminder itself runs the shared derived touch runtime -
  // kill switch (read per appointment, as before), still due, B1
  // verification, claim (the legacy key + B0), compose, gate, send, record.
  const result = await runDerivedTouch(supabase, APPOINTMENT_REMINDER_ADAPTER, { appointment, config }, now, {
    isEnabled: (organizationId) => getAutomationEnabled(supabase, organizationId, "appointment-reminders"),
    context: { triggerSource },
    sendSmsFn,
  });

  switch (result.status) {
    case "sent": {
      // Pass 5B, Part A1/A2: materializes "a confirmation request genuinely
      // reached this customer" onto the row itself, only when the reminder
      // actually included the confirmation ask (i.e. wasn't already confirmed) -
      // see composeReminderBody's own comment. Only after a reminder that was
      // actually sent. Best-effort: a failure to record this must never be
      // treated as the send itself failing, since the message has already
      // been genuinely sent by this point.
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
      return { appointmentId, outcome: "sent", messageId: result.messageId };
    }
    case "blocked":
      return { appointmentId, outcome: "blocked", reason: result.reason };
    case "failed":
      return { appointmentId, outcome: "failed", error: result.error };
    case "lifecycle_failed":
      return { appointmentId, outcome: "failed", error: `lifecycle_snapshot_failed: ${result.error}` };
    case "skipped_duplicate":
    case "skipped_disabled":
      return { appointmentId, outcome: result.status };
    default:
      // Unreachable for a scanned candidate under this kind's policy (due at the same instant, no payment check, record_blocked missing subject, always owed); never a success.
      return { appointmentId, outcome: "failed", error: `unexpected_touch_status:${result.status}` };
  }
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
    // Phase 3 (W2): the preview shows the next due reminder - soonest first, never an arbitrary capped row.
    .order("start_at")
    .order("id")
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
  /** P0 A2: SERVICE_EXECUTION_OPS for the automatic retry; the session pair otherwise. */
  ops: ExecutionOps = SESSION_EXECUTION_OPS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const appointmentId =
    event.entityType === "appointment"
      ? event.entityId
      : typeof event.payload?.appointment_id === "string"
        ? (event.payload.appointment_id as string)
        : null;

  if (!appointmentId) {
    await ops.fail(supabase, executionId, "Missing appointment reference.");
    return { ok: false, error: "Missing appointment reference." };
  }

  const { data: appointment } = await supabase
    .from("appointments")
    .select("id, organization_id, contact_id, lead_id, title, start_at, end_at, status, updated_at")
    .eq("id", appointmentId)
    .eq("organization_id", event.organizationId)
    .maybeSingle();

  if (!appointment) {
    await ops.fail(supabase, executionId, "The appointment no longer exists.");
    return { ok: false, error: "The appointment no longer exists." };
  }

  // P0-B B2.6: the reminder's retry runs the shared retry entry - subject +
  // B1 verification (an unknown lifecycle fails this execution), the
  // organization's timezone, then the shared gate/send spine with A2's ops,
  // composed from the appointment as it is now. The reminder window is never
  // re-evaluated on a retry, and a retry never writes confirmation_requested_at
  // (it never did).
  return retryDerivedTouch(supabase, APPOINTMENT_REMINDER_ADAPTER, { appointment: appointment as CandidateAppointment, config: null }, executionId, ops);
}
