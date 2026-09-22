import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveDateRange, getCommunicationMetrics, getAiMetrics } from "@/lib/bi/queries";
import type { MessageStatus } from "@/lib/conversations/queries";
import type { BusinessMetricsSnapshot, Rate } from "@/lib/bi/types";
import { getDashboardBusinessMetrics, DASHBOARD_DEFAULT_RANGE } from "@/lib/dashboard/business-metrics";

/**
 * Agency Command Center - server-only aggregation layer.
 *
 * There is exactly one implicit agency (Contractor Growth Co. itself) - see
 * the agency_command_center_foundation migration. Every function here
 * follows the same two-step authorization shape: (1) verify the caller is a
 * real, session-authenticated agency admin via the `is_agency_admin()`
 * SECURITY DEFINER RPC (RLS-scoped, never trusts a client-supplied flag),
 * then (2) only after that succeeds, switch to a service-role client to read
 * `agency_organizations` and perform the actual cross-organization
 * aggregation - mirroring the existing n8n-callback route's own
 * "authenticate first, service-role second" pattern.
 *
 * This module never recomputes a metric lib/bi/* already computes - it only
 * resolves which organizations the agency may see and then calls the
 * existing per-organization BI functions once per organization, summing the
 * results. No second BI engine, no new terminology: every value keeps its
 * exact lib/bi/types.ts name (pipelineValue, estimateValue,
 * contractedJobValue, ...) and this codebase's "no revenue terminology"
 * rule applies here exactly as it does everywhere else.
 */

export type AgencyOrganization = {
  organizationId: string;
  organizationName: string;
  /** When this organization was associated with the agency (agency_organizations.created_at) - used only to derive "stuck in onboarding for N days" style signals, never displayed as the organization's own creation date. */
  createdAt: string;
};

export type AgencyAuthFailure =
  | { ok: false; reason: "unauthenticated" }
  | { ok: false; reason: "not_agency_admin" };

export type AgencyOrganizationsResult = { ok: true; organizations: AgencyOrganization[] } | AgencyAuthFailure;

/**
 * Step 1 of every agency read: verify the caller is authenticated AND is a
 * recognized agency admin, using the caller's own session client (RLS-scoped
 * - `is_agency_admin()` resolves auth.uid() itself, nothing here is ever
 * trusted from client input). Being in agency_admins grants no access to any
 * organization by itself - it only unlocks step 2 below.
 */
async function verifyAgencyAdmin(sessionSupabase: SupabaseClient): Promise<{ ok: true } | AgencyAuthFailure> {
  const {
    data: { user },
  } = await sessionSupabase.auth.getUser();

  if (!user) return { ok: false, reason: "unauthenticated" };

  const { data: isAdmin, error } = await sessionSupabase.rpc("is_agency_admin");
  if (error || isAdmin !== true) return { ok: false, reason: "not_agency_admin" };

  return { ok: true };
}

/**
 * Trackpr 2.0 redesign: a cheap boolean check for nav visibility only (the
 * app shell needs to know whether to render the "Agency" nav group at all).
 * Reuses the exact same is_agency_admin() RPC verifyAgencyAdmin already
 * calls above - not a second, divergent authorization mechanism. This is
 * never itself an authorization boundary: /agency and its data reads still
 * independently re-verify via resolveAgencyOrganizations/verifyAgencyAdmin
 * on every real request, exactly as before. Hiding a nav link is a UX
 * convenience, not a security control.
 */
export async function isAgencyAdmin(sessionSupabase: SupabaseClient): Promise<boolean> {
  const {
    data: { user },
  } = await sessionSupabase.auth.getUser();
  if (!user) return false;

  const { data, error } = await sessionSupabase.rpc("is_agency_admin");
  return !error && data === true;
}

/**
 * Step 2: only once step 1 has succeeded, resolve exactly the organizations
 * explicitly associated with the agency via agency_organizations - never
 * every row in `organizations`. Uses the service-role client because this
 * is a deliberate, pre-authorized cross-organization read; an organization
 * not present in agency_organizations is invisible here, full stop. An
 * empty result (agency admin with no associated organizations yet) is a
 * valid, non-error state, not a failure.
 */
async function loadAgencyOrganizations(serviceSupabase: SupabaseClient): Promise<AgencyOrganization[]> {
  const { data, error } = await serviceSupabase
    .from("agency_organizations")
    .select("organization_id, created_at, organizations(name)")
    .order("created_at", { ascending: true });

  if (error || !data) return [];

  return data.map((row) => {
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    return {
      organizationId: row.organization_id as string,
      organizationName: (org?.name as string | undefined) ?? "Unknown organization",
      createdAt: row.created_at as string,
    };
  });
}

/**
 * The single chokepoint every other agency function in this module (and
 * lib/agency/health.ts) calls first - resolving "which organizations is
 * this caller allowed to see" is never duplicated or reimplemented
 * elsewhere.
 */
export async function resolveAgencyOrganizations(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
): Promise<AgencyOrganizationsResult> {
  const auth = await verifyAgencyAdmin(sessionSupabase);
  if (!auth.ok) return auth;

  const organizations = await loadAgencyOrganizations(serviceSupabase);
  return { ok: true, organizations };
}

// ---------------------------------------------------------------------------
// Per-organization snapshot - the shared fetch both the business-metrics
// summary below and lib/agency/health.ts build on, so the same data is never
// queried twice for one agency read.
// ---------------------------------------------------------------------------

export type AgencyOrganizationSnapshot = {
  organizationId: string;
  organizationName: string;
  metrics: BusinessMetricsSnapshot;
  /** Full message status breakdown (incl. "sent"), from Phase 5.1 - not surfaced by the Phase 5.2 snapshot. */
  messagesByStatus: Record<MessageStatus, number>;
  /** ai_interactions counted by interaction_type, from Phase 5.1. */
  aiInteractionsByType: Record<string, number>;
  /** ai_interactions counted by model, from Phase 5.1. A missing model is grouped under "unknown". */
  aiInteractionsByModel: Record<string, number>;
};

export type AgencyOrganizationSnapshotsResult =
  | { ok: true; organizations: AgencyOrganizationSnapshot[] }
  | AgencyAuthFailure;

export async function getAgencyOrganizationSnapshots(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
): Promise<AgencyOrganizationSnapshotsResult> {
  const resolved = await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);
  if (!resolved.ok) return resolved;

  const range = resolveDateRange(DASHBOARD_DEFAULT_RANGE);

  const organizations = await Promise.all(
    resolved.organizations.map(async ({ organizationId, organizationName }) => {
      const [metrics, communication, ai] = await Promise.all([
        getDashboardBusinessMetrics(serviceSupabase, organizationId),
        getCommunicationMetrics(serviceSupabase, organizationId, range),
        getAiMetrics(serviceSupabase, organizationId, range),
      ]);

      return {
        organizationId,
        organizationName,
        metrics,
        messagesByStatus: communication.byMessageStatus,
        aiInteractionsByType: ai.aiInteractionsByType,
        aiInteractionsByModel: ai.aiInteractionsByModel,
      };
    }),
  );

  return { ok: true, organizations };
}

// ---------------------------------------------------------------------------
// Agency-wide summary - straight sums across the resolved organizations.
// Count/value fields are summed directly. Rates are NEVER averaged across
// organizations (that would be statistically meaningless) - they are
// recomputed from the summed numerator/denominator, using the exact same
// null-on-zero-denominator rule as every Rate in lib/bi/types.ts.
// ---------------------------------------------------------------------------

/** Matches lib/bi/metrics.ts's own rate() exactly - every Rate in this codebase is a 0-100 value, never a 0-1 fraction. */
function rate(numerator: number, denominator: number): Rate {
  return denominator === 0 ? null : (numerator / denominator) * 100;
}

export type AgencyBusinessSummary = {
  organizationCount: number;

  totalLeads: number;
  openOpportunityCount: number;
  pipelineValue: number;

  totalEstimates: number;
  sentEstimates: number;
  acceptedEstimates: number;
  declinedEstimates: number;
  estimateValue: number;
  /** acceptedEstimates / (acceptedEstimates + declinedEstimates) across the agency, recomputed from summed counts - never averaged. `null` when the denominator is 0. */
  estimateAcceptanceRate: Rate;

  totalJobs: number;
  scheduledJobs: number;
  inProgressJobs: number;
  completedJobs: number;
  cancelledJobs: number;
  contractedJobValue: number;
  /** completedJobs / (completedJobs + cancelledJobs) across the agency. `null` when the denominator is 0. */
  jobCompletionRate: Rate;

  totalAppointments: number;
  completedAppointments: number;
  cancelledAppointments: number;
  noShowAppointments: number;
  /** noShowAppointments / (completed + cancelled + noShow) across the agency. `null` when the denominator is 0. */
  appointmentNoShowRate: Rate;

  inboundMessages: number;
  outboundMessages: number;
  messagesByStatus: Record<MessageStatus, number>;

  automationEvents: number;
  workflowExecutions: number;
  successfulWorkflowExecutions: number;
  failedWorkflowExecutions: number;
  runningWorkflowExecutions: number;
  /** successfulWorkflowExecutions / (successful + failed) across the agency. `null` when the denominator is 0. */
  automationSuccessRate: Rate;

  aiInteractions: number;
  aiInteractionsByType: Record<string, number>;
  aiInteractionsByModel: Record<string, number>;
  /** Growth System Completion Pass 2, Part 4: SUM across every organization's own metrics.aiMetrics.totalTokensUsed - `null` when not a single organization has any usage data at all. */
  totalTokensUsed: number | null;
  /** Count of organizations (out of organizationCount) with at least one AI interaction carrying real usage data - lets the agency view show "usage data available for N of M clients" rather than implying full coverage. */
  organizationsWithUsageData: number;
};

export type AgencyBusinessMetricsResult =
  | {
      ok: true;
      organizations: AgencyOrganizationSnapshot[];
      summary: AgencyBusinessSummary;
      /** Every value/rate figure here is a quoted or contracted amount - never revenue, never "collected." Matches lib/bi/types.ts's dataQuality contract exactly; not a second data-quality framework. */
      dataQuality: {
        collectedRevenueUnavailable: true;
        sourceAttributionLimited: true;
        stageHistoryUnavailable: true;
        aiTokenUsageUnavailable: boolean;
        notes: string[];
      };
      generatedAt: string;
    }
  | AgencyAuthFailure;

function mergeMessageStatusCounts(snapshots: AgencyOrganizationSnapshot[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const snapshot of snapshots) {
    for (const [status, count] of Object.entries(snapshot.messagesByStatus)) {
      merged[status] = (merged[status] ?? 0) + count;
    }
  }
  return merged;
}

function mergeCounts(snapshots: AgencyOrganizationSnapshot[], pick: (s: AgencyOrganizationSnapshot) => Record<string, number>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const snapshot of snapshots) {
    for (const [key, count] of Object.entries(pick(snapshot))) {
      merged[key] = (merged[key] ?? 0) + count;
    }
  }
  return merged;
}

export async function getAgencyBusinessMetrics(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
): Promise<AgencyBusinessMetricsResult> {
  const snapshots = await getAgencyOrganizationSnapshots(sessionSupabase, serviceSupabase);
  if (!snapshots.ok) return snapshots;

  const { organizations } = snapshots;

  const sum = (pick: (s: AgencyOrganizationSnapshot) => number) => organizations.reduce((total, s) => total + pick(s), 0);

  const acceptedEstimates = sum((s) => s.metrics.estimateMetrics.acceptedEstimates);
  const declinedEstimates = sum((s) => s.metrics.estimateMetrics.declinedEstimates);
  const completedJobs = sum((s) => s.metrics.jobMetrics.completedJobs);
  const cancelledJobs = sum((s) => s.metrics.jobMetrics.cancelledJobs);
  const completedAppointments = sum((s) => s.metrics.appointmentMetrics.completedAppointments);
  const cancelledAppointments = sum((s) => s.metrics.appointmentMetrics.cancelledAppointments);
  const noShowAppointments = sum((s) => s.metrics.appointmentMetrics.noShowAppointments);
  const successfulWorkflowExecutions = sum((s) => s.metrics.automationMetrics.successfulWorkflowExecutions);
  const failedWorkflowExecutions = sum((s) => s.metrics.automationMetrics.failedWorkflowExecutions);

  const summary: AgencyBusinessSummary = {
    organizationCount: organizations.length,

    totalLeads: sum((s) => s.metrics.leadMetrics.totalLeads),
    openOpportunityCount: sum((s) => s.metrics.pipelineMetrics.openOpportunityCount),
    pipelineValue: sum((s) => s.metrics.pipelineMetrics.pipelineValue),

    totalEstimates: sum((s) => s.metrics.estimateMetrics.totalEstimates),
    sentEstimates: sum((s) => s.metrics.estimateMetrics.sentEstimates),
    acceptedEstimates,
    declinedEstimates,
    estimateValue: sum((s) => s.metrics.estimateMetrics.estimateValue),
    estimateAcceptanceRate: rate(acceptedEstimates, acceptedEstimates + declinedEstimates),

    totalJobs: sum((s) => s.metrics.jobMetrics.totalJobs),
    scheduledJobs: sum((s) => s.metrics.jobMetrics.scheduledJobs),
    inProgressJobs: sum((s) => s.metrics.jobMetrics.inProgressJobs),
    completedJobs,
    cancelledJobs,
    contractedJobValue: sum((s) => s.metrics.jobMetrics.contractedJobValue),
    jobCompletionRate: rate(completedJobs, completedJobs + cancelledJobs),

    totalAppointments: sum((s) => s.metrics.appointmentMetrics.totalAppointments),
    completedAppointments,
    cancelledAppointments,
    noShowAppointments,
    appointmentNoShowRate: rate(noShowAppointments, completedAppointments + cancelledAppointments + noShowAppointments),

    inboundMessages: sum((s) => s.metrics.communicationMetrics.inboundMessages),
    outboundMessages: sum((s) => s.metrics.communicationMetrics.outboundMessages),
    messagesByStatus: mergeMessageStatusCounts(organizations) as Record<MessageStatus, number>,

    automationEvents: sum((s) => s.metrics.automationMetrics.automationEvents),
    workflowExecutions: sum((s) => s.metrics.automationMetrics.workflowExecutions),
    successfulWorkflowExecutions,
    failedWorkflowExecutions,
    runningWorkflowExecutions: sum((s) => s.metrics.automationMetrics.runningWorkflowExecutions),
    automationSuccessRate: rate(successfulWorkflowExecutions, successfulWorkflowExecutions + failedWorkflowExecutions),

    aiInteractions: sum((s) => s.metrics.aiMetrics.aiInteractions),
    aiInteractionsByType: mergeCounts(organizations, (s) => s.aiInteractionsByType),
    aiInteractionsByModel: mergeCounts(organizations, (s) => s.aiInteractionsByModel),
    totalTokensUsed: organizations.some((s) => s.metrics.aiMetrics.totalTokensUsed !== null)
      ? sum((s) => s.metrics.aiMetrics.totalTokensUsed ?? 0)
      : null,
    organizationsWithUsageData: organizations.filter((s) => s.metrics.aiMetrics.interactionsWithUsageData > 0).length,
  };

  const aiTokenUsageUnavailable = summary.organizationsWithUsageData === 0;

  return {
    ok: true,
    organizations,
    summary,
    dataQuality: {
      collectedRevenueUnavailable: true,
      sourceAttributionLimited: true,
      stageHistoryUnavailable: true,
      aiTokenUsageUnavailable,
      notes: [
        "No payment infrastructure exists - every value figure across the agency is quoted/contracted, never confirmed collected money.",
        aiTokenUsageUnavailable
          ? "No organization has any ai_interactions row with provider-reported token usage yet - n8n's own AI call has not reported it for any interaction."
          : `Token usage is available for ${summary.organizationsWithUsageData} of ${organizations.length} client(s) - only n8n calls that reported usage are included.`,
      ],
    },
    generatedAt: new Date().toISOString(),
  };
}
