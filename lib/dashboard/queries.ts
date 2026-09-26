import type { SupabaseClient } from "@supabase/supabase-js";
import { formatCurrency, formatRelativeTime } from "./format";
import { getCalendarConnection } from "@/lib/calendar/connection";
import { getConversations, getLastMessagesByConversation, attachLastMessages } from "@/lib/conversations/queries";
import type { IncidentStatus } from "@/lib/automation-health/types";
import { getOpenOpportunities } from "@/lib/opportunities/queries";

/** Q7 (pre-launch lead-leak audit): a lead below "hot" temperature but at or above this estimated value is still worth surfacing - hotLeads alone ignores value entirely. Deliberately a plain, documented constant rather than a per-organization setting - the smallest correction that fixes the real prioritization gap without building a new configuration surface. */
const HIGH_VALUE_THRESHOLD = 5000;

export type PipelineStage = "new" | "contacted" | "qualified" | "appointment" | "estimate" | "won";

export const PIPELINE_STAGES: { stage: PipelineStage; label: string }[] = [
  { stage: "new", label: "Lead" },
  { stage: "contacted", label: "Contacted" },
  { stage: "qualified", label: "Qualified" },
  { stage: "appointment", label: "Appointment" },
  { stage: "estimate", label: "Estimate" },
  { stage: "won", label: "Won" },
];

const ACTIVE_LEAD_STATUSES = new Set<string>(["new", "contacted", "qualified", "appointment", "estimate"]);

/**
 * Pass 5C, Batch 3A: the exact real-data replacement for every place this
 * file used to read `leads.status === "appointment"` / `"estimate"` as a
 * proxy for "this lead has a real appointment/estimate." The Pass 5C Batch 3
 * audit traced every write site for `leads.status` in this codebase and
 * confirmed there are exactly two: the generic manual lead-edit Server
 * Action (app/(app)/leads/actions.ts's updateLead), and the one automated
 * transition to 'won' when a job is created from an accepted estimate
 * (lib/automation/jobs.ts). Nothing automatically advances a lead's status
 * to 'appointment' when a real appointment is booked, or to 'estimate' when
 * a real estimate is created - so `leads.status` alone silently undercounts
 * both stages whenever a lead's status field was never manually touched,
 * which is the common case. These two functions replace that proxy with the
 * real underlying relationship, exactly mirroring the same
 * "leads -> real appointments/estimates by lead_id" cross-reference pattern
 * lib/bi/metrics.ts's own getLeadBookingCrossReference already established
 * and proved correct.
 *
 * Semantics (documented once, here, since three call sites below all need
 * the identical definition to avoid the dashboard showing self-contradicting
 * numbers for the same underlying population):
 *
 *   "booked" (pipeline.appointment) - a lead with at least one real
 *   appointment (appointments.lead_id) whose status has not fallen through -
 *   i.e. NOT 'cancelled' and NOT 'no_show'. 'scheduled'/'confirmed'/
 *   'completed' all count: the lead genuinely got a real appointment, and a
 *   completed visit is still "this lead had an appointment," not a reason to
 *   un-count it. This deliberately does NOT try to model "currently only
 *   upcoming" - that's a distinct, narrower question the existing
 *   `upcomingAppointments` overview field (real appointments.start_at in the
 *   future, unchanged by this pass) already answers on its own terms.
 *
 *   "quoted" / "pending estimate" (pipeline.estimate, overview.pendingEstimates,
 *   the pending_estimate attention item) - a lead with at least one real
 *   estimate (estimates.lead_id) whose status is 'sent' - genuinely awaiting
 *   a customer decision right now. This reuses the exact same "sent = still
 *   pending" convention already established and proven elsewhere in this
 *   codebase (lib/briefing/queries.ts's estimatesAwaitingAction,
 *   lib/bi/queries.ts's sentEstimates/sentEstimateValue) rather than
 *   inventing a third, divergent definition of "pending." 'draft' is
 *   deliberately excluded - a draft estimate hasn't been sent to the
 *   customer yet, so there is nothing yet for them to be "pending" on.
 *   'accepted'/'declined'/'cancelled'/'expired' are all real, decided
 *   outcomes, not pending ones.
 *
 * A lead can now legitimately appear in more than one pipeline bucket at
 * once (e.g. still `leads.status = 'qualified'` while also having a real,
 * active appointment) - this is more accurate to reality than the previous
 * behavior, not a regression: PipelineRail (app/(app)/dashboard/_components/
 * pipeline-rail.tsx) already renders each stage as its own independent
 * "does this stage currently hold anyone" indicator, never a percentage-of-
 * total or a strict partition, so overlapping counts were always a safe,
 * intended shape for this component.
 */
const BOOKED_APPOINTMENT_STATUSES = new Set(["scheduled", "confirmed", "completed"]);
const PENDING_ESTIMATE_STATUS = "sent";

function distinctLeadIdsWithBookedAppointment(appointments: { lead_id: string | null; status: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const appointment of appointments) {
    if (appointment.lead_id && BOOKED_APPOINTMENT_STATUSES.has(appointment.status)) {
      ids.add(appointment.lead_id);
    }
  }
  return ids;
}

function distinctLeadIdsWithPendingEstimate(estimates: { lead_id: string | null; status: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const estimate of estimates) {
    if (estimate.lead_id && estimate.status === PENDING_ESTIMATE_STATUS) {
      ids.add(estimate.lead_id);
    }
  }
  return ids;
}

export type OverviewMetrics = {
  newLeads: number;
  upcomingAppointments: number;
  /** Trackpr 2.0, Phase 4C (P2 #9): COUNT(estimates) where status = 'sent' - the exact same real-world number as Analytics' BiEstimateMetrics.sentEstimates, never a distinct-lead count (see the computation site in getDashboardData for the full history). */
  pendingEstimates: number;
  openOpportunities: number;
};

export type PipelineCounts = Record<PipelineStage, number>;

export type AttentionItem = {
  id: string;
  kind:
    | "overdue_appointment"
    | "hot_lead"
    | "high_value_lead"
    | "pending_estimate"
    | "calendar_disconnected"
    | "human_escalation"
    | "awaiting_reply"
    // Pass 3 (Revenue Intelligence Foundation): backed by the new
    // opportunities table (lib/opportunities/queries.ts's
    // getOpenOpportunities), not a second, independent detection path -
    // see this file's own getDashboardData for exactly which opportunity
    // types feed which kind and why qualified_lead_unbooked/
    // completed_appointment_no_estimate deliberately do NOT get their own
    // kind here (they would duplicate hot_lead/high_value_lead/
    // pending_estimate, which already surface that same underlying lead).
    | "stale_estimate"
    | "dormant_customer"
    | "no_show"
    // Pass 5B: directly computed from appointments (confirmation_requested_at
    // set, confirmed_at still null, still status='scheduled') - deliberately
    // NOT opportunity-backed. Unlike stale_estimate/dormant_customer, this
    // condition is inherently short-lived: within roughly a day it resolves
    // itself one way or another (confirmed, rescheduled, cancelled, or an
    // automatic no-show), so it doesn't need a persisted dismiss/resolve
    // lifecycle - it's recomputed fresh from live appointment state on every
    // load, the same shape overdue_appointment/calendar_disconnected below
    // already use for their own directly-computed items.
    | "awaiting_confirmation"
    // Pass 5C, Batch 1: the mirror-image of awaiting_reply - see
    // abandonedConversations' own comment below for the full reasoning.
    // Also directly computed, never opportunity-backed, never persisted.
    | "abandoned_conversation"
    // Trackpr 2.0, Phase 2A: the 5 remaining opportunity types that had no
    // dashboard attention kind at all before this pass (see this file's own
    // getDashboardData for exactly which opportunity type feeds each one,
    // their priority placement, and the one new dedup rule this pass adds -
    // uncontacted_lead against hot_lead/high_value_lead's own lead
    // population). qualified_lead_unbooked and completed_appointment_no_estimate
    // remain deliberately unrepresented here, unchanged from before this
    // pass - they still duplicate hot_lead/high_value_lead/pending_estimate.
    | "accepted_estimate_no_job"
    | "uncontacted_lead"
    | "cancelled_appointment_no_rebooking"
    | "completed_job_no_review_request"
    | "completed_job_no_referral_request";
  title: string;
  detail: string;
  value: string | null;
  href: string;
  /** HANDOFF-01: only present for kind:"human_escalation" - lets the dashboard render the existing acknowledge/resolve incident controls inline without a second lookup. */
  incidentId?: string;
  incidentStatus?: IncidentStatus;
  /** Pass 3: only present for the three opportunity-backed kinds above - lets the dashboard render the existing dismiss action inline without a second lookup. */
  opportunityId?: string;
};

export type ActivityItem = {
  id: string;
  message: string;
  timestamp: string;
};

export type DashboardData = {
  overview: OverviewMetrics;
  pipeline: PipelineCounts;
  attentionItems: AttentionItem[];
  recentActivity: ActivityItem[];
  /**
   * Trackpr 2.0, Phase 2B: true when at least one of this function's own
   * direct reads (leads/appointments/estimates/audit_log/
   * automation_incidents) returned a real PostgREST error rather than a
   * genuinely empty result. A successful `{ data: [], error: null }`
   * response NEVER sets this - "no data" and "the read failed" are and
   * remain two different things. Never carries the raw error itself (no
   * message, no table name, no stack trace) - see partialDataSourceCount for
   * the one bounded, non-identifying number this does expose.
   *
   * Scope, disclosed: this only covers the 5 reads getDashboardData issues
   * directly. The other 4 reads it depends on - getCalendarConnection,
   * getConversations, getLastMessagesByConversation, getOpenOpportunities -
   * each already discards its own error internally (`data ?? []`/`?? null`)
   * inside its own module (lib/calendar/connection.ts, lib/conversations/
   * queries.ts, lib/opportunities/queries.ts), and this phase's authorized
   * file scope does not include those modules - closing that gap would
   * require changing files outside this change's boundary, so it is left
   * open and named here rather than silently left uncovered.
   */
  partialData: boolean;
  /** Count (0-5) of which of this function's own 5 direct reads failed - bounded, non-identifying, for future debugging only. Never rendered to the end user as a specific number. */
  partialDataSourceCount: number;
};

type ContactRef = { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null;

function contactName(contact: ContactRef): string | null {
  const row = Array.isArray(contact) ? contact[0] : contact;
  if (!row) return null;
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

function formatAuditAction(action: string, entityType: string | null): string {
  const readable = action.replace(/_/g, " ");
  const subject = entityType ? ` (${entityType})` : "";
  return readable.charAt(0).toUpperCase() + readable.slice(1) + subject;
}

/**
 * Loads everything the dashboard needs in three parallel, org-scoped queries
 * (RLS also enforces the org boundary; the explicit `organization_id` filter
 * here just keeps the queries efficient and their intent obvious) and derives
 * every metric, pipeline count, attention item, and activity entry from that
 * real data - nothing here is fabricated or hardcoded.
 */
export async function getDashboardData(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<DashboardData> {
  const [leadsResult, appointmentsResult, estimatesResult, auditResult, calendarConnection, escalationIncidentsResult, conversations, lastMessages, openOpportunities] = await Promise.all([
    supabase
      .from("leads")
      .select("id, status, temperature, estimated_value, service, created_at, contacts(first_name, last_name)")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("appointments")
      .select("id, lead_id, title, status, start_at, created_at, confirmed_at, confirmation_requested_at, contacts(first_name, last_name)")
      .eq("organization_id", organizationId)
      .order("start_at", { ascending: false })
      .limit(200),
    // Pass 5C, Batch 3A: real estimates by lead_id, replacing the
    // leads.status === 'estimate' proxy - see distinctLeadIdsWithPendingEstimate's
    // own comment above for the exact semantics. Bounded and org-scoped like
    // every other read in this function; narrow-column, no embedded contact
    // (this query is only ever used to derive lead ids, never displayed
    // directly - the lead's own already-fetched contact is reused for
    // display).
    supabase
      .from("estimates")
      .select("lead_id, status")
      .eq("organization_id", organizationId)
      .limit(500),
    supabase
      .from("audit_log")
      .select("id, action, entity_type, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(10),
    // Growth System Completion Pass 2, Part 11: reuses the exact same safe-
    // metadata-only calendar_connections read the Agency Command Center
    // already uses (see lib/agency/health.ts's loadCalendarHealth) - the
    // contractor's own dashboard had no visibility into this at all before
    // now, only the agency admin did. Only status:"error" is ever surfaced
    // here (a real, actionable sync failure); "disconnected"/no-row-at-all
    // is a normal, common state, never itself a problem - matching the
    // agency-level AgencyCalendarStatus's identical distinction.
    getCalendarConnection(supabase, organizationId),
    // HANDOFF-01: the persisted, resolvable counterpart to notifyFounder's
    // existing transient escalation notification - see
    // lib/automation-health/service.ts's recordAutomationHealthSignal, the
    // single writer of this category. RLS (automation_incidents_select)
    // already scopes this to the caller's own organization the same way it
    // does for every other automation_incidents read; the explicit filter
    // here just keeps the query efficient and its intent obvious, matching
    // this function's own established convention for the other three reads.
    supabase
      .from("automation_incidents")
      .select("id, status, description, metadata, last_seen_at")
      .eq("organization_id", organizationId)
      .eq("category", "human_escalation_requested")
      .in("status", ["open", "acknowledged"])
      .order("last_seen_at", { ascending: false })
      .limit(5),
    // ATTN-01: reuses the exact same query pair the Conversations page
    // itself already uses to derive "awaiting reply" (see
    // app/(app)/conversations/_components/conversations-list.tsx's own
    // needsReply) - real, already-proven logic, not a new derivation.
    getConversations(supabase, organizationId),
    getLastMessagesByConversation(supabase, organizationId),
    // Pass 3 (Revenue Intelligence Foundation): the real, persisted result
    // of the opportunity detectors (lib/opportunities/detect.ts), synced by
    // the caller (see app/(app)/dashboard/page.tsx) before this function is
    // called - a read here, never a second detection pass.
    getOpenOpportunities(supabase, organizationId),
  ]);

  const leads = leadsResult.data ?? [];
  const appointments = appointmentsResult.data ?? [];
  const estimates = estimatesResult.data ?? [];
  const auditLog = auditResult.data ?? [];
  const escalationIncidents = escalationIncidentsResult.data ?? [];

  // Trackpr 2.0, Phase 2B: a real PostgREST error (not merely an empty
  // `data: []`) on any of this function's own 5 direct reads means the
  // corresponding section above silently fell back to an empty array - real
  // data may be missing, not merely absent. See DashboardData.partialData's
  // own doc comment for the exact, disclosed scope (5 of 9 total reads).
  const partialDataSourceCount = [leadsResult, appointmentsResult, estimatesResult, auditResult, escalationIncidentsResult].filter((result) => result.error != null).length;
  const partialData = partialDataSourceCount > 0;

  const now = Date.now();

  // Pass 5C, Batch 3A: the real cross-references replacing the
  // leads.status === 'appointment'/'estimate' proxy - see
  // distinctLeadIdsWithBookedAppointment/distinctLeadIdsWithPendingEstimate's
  // own comments above for the exact, documented semantics chosen.
  const leadIdsWithBookedAppointment = distinctLeadIdsWithBookedAppointment(appointments);
  const leadIdsWithPendingEstimate = distinctLeadIdsWithPendingEstimate(estimates);

  const overview: OverviewMetrics = {
    newLeads: leads.filter((lead) => lead.status === "new").length,
    upcomingAppointments: appointments.filter(
      (appointment) =>
        (appointment.status === "scheduled" || appointment.status === "confirmed") &&
        new Date(appointment.start_at).getTime() >= now,
    ).length,
    // Trackpr 2.0, Phase 4C (P2 #9): a count of estimate ROWS with
    // status = 'sent' - now exactly the same real-world number as
    // Analytics' BiEstimateMetrics.sentEstimates (lib/bi/queries.ts's
    // getEstimateMetrics), not a count of distinct leads. Previously this
    // counted distinct leads with at least one sent estimate, which could
    // silently disagree with Analytics whenever a lead has more than one
    // simultaneously-sent estimate. pipeline.estimate below is deliberately
    // NOT changed - "how many leads are currently sitting in the estimate
    // stage" is a genuinely different, legitimately lead-based current-state
    // pipeline question, not the same metric as this one.
    pendingEstimates: estimates.filter((estimate) => estimate.status === PENDING_ESTIMATE_STATUS).length,
    openOpportunities: leads.filter((lead) => ACTIVE_LEAD_STATUSES.has(lead.status)).length,
  };

  const pipeline = Object.fromEntries(
    PIPELINE_STAGES.map(({ stage }) => {
      if (stage === "appointment") return [stage, leads.filter((lead) => leadIdsWithBookedAppointment.has(lead.id)).length];
      if (stage === "estimate") return [stage, leads.filter((lead) => leadIdsWithPendingEstimate.has(lead.id)).length];
      return [stage, leads.filter((lead) => lead.status === stage).length];
    }),
  ) as PipelineCounts;

  const overdueAppointments: AttentionItem[] = appointments
    .filter((appointment) => appointment.status === "scheduled" && new Date(appointment.start_at).getTime() < now)
    .slice(0, 5)
    .map((appointment) => ({
      id: `apt-${appointment.id}`,
      kind: "overdue_appointment",
      title: contactName(appointment.contacts) ?? appointment.title,
      detail: `Was scheduled ${formatRelativeTime(appointment.start_at)}`,
      value: null,
      // BOOK-02: deep-links straight to the specific appointment (rather
      // than the generic list) so marking it complete/no-show is one click,
      // not a search - the actual gap here was friction, not visibility:
      // this item itself already existed and already catches every
      // past-due, still-`scheduled` appointment.
      href: `/appointments/${appointment.id}`,
    }));

  // Pass 5B, Part D: a confirmation request genuinely went out
  // (confirmation_requested_at set - lib/automation/appointment-reminders.ts)
  // and the customer hasn't said yes yet (confirmed_at still null), for an
  // appointment that's still upcoming and still 'scheduled' - never surfaced
  // once it's already confirmed, cancelled, completed, or auto-no-showed.
  const awaitingConfirmation: AttentionItem[] = appointments
    .filter(
      (appointment) =>
        appointment.status === "scheduled" &&
        appointment.confirmation_requested_at != null &&
        appointment.confirmed_at == null &&
        new Date(appointment.start_at).getTime() >= now,
    )
    .slice(0, 5)
    .map((appointment) => ({
      id: `apt-confirm-${appointment.id}`,
      kind: "awaiting_confirmation",
      title: contactName(appointment.contacts) ?? appointment.title,
      detail: `Confirmation requested ${formatRelativeTime(appointment.confirmation_requested_at!)} - no response yet`,
      value: null,
      href: `/appointments/${appointment.id}`,
    }));

  const hotLeads: AttentionItem[] = leads
    .filter((lead) => lead.temperature === "hot" && ACTIVE_LEAD_STATUSES.has(lead.status))
    .slice(0, 5)
    .map((lead) => ({
      id: `hot-${lead.id}`,
      kind: "hot_lead",
      title: contactName(lead.contacts) ?? lead.service ?? "Hot lead",
      detail: "Hot lead - follow up soon",
      value: lead.estimated_value != null ? formatCurrency(Number(lead.estimated_value)) : null,
      href: "/leads",
    }));

  // Q7: a lead the AI never flagged "hot" can still be a large deal sitting
  // idle - estimated_value was previously never factored into attention at
  // all. Excludes anything already caught by hotLeads above, so a hot AND
  // high-value lead appears once, not twice.
  const highValueLeads: AttentionItem[] = leads
    .filter((lead) => lead.temperature !== "hot" && ACTIVE_LEAD_STATUSES.has(lead.status) && lead.estimated_value != null && Number(lead.estimated_value) >= HIGH_VALUE_THRESHOLD)
    .slice(0, 5)
    .map((lead) => ({
      id: `value-${lead.id}`,
      kind: "high_value_lead",
      title: contactName(lead.contacts) ?? lead.service ?? "High-value lead",
      detail: "High-value opportunity - follow up soon",
      value: formatCurrency(Number(lead.estimated_value)),
      href: "/leads",
    }));

  // Trackpr 2.0, Phase 2A: the uncontacted_lead opportunity (below) and
  // hot_lead/high_value_lead above can genuinely overlap - a brand-new,
  // never-contacted lead can also already be flagged "hot" or be a
  // high-value amount. Built from the same source condition each of those
  // two uses (not their already-`.slice(0, 5)`'d display arrays), so a lead
  // trimmed off the visible hot/high-value list by that cap still correctly
  // excludes it here - the underlying lead is already represented above,
  // full stop, regardless of whether it made the visible slice.
  const hotOrHighValueLeadIds = new Set(
    leads
      .filter((lead) => ACTIVE_LEAD_STATUSES.has(lead.status) && (lead.temperature === "hot" || (lead.estimated_value != null && Number(lead.estimated_value) >= HIGH_VALUE_THRESHOLD)))
      .map((lead) => lead.id),
  );

  const pendingEstimateLeads: AttentionItem[] = leads
    .filter((lead) => leadIdsWithPendingEstimate.has(lead.id))
    .slice(0, 5)
    .map((lead) => ({
      id: `est-${lead.id}`,
      kind: "pending_estimate",
      title: contactName(lead.contacts) ?? lead.service ?? "Pending estimate",
      detail: "At the estimate stage - needs follow-up",
      value: lead.estimated_value != null ? formatCurrency(Number(lead.estimated_value)) : null,
      href: "/estimates",
    }));

  // HANDOFF-01: the single highest-priority attention kind - a customer is
  // waiting on a human reply right now, which is more time-sensitive than
  // any of the other four kinds below. Ranked first for that reason.
  const humanEscalations: AttentionItem[] = escalationIncidents.map((incident) => {
    const metadata = (incident.metadata ?? {}) as { conversationId?: string | null };
    return {
      id: `escalation-${incident.id}`,
      kind: "human_escalation",
      title: "AI needs your attention",
      detail: incident.description ?? "A conversation needs a human reply.",
      value: null,
      href: metadata.conversationId ? `/conversations/${metadata.conversationId}` : "/conversations",
      incidentId: incident.id,
      incidentStatus: incident.status as IncidentStatus,
    };
  });

  // ATTN-01: a conversation whose most recent message is inbound and still
  // open is a customer waiting on a reply - real, already-proven data (the
  // Conversations page's own needsReply logic), just never aggregated onto
  // the dashboard before now.
  const conversationsWithLastMessage = attachLastMessages(conversations, lastMessages);
  const awaitingReply: AttentionItem[] = conversationsWithLastMessage
    .filter((conversation) => conversation.status === "open" && conversation.lastMessage?.direction === "inbound")
    .slice(0, 5)
    .map((conversation) => ({
      id: `reply-${conversation.id}`,
      kind: "awaiting_reply",
      title: contactName(conversation.contact) ?? "Customer",
      detail: `Waiting for a reply ${formatRelativeTime(conversation.lastActivityAt)}`,
      value: null,
      href: `/conversations/${conversation.id}`,
    }));

  // Pass 5C, Batch 1: the mirror-image case awaitingReply above doesn't
  // cover - Trackpr/the business sent the LAST message, the conversation is
  // still open, and nothing has happened since. Deliberately NOT an
  // Opportunity (see lib/opportunities/detect.ts's own header comment on
  // why): this population is already the exact target of the existing
  // lead-reactivation/lost-lead-nurture automations, so this is a
  // visibility gap, not a detection gap, and there is no honest dollar
  // figure to attach to "a conversation stalled." Recomputed fresh on every
  // load from data already fetched above (conversationsWithLastMessage
  // already embeds each conversation's own lead via getConversations' own
  // join) - no new query, no persisted lifecycle state.
  //
  // 48 hours: long enough that a customer replying the next business day is
  // never flagged as abandoned, short enough to still be a timely signal -
  // deliberately distinct from (not copied from) the 72-hour grace period
  // lib/opportunities/detect.ts's cancelled-appointment detector uses,
  // since these are two different real-world waiting periods, not the same
  // number reused by coincidence.
  const ABANDONED_CONVERSATION_THRESHOLD_MS = 48 * 60 * 60 * 1000;
  // Mirrors lib/automation/lead-reactivation.ts's own ELIGIBLE_LEAD_STATUSES
  // exactly (that constant is private to its own module, so this is the
  // same definition restated here, not a second, divergent one) - a lead
  // that has already progressed to appointment/estimate/won, or is marked
  // lost, makes a quiet conversation expected/healthy, not abandoned.
  const CONVERSATION_STILL_ACTIONABLE_LEAD_STATUSES = new Set(["new", "contacted", "qualified"]);
  const abandonedConversations: AttentionItem[] = conversationsWithLastMessage
    .filter(
      (conversation) =>
        conversation.status === "open" &&
        conversation.lastMessage?.direction === "outbound" &&
        now - new Date(conversation.lastActivityAt).getTime() >= ABANDONED_CONVERSATION_THRESHOLD_MS &&
        (conversation.lead == null || CONVERSATION_STILL_ACTIONABLE_LEAD_STATUSES.has(conversation.lead.status)),
    )
    .slice(0, 5)
    .map((conversation) => ({
      id: `abandoned-${conversation.id}`,
      kind: "abandoned_conversation",
      title: contactName(conversation.contact) ?? "Customer",
      detail: `No reply since we last reached out, ${formatRelativeTime(conversation.lastActivityAt)}`,
      value: null,
      href: `/conversations/${conversation.id}`,
    }));

  // Pass 3: three new, genuinely distinct attention kinds backed by the
  // opportunities table - deliberately NOT surfacing qualified_lead_unbooked
  // or completed_appointment_no_estimate here, since those would duplicate
  // the hot_lead/high_value_lead/pending_estimate items above, which already
  // read the same underlying leads from a different angle.
  const noShowOpportunities: AttentionItem[] = openOpportunities
    .filter((opportunity) => opportunity.type === "no_show")
    .slice(0, 5)
    .map((opportunity) => ({
      id: `opp-${opportunity.id}`,
      kind: "no_show",
      title: opportunity.title,
      detail: opportunity.description ?? "Missed appointment - needs rescheduling.",
      value: null,
      href: "/appointments",
      opportunityId: opportunity.id,
    }));

  const staleEstimateOpportunities: AttentionItem[] = openOpportunities
    .filter((opportunity) => opportunity.type === "stale_estimate")
    .slice(0, 5)
    .map((opportunity) => ({
      id: `opp-${opportunity.id}`,
      kind: "stale_estimate",
      title: opportunity.title,
      detail: opportunity.description ?? "Estimate expired with no customer decision.",
      value: opportunity.estimatedValue != null ? formatCurrency(opportunity.estimatedValue) : null,
      href: "/estimates",
      opportunityId: opportunity.id,
    }));

  const dormantCustomerOpportunities: AttentionItem[] = openOpportunities
    .filter((opportunity) => opportunity.type === "dormant_customer")
    .slice(0, 5)
    .map((opportunity) => ({
      id: `opp-${opportunity.id}`,
      kind: "dormant_customer",
      title: opportunity.title,
      detail: opportunity.description ?? "No activity since their last completed job.",
      // Deliberately never a value - dormant/repeat-customer opportunities
      // never get a fabricated future-service estimate (Pass 3's own rule).
      value: null,
      href: opportunity.contactId ? `/contacts/${opportunity.contactId}` : "/contacts",
      opportunityId: opportunity.id,
    }));

  // Trackpr 2.0, Phase 2A: the 5 remaining opportunity types that had no
  // dashboard attention kind at all before this pass - each was already
  // detected and persisted (lib/opportunities/detect.ts), just never
  // surfaced here. Detector logic and lifecycle are untouched; this is
  // purely a new read+map over the already-fetched openOpportunities, the
  // same shape every opportunity-backed kind above already uses.
  const acceptedEstimateNoJobOpportunities: AttentionItem[] = openOpportunities
    .filter((opportunity) => opportunity.type === "accepted_estimate_no_job")
    .slice(0, 5)
    .map((opportunity) => ({
      id: `opp-${opportunity.id}`,
      kind: "accepted_estimate_no_job",
      title: opportunity.title,
      detail: "Estimate accepted - job not scheduled yet.",
      value: opportunity.estimatedValue != null ? formatCurrency(opportunity.estimatedValue) : null,
      href: "/estimates",
      opportunityId: opportunity.id,
    }));

  // Excludes any lead already represented by hotLeads/highValueLeads above
  // (see hotOrHighValueLeadIds' own comment) - the same underlying lead
  // never appears as two separate attention items.
  const uncontactedLeadOpportunities: AttentionItem[] = openOpportunities
    .filter((opportunity) => opportunity.type === "uncontacted_lead" && !hotOrHighValueLeadIds.has(opportunity.sourceEntityId))
    .slice(0, 5)
    .map((opportunity) => ({
      id: `opp-${opportunity.id}`,
      kind: "uncontacted_lead",
      title: opportunity.title,
      detail: "Lead hasn't been contacted yet.",
      value: opportunity.estimatedValue != null ? formatCurrency(opportunity.estimatedValue) : null,
      href: "/leads",
      opportunityId: opportunity.id,
    }));

  const cancelledAppointmentOpportunities: AttentionItem[] = openOpportunities
    .filter((opportunity) => opportunity.type === "cancelled_appointment_no_rebooking")
    .slice(0, 5)
    .map((opportunity) => ({
      id: `opp-${opportunity.id}`,
      kind: "cancelled_appointment_no_rebooking",
      title: opportunity.title,
      detail: "Cancelled appointment needs rebooking.",
      // No dollar amount exists on an appointment itself - the same
      // reasoning the no_show kind above already applies.
      value: null,
      href: "/appointments",
      opportunityId: opportunity.id,
    }));

  const completedJobNoReviewRequestOpportunities: AttentionItem[] = openOpportunities
    .filter((opportunity) => opportunity.type === "completed_job_no_review_request")
    .slice(0, 5)
    .map((opportunity) => ({
      id: `opp-${opportunity.id}`,
      kind: "completed_job_no_review_request",
      title: opportunity.title,
      detail: "Review request still needed.",
      // Pass 5C's own detector deliberately surfaces the completed job's
      // known value here (unlike the referral kind below) - see
      // lib/opportunities/detect.ts's own comment on that divergence.
      value: opportunity.estimatedValue != null ? formatCurrency(opportunity.estimatedValue) : null,
      href: `/jobs/${opportunity.sourceEntityId}`,
      opportunityId: opportunity.id,
    }));

  const completedJobNoReferralRequestOpportunities: AttentionItem[] = openOpportunities
    .filter((opportunity) => opportunity.type === "completed_job_no_referral_request")
    .slice(0, 5)
    .map((opportunity) => ({
      id: `opp-${opportunity.id}`,
      kind: "completed_job_no_referral_request",
      title: opportunity.title,
      detail: "Referral request still needed.",
      // Deliberately never a value - a referral ask has no dollar figure of
      // its own (lib/opportunities/detect.ts's own rule for this type).
      value: null,
      href: `/jobs/${opportunity.sourceEntityId}`,
      opportunityId: opportunity.id,
    }));

  const calendarAttention: AttentionItem[] =
    calendarConnection?.status === "error"
      ? [
          {
            id: `calendar-${calendarConnection.id}`,
            kind: "calendar_disconnected",
            title: "Google Calendar sync failed",
            detail: calendarConnection.lastError ?? "Reconnect your calendar to keep bookings in sync.",
            value: null,
            href: "/settings",
          },
        ]
      : [];

  // Pass 3: raised from 6 to 10 now that three genuinely new, previously
  // invisible signals (no_show/stale_estimate/dormant_customer) compete for
  // a slot alongside the original seven kinds - a flat 6-item cap would
  // have silently squeezed out real opportunity data most of the time.
  //
  // Trackpr 2.0, Phase 2A: 5 more kinds joined this list (see each one's own
  // builder above), still a fixed priority list, never a score - explicit
  // fixed ordering only, per this pass's own instruction. The cap stays at
  // 10 (no concrete product reason to raise it yet); with 17 candidate
  // kinds now competing for it, the lowest tier below can be squeezed out on
  // a busy day - an accepted, documented tradeoff, not an oversight (see the
  // Phase 2A report's own "Risks/limitations" for this exact point).
  //
  // Five tiers, most time-sensitive first:
  //   1) someone is waiting on a human reply right now
  //   2) a time-boxed operational gap that needs action today, including
  //      accepted_estimate_no_job - a customer already said yes; this is
  //      real, already-committed revenue sitting un-actioned, which is more
  //      urgent than a merely-hot (still-speculative) lead, so it's placed
  //      ahead of the lead-pursuit tier, not folded into it
  //   3) a real lead worth pursuing, including uncontacted_lead - placed
  //      first in this tier because "zero contact yet" is a more urgent
  //      version of "worth pursuing" than a lead that's already hot but has
  //      at least been engaged
  //   4) a recoverable, longer-horizon opportunity, including
  //      cancelled_appointment_no_rebooking - grouped with stale_estimate/
  //      dormant_customer as "past its grace period, worth revisiting,"
  //      not "needs action today"
  //   5) a growth/reputation ask with no revenue or customer waiting on it -
  //      the lowest-urgency tier, new in this pass
  const attentionItems = [
    ...humanEscalations,
    ...awaitingReply,
    ...abandonedConversations,
    ...calendarAttention,
    ...overdueAppointments,
    ...awaitingConfirmation,
    ...noShowOpportunities,
    ...acceptedEstimateNoJobOpportunities,
    ...uncontactedLeadOpportunities,
    ...hotLeads,
    ...highValueLeads,
    ...pendingEstimateLeads,
    ...cancelledAppointmentOpportunities,
    ...staleEstimateOpportunities,
    ...dormantCustomerOpportunities,
    ...completedJobNoReviewRequestOpportunities,
    ...completedJobNoReferralRequestOpportunities,
  ].slice(0, 10);

  const leadActivity: ActivityItem[] = leads.slice(0, 5).map((lead) => ({
    id: `lead-${lead.id}`,
    message: `New lead${contactName(lead.contacts) ? `: ${contactName(lead.contacts)}` : lead.service ? `: ${lead.service}` : ""}`,
    timestamp: lead.created_at,
  }));

  const appointmentActivity: ActivityItem[] = appointments.slice(0, 5).map((appointment) => ({
    id: `apt-created-${appointment.id}`,
    message: `Appointment scheduled${contactName(appointment.contacts) ? `: ${contactName(appointment.contacts)}` : appointment.title ? `: ${appointment.title}` : ""}`,
    timestamp: appointment.created_at,
  }));

  const auditActivity: ActivityItem[] = auditLog.map((entry) => ({
    id: `audit-${entry.id}`,
    message: formatAuditAction(entry.action, entry.entity_type),
    timestamp: entry.created_at,
  }));

  const recentActivity = [...leadActivity, ...appointmentActivity, ...auditActivity]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 8);

  return { overview, pipeline, attentionItems, recentActivity, partialData, partialDataSourceCount };
}
