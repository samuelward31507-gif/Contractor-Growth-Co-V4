import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateContentSafety } from "./content-safety";
import { E164_PATTERN } from "./sms";
import { getBusinessHours, getOrganizationTimezone, type BusinessHour } from "@/lib/settings/queries";
import type { AppointmentStatus } from "@/lib/appointments/queries";
import type { EstimateStatus } from "@/lib/estimates/queries";
import type { JobStatus } from "@/lib/jobs/queries";
import type { LeadStatus } from "@/lib/leads/queries";

const MAX_MESSAGE_LENGTH = 1600;

// Phase 4.9: the exact "active" status sets the lead-reactivation audit
// specified, reusing the existing status enums unchanged - not a new
// definition of "active" distinct from what the rest of the codebase means
// by those words (appointment reminders/estimate follow-ups/job kickoff all
// already use these same sets as their own eligible-statuses).
const ACTIVE_APPOINTMENT_STATUSES: AppointmentStatus[] = ["scheduled", "confirmed"];
const ACTIVE_ESTIMATE_STATUSES: EstimateStatus[] = ["sent", "accepted"];
const ACTIVE_JOB_STATUSES: JobStatus[] = ["scheduled", "in_progress"];

export type GateAiResult = {
  should_send: boolean;
  response_message: string | null;
  needs_human: boolean;
};

export type OutboundGateInput = {
  organizationId: string;
  executionId: string;
  contactId: string | null;
  conversationId: string | null;
  leadId: string | null;
  aiResult: GateAiResult;
  /**
   * Phase 4.4: when this send is about a specific appointment (confirmation,
   * reminder, no-show follow-up), the gate re-checks that appointment's
   * current state directly from the database - never trusting that it's
   * still eligible just because it was eligible when the automation event
   * was created. Omit both fields entirely for non-appointment sends
   * (customer replies, lead follow-ups) - no appointment check is performed.
   */
  appointmentId?: string | null;
  /** Required whenever appointmentId is set: the statuses this specific message type is allowed to send under right now. */
  appointmentEligibleStatuses?: AppointmentStatus[];
  /**
   * Phase 4.5: same pattern as appointmentId/appointmentEligibleStatuses
   * above, for estimate.sent-followup sends - re-checks the estimate's live
   * status (never trusting it's still 'sent' just because it was 'sent'
   * when the automation event/cron tick fired). Kept as a separate sibling
   * field rather than generalizing appointmentId/estimateId into one
   * "entity context" shape, to avoid touching the already-tested Phase 4.4
   * behavior for a refactor with no functional benefit.
   */
  estimateId?: string | null;
  /** Required whenever estimateId is set. */
  estimateEligibleStatuses?: EstimateStatus[];
  /**
   * Phase 4.6: same pattern as appointmentId/estimateId above, for
   * job.created-kickoff sends - re-checks the job's live status (a
   * completed/cancelled job can never receive the kickoff message, even if
   * it was 'scheduled' when the event/n8n dispatch first fired).
   */
  jobId?: string | null;
  /** Required whenever jobId is set. */
  jobEligibleStatuses?: JobStatus[];
  /**
   * Phase 4.8: same pattern as appointmentId/estimateId/jobId above, for
   * lead.lost_nurture sends - re-checks the lead's live status
   * immediately before sending (a lead that became active again after the
   * nurture event/cron tick fired must never receive the stale touch).
   * Only meaningful together with leadId (already an existing field, used
   * unconditionally for the lead/conversation consistency check below) -
   * omit leadEligibleStatuses entirely for sends where leadId is present
   * only for that consistency check, not for status eligibility (e.g.
   * appointment/estimate/job sends that happen to carry a lead_id).
   */
  leadEligibleStatuses?: LeadStatus[];
  /**
   * Phase 4.9: for lead.reactivation sends - re-checks, live, that the lead
   * still has no active appointment/estimate/job right before sending. The
   * audit found that leads.status is never auto-synced when an appointment/
   * estimate/job is created (no Server Action updates it), so a lead's
   * status alone cannot be trusted to reflect this - this performs its own
   * direct queries against appointments/estimates/jobs by lead_id, the same
   * "never trust it's still eligible just because it was eligible when the
   * cron tick fired" principle as every other *EligibleStatuses field above,
   * applied to "does this lead have any active engagement at all" rather
   * than "is this one specific entity still in an eligible status".
   */
  leadMustHaveNoActiveEngagement?: boolean;
  /**
   * Automation Configuration V2.2: when true, the gate additionally
   * requires the organization's configured business hours to be open right
   * now (see isWithinBusinessHours below) before allowing this send.
   * Omitted/false for every automation that hasn't opted in - zero
   * behavior change for anything else. The caller (the n8n callback route)
   * resolves this from that automation's own automation_settings.config at
   * evaluation time - read fresh on every call, never cached.
   */
  respectBusinessHours?: boolean;
  /**
   * Instant Lead Follow-Up V1 (Safe Automatic SMS): whether the automation
   * this event/execution belongs to is still enabled, re-checked live at
   * send time rather than trusted from when the event was first created.
   * createAutomationEvent()/createAutomationEventAsService() already check
   * this once at event-creation time and skip creating the event entirely
   * if disabled - this is a second, later check closing the narrow window
   * where a contractor disables an automation after its event/execution was
   * already created and dispatched to n8n, but before n8n's callback lands.
   * The caller resolves this via getAutomationForEventType/
   * getAutomationEnabled, the same lookup createAutomationEvent already
   * uses - never a second, divergent enable/disable mechanism. Omitted
   * (undefined) means "no automation-id could be resolved for this event
   * type" (e.g. an internal lifecycle marker with no catalog entry) and is
   * treated as no additional restriction, exactly like respectBusinessHours
   * being omitted - explicit `false` is the only value that blocks.
   */
  automationEnabled?: boolean;
};

export type OutboundGateDenialReason =
  | "should_not_send"
  | "needs_human"
  | "missing_response_message"
  | "response_message_too_long"
  | "unsafe_content"
  | "missing_contact_id"
  | "contact_not_found"
  | "contact_opted_out"
  | "missing_conversation_id"
  | "conversation_not_found"
  | "conversation_wrong_organization"
  | "conversation_not_sms"
  | "conversation_not_open"
  | "conversation_contact_mismatch"
  | "lead_not_found"
  | "lead_wrong_organization"
  | "lead_conversation_mismatch"
  | "execution_not_found"
  | "execution_wrong_organization"
  | "execution_not_eligible"
  | "duplicate_outbound_send"
  | "conversation_ai_disabled"
  | "organization_not_live"
  | "appointment_not_found"
  | "appointment_wrong_organization"
  | "appointment_status_ineligible"
  | "estimate_not_found"
  | "estimate_wrong_organization"
  | "estimate_status_ineligible"
  | "job_not_found"
  | "job_wrong_organization"
  | "job_status_ineligible"
  | "lead_status_ineligible"
  | "lead_has_active_engagement"
  | "outside_business_hours"
  | "automation_disabled"
  | "invalid_destination";

export type OutboundGateResult =
  | { allowed: true; contactId: string; conversationId: string; body: string }
  | { allowed: false; reason: OutboundGateDenialReason; detail?: string };

function deny(reason: OutboundGateDenialReason, detail?: string): OutboundGateResult {
  return { allowed: false, reason, detail };
}

function localDayOfWeek(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now).toLowerCase();
}

function localMinutesSinceMidnight(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** Reads only the "HH:MM" prefix - tolerant of both "09:00" and Postgres's "09:00:00" time-column serialization. */
function parseTimeToMinutes(time: string | null): number | null {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Automation Configuration V2.2: the pure decision behind whether "now" (in
 * the organization's own timezone) falls within its configured business
 * hours. Extracted so this can be unit tested directly with controlled
 * Date/timezone/hours inputs, without a mocked Supabase client or relying
 * on the real wall clock. Uses Intl.DateTimeFormat rather than a fixed UTC
 * offset, so it stays correct across DST transitions.
 *
 * An empty `hours` array means the organization has never configured any
 * business hours at all - per the V2.2 requirement, this must never
 * silently block a send, so it is treated as "always open" (requirement 6).
 * Once at least one day has been configured, every other day - including
 * one with no saved row at all, or an explicit is_open: false row - is
 * correctly "closed" and blocks the send (requirement 5). This is the same
 * distinction the config UI's "No business hours are configured" message is
 * keyed off of (hours.length === 0).
 *
 * The existing business-hours editor (app/(app)/settings/actions.ts)
 * rejects close_time <= open_time at save time, so no saved day can ever
 * span past midnight - this is intentionally a same-calendar-day comparison
 * only, with no overnight/wraparound handling, matching that constraint.
 */
export function isWithinBusinessHours(now: Date, timeZone: string, hours: BusinessHour[]): boolean {
  if (hours.length === 0) return true;

  const day = localDayOfWeek(now, timeZone);
  const today = hours.find((hour) => hour.day_of_week === day);
  if (!today || !today.is_open) return false;

  const openMinutes = parseTimeToMinutes(today.open_time);
  const closeMinutes = parseTimeToMinutes(today.close_time);
  if (openMinutes === null || closeMinutes === null) return false;

  const nowMinutes = localMinutesSinceMidnight(now, timeZone);
  return nowMinutes >= openMinutes && nowMinutes < closeMinutes;
}

/**
 * The single, centralized authority over whether an AI-drafted response is
 * actually allowed to reach a customer. n8n/the AI can only *recommend*
 * sending (`should_send: true`) - every condition here is re-derived from
 * Trackpr's own database, never trusted from the callback payload alone,
 * because a syntactically valid callback body proves nothing about whether
 * sending is actually safe right now. Called from the n8n callback route
 * only after that route has already authenticated the request and verified
 * the execution/event/organization relationship - this function re-checks
 * the organization scoping anyway, since "do not trust values coming from
 * n8n merely because they are syntactically valid" applies even to values
 * this same request already validated once.
 */
export async function evaluateOutboundGate(
  supabase: SupabaseClient,
  input: OutboundGateInput,
): Promise<OutboundGateResult> {
  const { aiResult } = input;

  if (!aiResult.should_send) return deny("should_not_send");

  // Human handoff default: needs_human=true always blocks sending in this
  // phase. There is no override mechanism yet - "unless the system
  // explicitly permits it" has nothing that permits it today, so this is an
  // unconditional block, not a soft signal.
  if (aiResult.needs_human) return deny("needs_human");

  // Instant Lead Follow-Up V1: explicit false blocks - undefined (no
  // automation-id resolvable for this event type) is not a restriction.
  if (input.automationEnabled === false) return deny("automation_disabled");

  const body = (aiResult.response_message ?? "").trim();
  if (!body) return deny("missing_response_message");
  if (body.length > MAX_MESSAGE_LENGTH) return deny("response_message_too_long");

  const contentSafety = evaluateContentSafety(body);
  if (!contentSafety.safe) return deny("unsafe_content", contentSafety.reason);

  if (!input.contactId) return deny("missing_contact_id");
  if (!input.conversationId) return deny("missing_conversation_id");

  const [{ data: contact }, { data: conversation }, { data: execution }, { data: organization }] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, organization_id, sms_opt_out, phone")
      .eq("id", input.contactId)
      .maybeSingle(),
    supabase
      .from("conversations")
      .select("id, organization_id, contact_id, lead_id, channel, status, ai_enabled")
      .eq("id", input.conversationId)
      .maybeSingle(),
    supabase
      .from("workflow_executions")
      .select("id, organization_id, status")
      .eq("id", input.executionId)
      .maybeSingle(),
    supabase
      .from("organizations")
      .select("automation_mode")
      .eq("id", input.organizationId)
      .maybeSingle(),
  ]);

  // Fast-Track Production Readiness, Pass 3: go-live protection. An
  // organization that has not been explicitly switched to 'live' (new
  // organizations default to 'test') can never have a customer-facing
  // automated message actually reach a customer - this can only ever add a
  // restriction on top of every other check in this function, never bypass
  // one. Manual CRM actions (creating leads/appointments/etc.) are
  // unaffected; only this send path is gated.
  if (organization?.automation_mode !== "live") return deny("organization_not_live");

  if (!contact || contact.organization_id !== input.organizationId) return deny("contact_not_found");
  if (contact.sms_opt_out) return deny("contact_opted_out");
  // Same E.164 shape check sendSms() itself applies (lib/automation/sms.ts) -
  // duplicated here as a named, deterministic gate reason so an invalid
  // destination is denied before ever reaching the provider boundary,
  // rather than only surfacing as a generic provider-rejection error one
  // layer later. sendSms()'s own check remains in place unchanged as
  // defense-in-depth for any caller that reaches it directly.
  if (!contact.phone || !E164_PATTERN.test(contact.phone.trim())) return deny("invalid_destination");

  if (!conversation) return deny("conversation_not_found");
  if (conversation.organization_id !== input.organizationId) return deny("conversation_wrong_organization");
  if (conversation.channel !== "sms") return deny("conversation_not_sms");
  if (conversation.status !== "open") return deny("conversation_not_open");
  if (conversation.contact_id !== input.contactId) return deny("conversation_contact_mismatch");

  // Fast-Track Production Readiness, Pass 2: durable needs_human lockout.
  // conversations.ai_enabled already exists and already has a staff-facing
  // "Enable AI" / "Disable AI" toggle (app/(app)/conversations/[id]/_components/
  // conversation-actions.tsx) - it was just never consulted before a send.
  // The n8n callback route now sets it false the moment any AI result comes
  // back with needs_human:true (see that route), which makes this a real,
  // persistent lock: unlike the earlier aiResult.needs_human check above
  // (which only blocks the one message that triggered it), this blocks
  // every future automated send into this conversation - across every
  // automation type, not only customer replies - until a human explicitly
  // re-enables AI using the exact same toggle they already have today.
  if (conversation.ai_enabled === false) return deny("conversation_ai_disabled");

  if (input.leadId) {
    const { data: lead } = await supabase
      .from("leads")
      .select("id, organization_id, status")
      .eq("id", input.leadId)
      .maybeSingle();

    if (!lead) return deny("lead_not_found");
    if (lead.organization_id !== input.organizationId) return deny("lead_wrong_organization");
    if (conversation.lead_id !== input.leadId) return deny("lead_conversation_mismatch");

    if (input.leadEligibleStatuses) {
      if (!input.leadEligibleStatuses.includes(lead.status as LeadStatus)) {
        return deny("lead_status_ineligible", `lead status is ${lead.status}`);
      }
    }

    if (input.leadMustHaveNoActiveEngagement) {
      const [{ data: activeAppointment }, { data: activeEstimate }, { data: activeJob }] = await Promise.all([
        supabase
          .from("appointments")
          .select("id")
          .eq("lead_id", input.leadId)
          .eq("organization_id", input.organizationId)
          .in("status", ACTIVE_APPOINTMENT_STATUSES)
          .limit(1)
          .maybeSingle(),
        supabase
          .from("estimates")
          .select("id")
          .eq("lead_id", input.leadId)
          .eq("organization_id", input.organizationId)
          .in("status", ACTIVE_ESTIMATE_STATUSES)
          .limit(1)
          .maybeSingle(),
        supabase
          .from("jobs")
          .select("id")
          .eq("lead_id", input.leadId)
          .eq("organization_id", input.organizationId)
          .in("status", ACTIVE_JOB_STATUSES)
          .limit(1)
          .maybeSingle(),
      ]);

      if (activeAppointment) return deny("lead_has_active_engagement", "lead has an active appointment");
      if (activeEstimate) return deny("lead_has_active_engagement", "lead has an active estimate");
      if (activeJob) return deny("lead_has_active_engagement", "lead has an active job");
    }
  }

  if (!execution) return deny("execution_not_found");
  if (execution.organization_id !== input.organizationId) return deny("execution_wrong_organization");
  if (execution.status !== "running") return deny("execution_not_eligible");

  // Fast-path duplicate check - the real, race-proof guarantee is the
  // partial unique index on messages(workflow_execution_id) WHERE
  // direction = 'outbound', enforced at the database level and handled by
  // sendOutboundMessage() if this check and a concurrent request both pass
  // it at the same time.
  const { data: existingOutbound } = await supabase
    .from("messages")
    .select("id")
    .eq("workflow_execution_id", input.executionId)
    .eq("direction", "outbound")
    .maybeSingle();

  if (existingOutbound) return deny("duplicate_outbound_send");

  if (input.appointmentId) {
    const { data: appointment } = await supabase
      .from("appointments")
      .select("id, organization_id, status")
      .eq("id", input.appointmentId)
      .maybeSingle();

    if (!appointment) return deny("appointment_not_found");
    if (appointment.organization_id !== input.organizationId) return deny("appointment_wrong_organization");

    const eligible = input.appointmentEligibleStatuses ?? [];
    if (!eligible.includes(appointment.status as AppointmentStatus)) {
      return deny("appointment_status_ineligible", `appointment status is ${appointment.status}`);
    }
  }

  if (input.estimateId) {
    const { data: estimate } = await supabase
      .from("estimates")
      .select("id, organization_id, status")
      .eq("id", input.estimateId)
      .maybeSingle();

    if (!estimate) return deny("estimate_not_found");
    if (estimate.organization_id !== input.organizationId) return deny("estimate_wrong_organization");

    const eligible = input.estimateEligibleStatuses ?? [];
    if (!eligible.includes(estimate.status as EstimateStatus)) {
      return deny("estimate_status_ineligible", `estimate status is ${estimate.status}`);
    }
  }

  if (input.jobId) {
    const { data: job } = await supabase
      .from("jobs")
      .select("id, organization_id, status")
      .eq("id", input.jobId)
      .maybeSingle();

    if (!job) return deny("job_not_found");
    if (job.organization_id !== input.organizationId) return deny("job_wrong_organization");

    const eligible = input.jobEligibleStatuses ?? [];
    if (!eligible.includes(job.status as JobStatus)) {
      return deny("job_status_ineligible", `job status is ${job.status}`);
    }
  }

  // Automation Configuration V2.2: runs last, after every other check above
  // has already passed - this can only ever additionally narrow an
  // otherwise-allowed send, never bypass opt-out, content safety,
  // needs_human, duplicate-send protection, or any execution/organization
  // validation above it. Read fresh on every call - no caching.
  if (input.respectBusinessHours) {
    const [hours, timeZone] = await Promise.all([
      getBusinessHours(supabase, input.organizationId),
      getOrganizationTimezone(supabase, input.organizationId),
    ]);
    if (!isWithinBusinessHours(new Date(), timeZone ?? "UTC", hours)) {
      return deny("outside_business_hours");
    }
  }

  return { allowed: true, contactId: input.contactId, conversationId: input.conversationId, body };
}
