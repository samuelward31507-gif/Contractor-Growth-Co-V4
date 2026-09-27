import type { SupabaseClient } from "@supabase/supabase-js";
import { getAgencyOrganizationSnapshots, type AgencyAuthFailure } from "./queries";
import { resolveDateRange } from "@/lib/bi/queries";
import { DASHBOARD_DEFAULT_RANGE } from "@/lib/dashboard/business-metrics";
import type { MessageStatus } from "@/lib/conversations/queries";
import type { Rate, ResolvedDateRange } from "@/lib/bi/types";

/**
 * Trackpr Phase 5B - Agency Client Usage Intelligence.
 *
 * This is USAGE VISIBILITY, not billing. Every figure here is a real count
 * already computed by the existing BI layer (lib/bi/*) - this module invents
 * no metric, recomputes no metric, and never converts a usage count into a
 * dollar figure. There is no pricing/rate-card data anywhere in this
 * codebase (confirmed by the Phase 5B audit) - see PHASE_5C/5D notes below
 * for what a future cost/margin phase would require, none of which is built
 * here.
 *
 * Architecture: this file reuses lib/agency/health.ts's exact precedent
 * (getAgencyHealth calls getAgencyOrganizationSnapshots directly, which
 * itself calls resolveAgencyOrganizations first - the same "call the
 * existing agency-wide snapshot fetch, don't re-authorize independently"
 * shape). The ONE genuinely new query in this whole module is the missed-call
 * count, which is batched across every authorized organization in a single
 * query - mirroring lib/agency/health.ts's loadStuckExecutions/
 * loadCalendarHealth/loadPaymentAndPauseStatus convention exactly (one
 * `.in("organization_id", organizationIds)` read, never a query per
 * organization, never an independent, unscoped service-role query).
 *
 * Deliberately NOT included in this phase (see the Phase 5B audit for the
 * full reasoning): per-workflow-type execution breakdown
 * (workflowExecutionsByName) and execution duration/retry counts. Both are
 * computable from existing columns without new schema, but
 * getAutomationAndFollowUpMetrics (the function that already computes
 * workflowExecutionsByName) has no `failed` signal of its own, unlike every
 * other lib/bi/queries.ts function - wiring it in here would either silently
 * violate this module's own 0-vs-unavailable discipline or require modifying
 * an existing, otherwise-untouched BI function, which this phase's scope
 * does not authorize. Left as a named follow-up, not a silent gap.
 */

export type ClientUsagePeriod = { from: string | null; to: string | null; label: string };

export type ClientMessagingUsage = {
  inbound: number;
  outbound: number;
  total: number;
  /** Full 7-state breakdown (queued/sent/delivered/failed/undelivered/received/logged) - the exact fidelity lib/bi/queries.ts's getCommunicationMetrics already computes, never collapsed to a coarser "success/fail" pair. */
  byStatus: Record<MessageStatus, number>;
};

export type ClientAiUsage = {
  interactions: number;
  /** Count of interactions with a non-null tokens_used - lets the UI show "usage data available for N of M interactions" rather than implying full coverage. */
  interactionsWithUsageData: number;
  /** SUM(tokens_used) over interactions that actually reported it. Null - never 0 - when zero interactions in this period reported any usage data at all. */
  tokens: number | null;
  byType: Record<string, number>;
  byModel: Record<string, number>;
  /** ai_interactions whose stored output has needs_human = true - a real escalation-volume signal, already computed by lib/bi/metrics.ts's getAiOutputFields. */
  needsHumanCount: number;
};

export type ClientAutomationUsage = {
  executions: number;
  successful: number;
  failed: number;
  running: number;
  /** successful / (successful + failed). Null when that denominator is 0 - never a fabricated 0%/100%. */
  successRate: Rate;
};

export type ClientVoiceUsage = {
  /**
   * Count of automation_events rows with event_type = 'call.missed' in the
   * period - the ONLY call-related fact Trackpr can currently support (see
   * app/api/webhooks/voice/inbound/route.ts: Trackpr never answers a call,
   * so there is no duration, no answered/voicemail distinction, and no
   * per-minute cost anywhere in this schema). Null - never 0 - when the
   * underlying query itself failed; a genuine zero means the query
   * succeeded and found no missed calls.
   */
  missedCalls: number | null;
};

/**
 * Deliberately NOT called "usage" - these are business-activity counts
 * (leads worked, appointments booked, estimates sent, jobs run, review/
 * referral asks made), not platform-consumption metrics, and must never be
 * presented as billable. Reused verbatim from the same BusinessMetricsSnapshot
 * every other agency page already reads - no new query.
 */
export type ClientOperationalActivity = {
  leads: number;
  appointments: number;
  estimates: number;
  jobs: number;
  reviewsRequested: number;
  referralsRequested: number;
};

export type ClientUsageDataQuality = {
  /**
   * True when this organization's own BusinessMetricsSnapshot reported a
   * real read failure (lead/estimate/job/appointment/AI - see
   * BusinessMetricsSnapshot.partialData's own documented scope in
   * lib/bi/types.ts) OR when the agency-wide missed-call query failed.
   * lib/bi/metrics.ts's snapshot does not independently track a failure
   * signal for the communication/automation reads specifically (confirmed
   * during the Phase 5B audit - neither getCommunicationMetrics nor
   * buildAutomationMetrics's own error is threaded into
   * BusinessMetricsSnapshot.partialData) - all reads for one organization's
   * snapshot share the same request and the same Supabase client, so a
   * systemic failure would realistically affect them together, but this is
   * a disclosed simplification, not a per-field guarantee. See `notes`.
   */
  partialData: boolean;
  notes: string[];
};

export type ClientUsageSummary = {
  organizationId: string;
  organizationName: string;
  period: ClientUsagePeriod;
  messaging: ClientMessagingUsage;
  ai: ClientAiUsage;
  automation: ClientAutomationUsage;
  voice: ClientVoiceUsage;
  operational: ClientOperationalActivity;
  dataQuality: ClientUsageDataQuality;
};

export type AgencyUsageTotals = {
  organizationCount: number;
  totalMessages: number;
  totalAiInteractions: number;
  totalAutomationExecutions: number;
  /** SUM(voice.missedCalls) across clients. Null - never 0 - if the single batched missed-call query failed (in which case every client's own missedCalls is also null). */
  totalMissedCalls: number | null;
};

export type AgencyUsageSummaryResult =
  | {
      ok: true;
      clients: ClientUsageSummary[];
      totals: AgencyUsageTotals;
      /** True when at least one client's dataQuality.partialData is true. Mirrors lib/agency/health.ts's AgencyHealthResult.partialData convention: disclosed, never silently absorbed into a clean-looking summary. */
      partialData: boolean;
      generatedAt: string;
    }
  | AgencyAuthFailure;

const MAX_MISSED_CALL_ROWS = 10_000;

type MissedCallRow = { organization_id: string };

/**
 * Mirrors lib/agency/health.ts's loadStuckExecutions/loadCalendarHealth/
 * loadPaymentAndPauseStatus convention exactly: one query batched across the
 * already-authorized organization id list (never a query per organization,
 * never an unscoped table scan), and `failed` is true only on a real
 * Postgrest error - never on genuine emptiness, which must read as "0 missed
 * calls," not "unavailable." Exported (not module-private) so its own
 * zero-vs-unavailable contract can be unit-tested directly against a mocked
 * single-table client, without needing to mock the full BusinessMetricsSnapshot
 * fan-out getAgencyUsageSummary also depends on.
 */
export async function loadMissedCallCounts(
  serviceSupabase: SupabaseClient,
  organizationIds: string[],
  range: ResolvedDateRange,
): Promise<{ byOrganization: Map<string, number>; failed: boolean }> {
  if (organizationIds.length === 0) return { byOrganization: new Map(), failed: false };

  let query = serviceSupabase
    .from("automation_events")
    .select("organization_id")
    .eq("event_type", "call.missed")
    .in("organization_id", organizationIds)
    .limit(MAX_MISSED_CALL_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data, error } = await query;

  const byOrganization = new Map<string, number>();
  for (const row of (data ?? []) as MissedCallRow[]) {
    byOrganization.set(row.organization_id, (byOrganization.get(row.organization_id) ?? 0) + 1);
  }

  return { byOrganization, failed: error != null };
}

/** Pure, no I/O - directly unit-testable, matching lib/opportunities/queries.ts's summarizeOpportunities / lib/agency/expansion.ts's summarizeAgencyExpansion convention. */
export function summarizeAgencyUsage(clients: ClientUsageSummary[], missedCallQueryFailed: boolean): AgencyUsageTotals {
  return {
    organizationCount: clients.length,
    totalMessages: clients.reduce((total, client) => total + client.messaging.total, 0),
    totalAiInteractions: clients.reduce((total, client) => total + client.ai.interactions, 0),
    totalAutomationExecutions: clients.reduce((total, client) => total + client.automation.executions, 0),
    totalMissedCalls: missedCallQueryFailed ? null : clients.reduce((total, client) => total + (client.voice.missedCalls ?? 0), 0),
  };
}

/**
 * The primary Phase 5B read. Reuses getAgencyOrganizationSnapshots exactly
 * as lib/agency/health.ts's getAgencyHealth already does - that function
 * itself calls resolveAgencyOrganizations first, so every downstream read is
 * already scoped to the caller's own authorized organization list before
 * this function's one new query (the missed-call batch) ever runs, using
 * that exact same authorized id list.
 */
export async function getAgencyUsageSummary(sessionSupabase: SupabaseClient, serviceSupabase: SupabaseClient): Promise<AgencyUsageSummaryResult> {
  const snapshots = await getAgencyOrganizationSnapshots(sessionSupabase, serviceSupabase);
  if (!snapshots.ok) return snapshots;

  const range = resolveDateRange(DASHBOARD_DEFAULT_RANGE);

  const { byOrganization: missedCallsByOrganization, failed: missedCallsFailed } = await loadMissedCallCounts(
    serviceSupabase,
    snapshots.organizations.map((snapshot) => snapshot.organizationId),
    range,
  );

  const clients: ClientUsageSummary[] = snapshots.organizations.map((snapshot) => {
    const metrics = snapshot.metrics;
    const notes: string[] = [];

    if (metrics.dataQuality.aiTokenUsageUnavailable) {
      notes.push("No AI interaction in this period reported token usage.");
    }
    if (missedCallsFailed) {
      notes.push("Missed-call data temporarily unavailable.");
    }

    return {
      organizationId: snapshot.organizationId,
      organizationName: snapshot.organizationName,
      period: metrics.period,
      messaging: {
        inbound: metrics.communicationMetrics.inboundMessages,
        outbound: metrics.communicationMetrics.outboundMessages,
        total: metrics.communicationMetrics.inboundMessages + metrics.communicationMetrics.outboundMessages,
        byStatus: snapshot.messagesByStatus,
      },
      ai: {
        interactions: metrics.aiMetrics.aiInteractions,
        interactionsWithUsageData: metrics.aiMetrics.interactionsWithUsageData,
        tokens: metrics.aiMetrics.totalTokensUsed,
        byType: snapshot.aiInteractionsByType,
        byModel: snapshot.aiInteractionsByModel,
        needsHumanCount: metrics.aiMetrics.aiNeedsHumanCount,
      },
      automation: {
        executions: metrics.automationMetrics.workflowExecutions,
        successful: metrics.automationMetrics.successfulWorkflowExecutions,
        failed: metrics.automationMetrics.failedWorkflowExecutions,
        running: metrics.automationMetrics.runningWorkflowExecutions,
        successRate: metrics.automationMetrics.automationSuccessRate,
      },
      voice: {
        missedCalls: missedCallsFailed ? null : (missedCallsByOrganization.get(snapshot.organizationId) ?? 0),
      },
      operational: {
        leads: metrics.leadMetrics.totalLeads,
        appointments: metrics.appointmentMetrics.totalAppointments,
        estimates: metrics.estimateMetrics.totalEstimates,
        jobs: metrics.jobMetrics.totalJobs,
        reviewsRequested: metrics.reviewReferralMetrics.reviewsRequested,
        referralsRequested: metrics.reviewReferralMetrics.referralsRequested,
      },
      dataQuality: {
        partialData: metrics.partialData || missedCallsFailed,
        notes,
      },
    };
  });

  return {
    ok: true,
    clients,
    totals: summarizeAgencyUsage(clients, missedCallsFailed),
    partialData: clients.some((client) => client.dataQuality.partialData),
    generatedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Explicitly NOT implemented in Phase 5B - documented per the audit, not a
// silent omission. See the Phase 5B audit report for the full reasoning.
//
// Phase 5C (Cost Intelligence) would introduce: an agency-configured SMS
// rate card, AI model pricing, input/output token extraction, SMS segment
// calculation, and real variable-cost figures computed from real usage x
// real configured rates - none of which exist anywhere in this codebase
// today, and none of which are fabricated here.
//
// Phase 5D (Contribution Margin) would combine client revenue (which would
// have to come from the Stripe API directly - this schema never stores an
// invoice amount) minus Phase 5C's directly-attributable variable costs.
// Shared Vercel/Supabase/n8n infrastructure cost must remain reported
// separately, agency-wide, unless a defensible, explicitly-labeled
// allocation method is adopted later - never silently split per client.
// =============================================================================
