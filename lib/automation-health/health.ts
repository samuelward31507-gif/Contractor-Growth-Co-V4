import type { SupabaseClient } from "@supabase/supabase-js";
import { getAutomationOverview, getWorkflowNameStats } from "@/lib/automation/queries";
import { AUTOMATION_CATALOG } from "@/lib/automation/catalog";
import { listIncidents } from "./queries";
import type { AutomationHealthStatus, AutomationHealthSummary, HealthCheckRun, OrganizationHealthStatus, OrganizationHealthSummary } from "./types";

/**
 * Deterministic health calculation - never subjective, never AI-generated.
 * Reuses lib/bi's existing AutomationMetrics/getWorkflowNameStats (last 30
 * days / last MAX_EXECUTION_ROWS executions, exactly as the Automation
 * Control Center already computes them) rather than recomputing execution
 * statistics a second time - this layer's own job is strictly to summarize
 * automation_incidents on top of that existing data, not to duplicate it.
 */

function organizationStatus(criticalCount: number, activeCount: number): OrganizationHealthStatus {
  if (criticalCount > 0) return "unhealthy";
  if (activeCount > 0) return "degraded";
  return "healthy";
}

export async function getOrganizationHealth(supabase: SupabaseClient, organizationId: string): Promise<OrganizationHealthSummary> {
  const [overview, statsByName, activeIncidents] = await Promise.all([
    getAutomationOverview(supabase, organizationId),
    getWorkflowNameStats(supabase, organizationId),
    listIncidents(supabase, organizationId, { status: ["open", "acknowledged"] }),
  ]);

  const activeByCategory = activeIncidents.reduce(
    (acc, incident) => {
      acc[incident.category] = (acc[incident.category] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const incidentCounts = {
    activeTotal: activeIncidents.length,
    critical: activeIncidents.filter((i) => i.severity === "critical").length,
    warning: activeIncidents.filter((i) => i.severity === "warning").length,
    info: activeIncidents.filter((i) => i.severity === "info").length,
  };

  let lastSuccessfulActivityAt: string | null = null;
  let lastFailureAt: string | null = null;
  for (const stats of statsByName.values()) {
    if (stats.lastStatus === "completed" && stats.lastExecutionAt) {
      if (!lastSuccessfulActivityAt || stats.lastExecutionAt > lastSuccessfulActivityAt) lastSuccessfulActivityAt = stats.lastExecutionAt;
    }
    if (stats.failed > 0 && stats.lastExecutionAt) {
      if (!lastFailureAt || stats.lastExecutionAt > lastFailureAt) lastFailureAt = stats.lastExecutionAt;
    }
  }

  const successRate =
    overview.completedWorkflows + overview.failedWorkflows === 0 ? null : (overview.completedWorkflows / (overview.completedWorkflows + overview.failedWorkflows)) * 100;

  return {
    organizationId,
    status: organizationStatus(incidentCounts.critical, incidentCounts.activeTotal),
    activeIncidentCount: incidentCounts.activeTotal,
    criticalIncidentCount: incidentCounts.critical,
    warningIncidentCount: incidentCounts.warning,
    infoIncidentCount: incidentCounts.info,
    stuckExecutionCount: activeByCategory.workflow_stuck ?? 0,
    smsDeliveryFailureCount: activeByCategory.sms_delivery_failed ?? 0,
    failedWorkflowExecutions: overview.failedWorkflows,
    automationSuccessRate: successRate,
    lastSuccessfulActivityAt,
    lastFailureAt,
    generatedAt: new Date().toISOString(),
  };
}

function automationStatus(criticalCount: number, activeCount: number, recentFailures: number): AutomationHealthStatus {
  if (criticalCount > 0) return "unhealthy";
  if (activeCount > 0 || recentFailures > 0) return "degraded";
  return "healthy";
}

/**
 * Per-automation health, combining the existing per-workflow-name execution
 * stats (lib/automation/queries.ts's own getWorkflowNameStats, already used
 * by the Automation Control Center) with active incidents grouped by
 * automation_id. Safety-layer automations (no workflow of their own) are
 * excluded - there is no execution history or incident category that could
 * ever be attributed to them.
 */
export async function getAutomationHealthSummaries(supabase: SupabaseClient, organizationId: string): Promise<AutomationHealthSummary[]> {
  const [statsByName, incidents] = await Promise.all([
    getWorkflowNameStats(supabase, organizationId),
    listIncidents(supabase, organizationId, { status: ["open", "acknowledged"] }),
  ]);

  const incidentsByAutomation = new Map<string, typeof incidents>();
  for (const incident of incidents) {
    if (!incident.automationId) continue;
    const list = incidentsByAutomation.get(incident.automationId) ?? [];
    list.push(incident);
    incidentsByAutomation.set(incident.automationId, list);
  }

  return AUTOMATION_CATALOG.filter((definition) => definition.kind !== "safety-layer").map((definition) => {
    const relevantStats = definition.workflowNames.map((name) => statsByName.get(name)).filter((s): s is NonNullable<typeof s> => s !== undefined);
    const activeIncidents = incidentsByAutomation.get(definition.id) ?? [];

    const recentFailures = relevantStats.reduce((sum, s) => sum + s.failed, 0);
    const recentSuccesses = relevantStats.reduce((sum, s) => sum + s.completed, 0);
    const failureRate = recentFailures + recentSuccesses === 0 ? null : (recentFailures / (recentFailures + recentSuccesses)) * 100;

    const lastExecutionAt = relevantStats.reduce<string | null>((latest, s) => (!s.lastExecutionAt ? latest : !latest || s.lastExecutionAt > latest ? s.lastExecutionAt : latest), null);

    const criticalIncidentCount = activeIncidents.filter((i) => i.severity === "critical").length;
    const stuckExecutionCount = activeIncidents.filter((i) => i.category === "workflow_stuck").length;
    const deliveryFailureCount = activeIncidents.filter((i) => i.category === "sms_delivery_failed").length;

    return {
      automationId: definition.id,
      automationName: definition.name,
      status: automationStatus(criticalIncidentCount, activeIncidents.length, recentFailures),
      activeIncidentCount: activeIncidents.length,
      criticalIncidentCount,
      recentFailures,
      recentSuccesses,
      failureRate,
      lastExecutionAt,
      // Not separately tracked from getWorkflowNameStats today - only the
      // single most recent execution's status is known per workflow name,
      // not a full per-status timeline - so these mirror lastExecutionAt
      // only when that most recent execution matches, and are null
      // otherwise, per the explicit "return null where a metric cannot be
      // meaningfully calculated" rule rather than a misleading guess.
      lastSuccessAt: relevantStats.some((s) => s.lastStatus === "completed") ? (relevantStats.find((s) => s.lastStatus === "completed")?.lastExecutionAt ?? null) : null,
      lastFailureAt: relevantStats.some((s) => s.lastStatus === "failed") ? (relevantStats.find((s) => s.lastStatus === "failed")?.lastExecutionAt ?? null) : null,
      stuckExecutionCount,
      deliveryFailureCount,
    };
  });
}

export async function getLatestHealthCheckRun(supabase: SupabaseClient): Promise<HealthCheckRun | null> {
  const { data, error } = await supabase.from("automation_health_check_runs").select("checked_at, stuck_count, incidents_opened, incidents_resolved").order("checked_at", { ascending: false }).limit(1).maybeSingle();

  if (error || !data) return null;
  return { checkedAt: data.checked_at, stuckCount: data.stuck_count, incidentsOpened: data.incidents_opened, incidentsResolved: data.incidents_resolved };
}
