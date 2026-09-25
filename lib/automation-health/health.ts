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

  // HANDOFF-01: a human escalation is the system correctly asking for a
  // normal business judgment call, not a malfunction - unlike every other
  // incident category, it must never count toward this organization's
  // automation health status (activeTotal/critical/warning below feed
  // organizationStatus() directly). It is still fully counted in
  // activeByCategory above, and surfaced in its own dedicated
  // humanEscalationCount field.
  const healthRelevantIncidents = activeIncidents.filter((i) => i.category !== "human_escalation_requested");

  const incidentCounts = {
    activeTotal: healthRelevantIncidents.length,
    critical: healthRelevantIncidents.filter((i) => i.severity === "critical").length,
    warning: healthRelevantIncidents.filter((i) => i.severity === "warning").length,
    info: healthRelevantIncidents.filter((i) => i.severity === "info").length,
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
    humanEscalationCount: activeByCategory.human_escalation_requested ?? 0,
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

/**
 * SCHED-01 (pre-launch lead-leak audit): the health-check job itself is
 * invoked by an external n8n Schedule Trigger every 15 minutes - if that
 * scheduler stopped (deactivated, n8n outage), automation_health_check_runs
 * simply stops growing, and nothing would otherwise ever say so. A pure,
 * unit-testable predicate rather than inline page logic, so this specific
 * behavior can be verified without a real Supabase round trip. 45 minutes
 * (3x the 15-minute interval) mirrors STUCK_THRESHOLD_MINUTES's own
 * "generous buffer" reasoning, tolerating a couple of missed ticks before
 * alarming. No run at all is treated as stale too - "never ran" is at least
 * as concerning as "ran, but a while ago".
 */
export const HEALTH_CHECK_STALE_THRESHOLD_MS = 45 * 60 * 1000;

export function isHealthCheckStale(lastCheckedAtIso: string | null, nowMs: number = Date.now()): boolean {
  if (!lastCheckedAtIso) return true;
  return nowMs - new Date(lastCheckedAtIso).getTime() > HEALTH_CHECK_STALE_THRESHOLD_MS;
}

export async function getLatestHealthCheckRun(supabase: SupabaseClient): Promise<HealthCheckRun | null> {
  const { data, error } = await supabase.from("automation_health_check_runs").select("checked_at, stuck_count, incidents_opened, incidents_resolved").order("checked_at", { ascending: false }).limit(1).maybeSingle();

  if (error || !data) return null;
  return { checkedAt: data.checked_at, stuckCount: data.stuck_count, incidentsOpened: data.incidents_opened, incidentsResolved: data.incidents_resolved };
}
