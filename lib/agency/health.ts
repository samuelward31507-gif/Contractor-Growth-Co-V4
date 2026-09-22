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

/** Mirrors lib/calendar/connection.ts's CalendarConnectionStatus, plus "not_connected" for an organization with no row at all - a valid, common state, never itself a problem. */
export type AgencyCalendarStatus = "connected" | "error" | "not_connected";

/** Mirrors organizations.payment_status's own check constraint exactly (see the organization_payment_status migration) - founder/admin-visible only, and this module never writes it: the column's own database trigger already rejects any non-service_role write, so there is no client-side modification path to weaken here or anywhere else. */
export type AgencyPaymentStatus = "payment_required" | "active" | "suspended" | "cancelled";

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
  /** Growth System Completion Pass 1: safe-metadata-only (status/last_error, never a token) - see getCalendarConnection's own documentation for why calendar_credentials is never touched from agency code. */
  calendarStatus: AgencyCalendarStatus;
  calendarLastError: string | null;
  /** Growth System Completion Pass 2, Part 9/10: read-only - see AgencyPaymentStatus's own documentation for why there is no write path to weaken. */
  paymentStatus: AgencyPaymentStatus;
  /** The same founder-facing kill switch evaluateOutboundGate already checks before every send (organizations.automation_paused) - surfaced here read-only so an agency admin can see a client is fully paused without opening that organization directly. */
  automationPaused: boolean;
  /** A simple, honest signal - not a score, not a ranking, and never a claim that automation or AI caused any outcome. True when at least one stuck execution, one failed execution, one failed message, one undelivered message, a broken (status: "error") calendar connection, automation paused, or payment suspended/cancelled was observed in the current period. A newly onboarding organization's payment_status of "payment_required" is deliberately excluded - that is an expected, transient state, not a regression, and flagging it would be a false positive. */
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

/**
 * Fast-Track Production Readiness, Pass 4: the only trigger for every
 * scheduled automation (appointment reminders, estimate follow-ups, lost-lead
 * nurture, lead reactivation) and for this very health-check sweep is an
 * external n8n Schedule Trigger - Vercel Cron was deliberately removed in
 * favor of it (see lib/automation/cron-auth.ts). If that external schedule
 * ever stops, nothing in Trackpr would notice on its own, because the one
 * place that would normally detect it (this health check) also only runs
 * when that same schedule fires it. automation_health_check_runs already
 * gets one row written every time /api/automation/health actually executes
 * (see that route) - the smallest possible heartbeat is to surface how long
 * ago that last happened, here, in the one place an operator already looks
 * (see AREA 8 of the pre-launch audit: "check the Agency Command Center
 * daily"). This never calls n8n or Vercel - it is purely a passive read of
 * data that already exists.
 */
const SCHEDULER_STALE_THRESHOLD_MINUTES = 120;

export type SchedulerHeartbeat = {
  lastCheckedAt: string | null;
  minutesSinceLastCheck: number | null;
  /** True both when the last run is older than the threshold AND when there has never been a run at all. */
  stale: boolean;
};

async function loadSchedulerHeartbeat(serviceSupabase: SupabaseClient): Promise<SchedulerHeartbeat> {
  const { data } = await serviceSupabase
    .from("automation_health_check_runs")
    .select("checked_at")
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.checked_at) {
    return { lastCheckedAt: null, minutesSinceLastCheck: null, stale: true };
  }

  const minutesSinceLastCheck = Math.round((Date.now() - new Date(data.checked_at).getTime()) / 60000);
  return {
    lastCheckedAt: data.checked_at,
    minutesSinceLastCheck,
    stale: minutesSinceLastCheck > SCHEDULER_STALE_THRESHOLD_MINUTES,
  };
}

export type AgencyHealthResult =
  | {
      ok: true;
      stuckThresholdMinutes: number;
      stuck: StuckExecution[];
      organizations: AgencyOrganizationHealth[];
      incidentRollup: AgencyIncidentRollup;
      schedulerHeartbeat: SchedulerHeartbeat;
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

type CalendarConnectionHealthRow = { organization_id: string; status: "connected" | "disconnected" | "error"; last_error: string | null };

/**
 * Growth System Completion Pass 1: scoped strictly to the already-authorized
 * organization ids (the same caller-verified list every other loader in this
 * file uses), and to exactly the two safe-metadata columns needed - never
 * account_email/calendar_id/calendar_name (not needed here), and never
 * calendar_credentials, which this module does not import a path to at all.
 */
async function loadCalendarHealth(serviceSupabase: SupabaseClient, organizationIds: string[]): Promise<Map<string, CalendarConnectionHealthRow>> {
  if (organizationIds.length === 0) return new Map();

  const { data } = await serviceSupabase
    .from("calendar_connections")
    .select("organization_id, status, last_error")
    .eq("provider", "google")
    .in("organization_id", organizationIds);

  return new Map(((data ?? []) as CalendarConnectionHealthRow[]).map((row) => [row.organization_id, row]));
}

type PaymentAndPauseRow = { id: string; payment_status: AgencyPaymentStatus; automation_paused: boolean | null };

/**
 * Growth System Completion Pass 2, Part 9/10: scoped strictly to the
 * already-authorized organization ids, and to exactly the two columns
 * needed here - never anything Stripe-adjacent (no card/invoice detail
 * exists on this table at all; payment_status is the whole of what
 * Trackpr's own payment gate tracks).
 */
async function loadPaymentAndPauseStatus(serviceSupabase: SupabaseClient, organizationIds: string[]): Promise<Map<string, PaymentAndPauseRow>> {
  if (organizationIds.length === 0) return new Map();

  const { data } = await serviceSupabase.from("organizations").select("id, payment_status, automation_paused").in("id", organizationIds);

  return new Map(((data ?? []) as PaymentAndPauseRow[]).map((row) => [row.id, row]));
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

  const [stuckRows, calendarHealthByOrg, paymentAndPauseByOrg] = await Promise.all([
    loadStuckExecutions(
      serviceSupabase,
      organizations.map((org) => org.organizationId),
      stuckThresholdMinutes,
    ),
    loadCalendarHealth(
      serviceSupabase,
      organizations.map((org) => org.organizationId),
    ),
    loadPaymentAndPauseStatus(
      serviceSupabase,
      organizations.map((org) => org.organizationId),
    ),
  ]);

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

    const calendarRow = calendarHealthByOrg.get(org.organizationId);
    const calendarStatus: AgencyCalendarStatus = !calendarRow ? "not_connected" : calendarRow.status === "error" ? "error" : "connected";
    const calendarLastError = calendarRow?.status === "error" ? calendarRow.last_error : null;

    const paymentAndPauseRow = paymentAndPauseByOrg.get(org.organizationId);
    const paymentStatus: AgencyPaymentStatus = paymentAndPauseRow?.payment_status ?? "payment_required";
    const automationPaused = paymentAndPauseRow?.automation_paused === true;
    const paymentProblem = paymentStatus === "suspended" || paymentStatus === "cancelled";

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
      calendarStatus,
      calendarLastError,
      paymentStatus,
      automationPaused,
      needsAttention:
        stuckExecutionCount > 0 ||
        failedWorkflowExecutions > 0 ||
        failedMessages > 0 ||
        undeliveredMessages > 0 ||
        calendarStatus === "error" ||
        automationPaused ||
        paymentProblem,
    };
  });

  const [incidentRollup, schedulerHeartbeat] = await Promise.all([
    loadIncidentRollup(
      serviceSupabase,
      organizations.map((org) => org.organizationId),
    ),
    loadSchedulerHeartbeat(serviceSupabase),
  ]);

  return {
    ok: true,
    stuckThresholdMinutes,
    stuck,
    organizations: orgHealth,
    incidentRollup,
    schedulerHeartbeat,
    generatedAt: new Date().toISOString(),
  };
}
