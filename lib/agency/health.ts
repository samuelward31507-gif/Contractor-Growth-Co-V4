import type { SupabaseClient } from "@supabase/supabase-js";
import { getAgencyOrganizationSnapshots, type AgencyAuthFailure } from "@/lib/agency/queries";
import { getOrganizationHealth } from "@/lib/automation-health/health";

/**
 * Agency-wide operational health rollup - "which clients need attention."
 *
 * Reuses the exact same per-organization BusinessMetricsSnapshot fetch as
 * lib/agency/queries.ts (via getAgencyOrganizationSnapshots, so this data is
 * never queried twice for one agency read) for failed-execution, message
 * delivery, and AI-activity counts. The one genuinely new query here is the
 * stuck-execution row list, which no existing BI function computes - it
 * mirrors app/api/automation/health/route.ts's own query exactly (same
 * 30-minute default threshold, same restricted column set: id,
 * organization_id, workflow_name, attempt, started_at - never
 * error_message or metadata, which may echo upstream provider error text
 * this layer has no way to guarantee is free of sensitive detail), scoped
 * to only the agency's resolved organizations instead of every organization
 * in the database.
 */

const DEFAULT_STUCK_THRESHOLD_MINUTES = 30;
const MAX_STUCK_ROWS = 200;

export type StuckExecution = {
  id: string;
  organizationId: string;
  organizationName: string;
  workflowName: string;
  attempt: number;
  startedAt: string;
  ageMinutes: number;
};

export type AgencyOrganizationHealth = {
  organizationId: string;
  organizationName: string;
  failedWorkflowExecutions: number;
  runningWorkflowExecutions: number;
  stuckExecutionCount: number;
  /** null when there have been no completed-or-failed executions to compute a rate from - never a fabricated 0%/100%. */
  automationSuccessRate: number | null;
  failedMessages: number;
  undeliveredMessages: number;
  aiInteractions: number;
  /** A simple, honest signal - not a score, not a ranking, and never a claim that automation or AI caused any outcome. True when at least one stuck execution, one failed execution, one failed message, or one undelivered message was observed in the current period. */
  needsAttention: boolean;
};

/**
 * Automation Health + Alerting V1 rollup - "how many client organizations
 * have real, currently-open operational incidents, and how severe." Reuses
 * lib/automation-health/health.ts's own getOrganizationHealth per resolved
 * organization (the same N+1-but-parallelized shape
 * getAgencyOrganizationSnapshots already uses for its own per-org BI reads -
 * not a new pattern), scoped by the SAME resolveAgencyOrganizations
 * authorization this whole module already requires before this function is
 * ever reached. No client RLS is weakened for this: the service-role client
 * bypasses RLS by design (as it already does for loadStuckExecutions above),
 * but every read here is still explicitly filtered to the caller's already-
 * authorized organization id list, never a broader scan.
 */
export type AgencyIncidentRollup = {
  organizationsHealthy: number;
  organizationsDegraded: number;
  organizationsUnhealthy: number;
  criticalIncidents: number;
  warningIncidents: number;
};

async function loadIncidentRollup(serviceSupabase: SupabaseClient, organizationIds: string[]): Promise<AgencyIncidentRollup> {
  if (organizationIds.length === 0) {
    return { organizationsHealthy: 0, organizationsDegraded: 0, organizationsUnhealthy: 0, criticalIncidents: 0, warningIncidents: 0 };
  }

  const results = await Promise.all(organizationIds.map((organizationId) => getOrganizationHealth(serviceSupabase, organizationId)));

  let organizationsHealthy = 0;
  let organizationsDegraded = 0;
  let organizationsUnhealthy = 0;
  let criticalIncidents = 0;
  let warningIncidents = 0;

  for (const health of results) {
    if (health.status === "healthy") organizationsHealthy += 1;
    else if (health.status === "degraded") organizationsDegraded += 1;
    else organizationsUnhealthy += 1;
    criticalIncidents += health.criticalIncidentCount;
    warningIncidents += health.warningIncidentCount;
  }

  return { organizationsHealthy, organizationsDegraded, organizationsUnhealthy, criticalIncidents, warningIncidents };
}

export type AgencyHealthResult =
  | {
      ok: true;
      stuckThresholdMinutes: number;
      stuck: StuckExecution[];
      organizations: AgencyOrganizationHealth[];
      incidentRollup: AgencyIncidentRollup;
      generatedAt: string;
    }
  | AgencyAuthFailure;

type StuckExecutionRow = {
  id: string;
  organization_id: string;
  workflow_name: string;
  attempt: number;
  started_at: string;
};

async function loadStuckExecutions(
  serviceSupabase: SupabaseClient,
  organizationIds: string[],
  thresholdMinutes: number,
): Promise<StuckExecutionRow[]> {
  if (organizationIds.length === 0) return [];

  const thresholdIso = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();

  const { data, error } = await serviceSupabase
    .from("workflow_executions")
    .select("id, organization_id, workflow_name, attempt, started_at")
    .in("organization_id", organizationIds)
    .eq("status", "running")
    .lt("started_at", thresholdIso)
    .order("started_at", { ascending: true })
    .limit(MAX_STUCK_ROWS);

  if (error || !data) return [];
  return data as StuckExecutionRow[];
}

export async function getAgencyHealth(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
  options?: { stuckThresholdMinutes?: number },
): Promise<AgencyHealthResult> {
  const stuckThresholdMinutes = options?.stuckThresholdMinutes ?? DEFAULT_STUCK_THRESHOLD_MINUTES;

  const snapshots = await getAgencyOrganizationSnapshots(sessionSupabase, serviceSupabase);
  if (!snapshots.ok) return snapshots;

  const { organizations } = snapshots;
  const organizationNameById = new Map(organizations.map((org) => [org.organizationId, org.organizationName]));

  const stuckRows = await loadStuckExecutions(
    serviceSupabase,
    organizations.map((org) => org.organizationId),
    stuckThresholdMinutes,
  );

  const now = Date.now();
  const stuck: StuckExecution[] = stuckRows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    organizationName: organizationNameById.get(row.organization_id) ?? "Unknown organization",
    workflowName: row.workflow_name,
    attempt: row.attempt,
    startedAt: row.started_at,
    ageMinutes: Math.round((now - new Date(row.started_at).getTime()) / 60000),
  }));

  const stuckCountByOrg = new Map<string, number>();
  for (const row of stuck) {
    stuckCountByOrg.set(row.organizationId, (stuckCountByOrg.get(row.organizationId) ?? 0) + 1);
  }

  const orgHealth: AgencyOrganizationHealth[] = organizations.map((org) => {
    const failedWorkflowExecutions = org.metrics.automationMetrics.failedWorkflowExecutions;
    const runningWorkflowExecutions = org.metrics.automationMetrics.runningWorkflowExecutions;
    const stuckExecutionCount = stuckCountByOrg.get(org.organizationId) ?? 0;
    const failedMessages = org.messagesByStatus.failed ?? 0;
    const undeliveredMessages = org.messagesByStatus.undelivered ?? 0;

    return {
      organizationId: org.organizationId,
      organizationName: org.organizationName,
      failedWorkflowExecutions,
      runningWorkflowExecutions,
      stuckExecutionCount,
      automationSuccessRate: org.metrics.automationMetrics.automationSuccessRate,
      failedMessages,
      undeliveredMessages,
      aiInteractions: org.metrics.aiMetrics.aiInteractions,
      needsAttention: stuckExecutionCount > 0 || failedWorkflowExecutions > 0 || failedMessages > 0 || undeliveredMessages > 0,
    };
  });

  const incidentRollup = await loadIncidentRollup(
    serviceSupabase,
    organizations.map((org) => org.organizationId),
  );

  return {
    ok: true,
    stuckThresholdMinutes,
    stuck,
    organizations: orgHealth,
    incidentRollup,
    generatedAt: new Date().toISOString(),
  };
}
