/**
 * Automation Health + Alerting V1 - shared types.
 *
 * This is an observability/incident layer over the existing automation
 * system (automation_events, workflow_executions, messages, ai_interactions)
 * - it introduces no new automation engine and dispatches nothing itself.
 */

import type { OrganizationPaymentStatus } from "@/lib/auth/organization";

/** 'repeated_workflow_failure' is never requested directly by a caller - it is only ever produced by record_automation_incident_signal's own escalation logic (occurrence_count >= 3 on an active 'workflow_failed' incident). See that RPC's own comment for the exact, documented threshold. */
export type IncidentCategory =
  | "workflow_failed"
  | "repeated_workflow_failure"
  | "workflow_stuck"
  | "n8n_dispatch_failed"
  | "n8n_callback_failed"
  | "sms_send_failed"
  | "sms_delivery_failed"
  | "human_escalation_requested";

/** The subset of categories a caller of recordAutomationHealthSignal may request directly. */
export type RecordableIncidentCategory = Exclude<IncidentCategory, "repeated_workflow_failure">;

export type IncidentSeverity = "info" | "warning" | "critical";
export type IncidentStatus = "open" | "acknowledged" | "resolved";

export type AutomationIncident = {
  id: string;
  organizationId: string;
  automationId: string | null;
  workflowExecutionId: string | null;
  category: IncidentCategory;
  severity: IncidentSeverity;
  status: IncidentStatus;
  fingerprint: string;
  title: string;
  description: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  resolvedAt: string | null;
  resolvedBy: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/** Raw shape of an automation_incidents row, as returned by Postgrest/the RPCs. */
export type AutomationIncidentRow = {
  id: string;
  organization_id: string;
  automation_id: string | null;
  workflow_execution_id: string | null;
  category: IncidentCategory;
  severity: IncidentSeverity;
  status: IncidentStatus;
  fingerprint: string;
  title: string;
  description: string | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  resolved_at: string | null;
  resolved_by: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export function mapIncidentRow(row: AutomationIncidentRow): AutomationIncident {
  return {
    id: row.id,
    organizationId: row.organization_id,
    automationId: row.automation_id,
    workflowExecutionId: row.workflow_execution_id,
    category: row.category,
    severity: row.severity,
    status: row.status,
    fingerprint: row.fingerprint,
    title: row.title,
    description: row.description,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    occurrenceCount: row.occurrence_count,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Pass 5A: widened from the original 3 (healthy/degraded/unhealthy) so
 * "intentionally paused" and "payment blocked" can never be misreported as
 * a random infrastructure failure, or silently read as healthy. Ordered by
 * precedence in organizationStatus() below (health.ts): a payment block
 * always wins over a pause, which always wins over an incident-derived
 * status, which always wins over "healthy" - see that function's own
 * comment for the exact rule.
 */
export type OrganizationHealthStatus = "healthy" | "degraded" | "unhealthy" | "paused" | "payment_blocked";

export type OrganizationHealthSummary = {
  organizationId: string;
  status: OrganizationHealthStatus;
  activeIncidentCount: number;
  criticalIncidentCount: number;
  warningIncidentCount: number;
  infoIncidentCount: number;
  stuckExecutionCount: number;
  smsDeliveryFailureCount: number;
  /** HANDOFF-01: a human escalation is not an automation malfunction, so it is deliberately excluded from activeIncidentCount/criticalIncidentCount/warningIncidentCount and the derived `status` above - tracked only in this dedicated field, mirroring smsDeliveryFailureCount's own shape. */
  humanEscalationCount: number;
  /** From lib/bi's own AutomationMetrics (last 30 days) - never recomputed here. */
  failedWorkflowExecutions: number;
  /** null when there is no completed-or-failed execution in the window to compute a rate from - never a fabricated 0%/100%. */
  automationSuccessRate: number | null;
  lastSuccessfulActivityAt: string | null;
  lastFailureAt: string | null;
  /** Pass 5A: the organization's raw payment_status (lib/auth/organization.ts), fetched alongside everything else here so a "payment_blocked" status can be labeled precisely (payment_required vs suspended vs cancelled) without a second query. */
  paymentStatus: OrganizationPaymentStatus;
  /** Pass 5A: the organization's raw automation_paused flag - kept alongside `status` (which already folds this in) so a caller can distinguish "paused" from a simultaneously-active incident without re-deriving it. */
  automationPaused: boolean;
  /** Pass 5A: how many of the 5 scheduled (cron-dependent) automations are currently "stale" (were observed running before, have gone quiet past their grace window) - never counts "unverified" (never observed) automations, which must never be treated as a fault. See lib/automation-health/scheduled-automation-liveness.ts. */
  staleScheduledAutomationCount: number;
  generatedAt: string;
};

export type AutomationHealthStatus = "healthy" | "degraded" | "unhealthy";

export type AutomationHealthSummary = {
  automationId: string;
  automationName: string;
  status: AutomationHealthStatus;
  activeIncidentCount: number;
  criticalIncidentCount: number;
  recentFailures: number;
  recentSuccesses: number;
  /** null when there is no completed-or-failed execution to compute a rate from. */
  failureRate: number | null;
  lastExecutionAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  stuckExecutionCount: number;
  deliveryFailureCount: number;
};

export type HealthCheckRun = {
  checkedAt: string;
  stuckCount: number;
  incidentsOpened: number;
  incidentsResolved: number;
};
