import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getWorkflowNameStats } from "@/lib/automation/queries";
import { AUTOMATION_CATALOG } from "@/lib/automation/catalog";
import { resolveDateRange } from "@/lib/bi/queries";
import { listIncidents } from "./queries";
import { computeScheduledAutomationLivenessState, SCHEDULED_AUTOMATION_IDS } from "./scheduled-automation-liveness";
import type { OrganizationPaymentStatus } from "@/lib/auth/organization";
import type { AutomationHealthStatus, AutomationHealthSummary, HealthCheckRun, OrganizationHealthStatus, OrganizationHealthSummary } from "./types";

/**
 * Deterministic health calculation - never subjective, never AI-generated.
 * Reuses lib/bi's existing AutomationMetrics/getWorkflowNameStats (last 30
 * days / last MAX_EXECUTION_ROWS executions, exactly as the Automation
 * Control Center already computes them) rather than recomputing execution
 * statistics a second time - this layer's own job is strictly to summarize
 * automation_incidents on top of that existing data, not to duplicate it.
 */

/**
 * Pass 5A precedence, most-truthful-first: a payment block always wins over
 * a pause (the org can't be meaningfully "paused" vs "not paused" while
 * automation is blocked for a more fundamental reason), which always wins
 * over incident-derived status, which always wins over a stale scheduled
 * automation, which always wins over "healthy". This is the fix for the
 * Pass 5 audit's own finding: SystemStatus previously derived health only
 * from incidents/workflow success, so a payment-blocked or
 * intentionally-paused organization with zero incidents could read as
 * "Running normally" - it never can now. A stale scheduled automation can
 * only ever reach "degraded", never "unhealthy": it is a real but unproven
 * signal (see scheduled-automation-liveness.ts's own documented uncertainty
 * about the true expected cadence), not confirmed critical failure.
 */
export function organizationStatus(params: {
  paymentStatus: OrganizationPaymentStatus;
  automationPaused: boolean;
  criticalCount: number;
  activeCount: number;
  staleScheduledAutomationCount: number;
}): OrganizationHealthStatus {
  if (params.paymentStatus !== "active") return "payment_blocked";
  if (params.automationPaused) return "paused";
  if (params.criticalCount > 0) return "unhealthy";
  if (params.activeCount > 0 || params.staleScheduledAutomationCount > 0) return "degraded";
  return "healthy";
}

/**
 * Performance Pass 3: every input computeOrganizationHealth() needs, from one
 * read-only database function (supabase/migrations/20260930044405_organization_health_inputs.sql)
 * instead of six PostgREST requests - getAutomationOverview (two reads, of
 * which only the window's completed/failed workflow counts were ever used),
 * getWorkflowNameStats, listIncidents, the organizations payment/pause pair,
 * and the scheduled-automation liveness RPC. The function returns exactly
 * those inputs under the same row caps, orderings and RLS; the calculation
 * below is unchanged.
 */
type OrganizationHealthInputs = {
  window_status_counts?: { completed?: number; failed?: number } | null;
  name_stats?: { workflow_name: string; last_status: string | null; last_execution_at: string | null; failed: number }[] | null;
  incidents?: { category: string; severity: string }[] | null;
  organization?: { payment_status?: string | null; automation_paused?: boolean | null } | null;
  liveness?: { automation_id: string; last_ran_at: string | null; last_candidate_count: number | null }[] | null;
};

async function computeOrganizationHealth(supabase: SupabaseClient, organizationId: string): Promise<OrganizationHealthSummary> {
  // The same last-30-days window getAutomationOverview() used, passed in so
  // the bounds are byte-identical (resolveDateRange works in the server's
  // local time; the database function does no date arithmetic of its own).
  const range = resolveDateRange("last30Days");
  const { data, error } = await supabase.rpc("organization_health_inputs", {
    p_organization_id: organizationId,
    p_executions_from: range.from,
    p_executions_to: range.to,
  });
  // A failed read degrades exactly like each of the six old reads did on its
  // own failure: zero workflow counts, no name stats, no incidents, no
  // organization row (-> fails closed to payment_required below), and no
  // liveness rows (-> every scheduled automation "unverified", never stale).
  const incidentsUnavailable = error != null || !data;
  const inputs: OrganizationHealthInputs = incidentsUnavailable ? {} : (data as OrganizationHealthInputs);

  const overview = { completedWorkflows: inputs.window_status_counts?.completed ?? 0, failedWorkflows: inputs.window_status_counts?.failed ?? 0 };
  // One entry per workflow_name (the function groups by it), as getWorkflowNameStats' map values were.
  const workflowNameStats = (inputs.name_stats ?? []).map((row) => ({ lastStatus: row.last_status, lastExecutionAt: row.last_execution_at, failed: row.failed }));
  const activeIncidents = inputs.incidents ?? [];
  const organizationRow = { data: inputs.organization ?? null };
  const livenessRows = inputs.liveness ?? [];
  const scheduledLiveness = SCHEDULED_AUTOMATION_IDS.map((automationId) => ({
    state: computeScheduledAutomationLivenessState(livenessRows.find((row) => row.automation_id === automationId)?.last_ran_at ?? null),
  }));

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
  for (const stats of workflowNameStats) {
    if (stats.lastStatus === "completed" && stats.lastExecutionAt) {
      if (!lastSuccessfulActivityAt || stats.lastExecutionAt > lastSuccessfulActivityAt) lastSuccessfulActivityAt = stats.lastExecutionAt;
    }
    if (stats.failed > 0 && stats.lastExecutionAt) {
      if (!lastFailureAt || stats.lastExecutionAt > lastFailureAt) lastFailureAt = stats.lastExecutionAt;
    }
  }

  const successRate =
    overview.completedWorkflows + overview.failedWorkflows === 0 ? null : (overview.completedWorkflows / (overview.completedWorkflows + overview.failedWorkflows)) * 100;

  // Fails closed exactly like lib/auth/organization.ts's own
  // resolveOrganization(): a query error or missing row is never treated as
  // "payment is fine" - it resolves to the same gated default that column's
  // own NOT NULL default already uses for a brand-new organization.
  const rawPaymentStatus = organizationRow.data?.payment_status;
  const paymentStatus: OrganizationPaymentStatus =
    rawPaymentStatus === "active" || rawPaymentStatus === "suspended" || rawPaymentStatus === "cancelled" ? rawPaymentStatus : "payment_required";
  const automationPaused = organizationRow.data?.automation_paused === true;
  const staleScheduledAutomationCount = scheduledLiveness.filter((liveness) => liveness.state === "stale").length;

  return {
    organizationId,
    status: organizationStatus({
      paymentStatus,
      automationPaused,
      criticalCount: incidentCounts.critical,
      activeCount: incidentCounts.activeTotal,
      staleScheduledAutomationCount,
    }),
    activeIncidentCount: incidentCounts.activeTotal,
    criticalIncidentCount: incidentCounts.critical,
    warningIncidentCount: incidentCounts.warning,
    infoIncidentCount: incidentCounts.info,
    stuckExecutionCount: activeByCategory.workflow_stuck ?? 0,
    smsDeliveryFailureCount: activeByCategory.sms_delivery_failed ?? 0,
    paymentStatus,
    automationPaused,
    staleScheduledAutomationCount,
    humanEscalationCount: activeByCategory.human_escalation_requested ?? 0,
    failedWorkflowExecutions: overview.failedWorkflows,
    automationSuccessRate: successRate,
    lastSuccessfulActivityAt,
    lastFailureAt,
    // Phase 3E: lets a caller tell "no incidents" from "incidents unreadable".
    incidentsUnavailable,
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

/**
 * Phase 2A-1: request-scoped memoization (React.cache, the Pass B pattern in
 * lib/auth/request-context.ts). Within one server request, callers that ask
 * for the same organization's health through the same Supabase client - the
 * top bar, the daily briefing and the end-of-day summary on the Dashboard -
 * now share one computation instead of each running it. The cache key is
 * the (client, organizationId) pair, so a different client (e.g. the
 * service-role client) or a different organization never shares a result,
 * and nothing is kept once the request ends. Outside a React server render
 * (route handlers, scripts, tests) it simply calls through. The health
 * computation itself is unchanged.
 */
export const getOrganizationHealth = cache(computeOrganizationHealth);
