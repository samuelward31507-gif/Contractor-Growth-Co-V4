import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { recordAutomationHealthSignal } from "@/lib/automation-health/service";
import { getAutomationForWorkflowName } from "@/lib/automation/catalog";
import { getScheduledAutomationLiveness } from "@/lib/automation-health/scheduled-automation-liveness";
import { evaluateScheduledAutomationDegradedAlert } from "@/lib/automation-health/scheduled-automation-alert";
import { EXECUTION_TIMEOUT_MINUTES, failTimedOutExecutions } from "@/lib/automation/execution-timeout";
import { classifyFailedExecutions, processDueRetries } from "@/lib/automation/execution-retry";
import { dispatchDueFollowups } from "@/lib/followups/engine";
import { runTickPhase } from "@/lib/automation-health/tick-phase";
import { reportOpsAlert } from "@/lib/ops/alert";
import { assessHealthTick } from "@/lib/automation-health/tick-assessment";

/**
 * Read-only operational check for workflow_executions rows stuck in
 * status='running' - the dispatch model assumes every started execution is
 * eventually completed or failed by the n8n callback route, so a row still
 * 'running' past a generous threshold means that callback never arrived
 * (n8n misconfiguration, a dead callback URL, a stuck n8n workflow, etc.),
 * not a normal in-flight state. Same CRON_SECRET bearer pattern as the
 * other automation routes; not wired into vercel.json's cron schedule here
 * - that's a separate decision for whoever operates this.
 *
 * Deliberately returns only id/organization_id/workflow_name/attempt/
 * started_at - never error_message or metadata, since those may echo
 * upstream provider error text this route has no way to guarantee is free
 * of sensitive detail.
 *
 * Automation Health + Alerting V1: this is also the one place
 * workflow_stuck incidents are detected (per stuck row found) and stale
 * ones auto-resolved (via resolve_stale_stuck_incidents, once execution has
 * since left 'running') - see lib/automation-health/service.ts. This
 * endpoint was already the sole existing stuck-execution scan (both here and
 * in lib/agency/health.ts, which reads the same rows for display only, never
 * writes an incident) - extending it in place, rather than adding a second
 * scan, keeps exactly one query doing the actual detection work. Each
 * invocation is also logged to automation_health_check_runs (a global
 * heartbeat, not per-organization - see that table's own migration comment)
 * so "is Trackpr's own health-check job even running" is answerable.
 *
 * Final Batch 4: each phase runs isolated (runTickPhase) - one phase
 * throwing no longer silently aborts every phase after it. A failed phase is
 * a structured ops alert, the response is HTTP 500 with the failed phases
 * listed, and NO heartbeat row is written for that tick: the heartbeat means
 * "a complete tick ran", so a phase that keeps failing still turns the
 * heartbeat stale and the scheduler watchdog still catches it. A heartbeat
 * insert that fails is reported too, rather than ignored.
 */
const STUCK_THRESHOLD_MINUTES = 30;
const MAX_ROWS = 100;

function isAuthorized(request: NextRequest): boolean {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) return false;

  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;

  const expected = Buffer.from(`Bearer ${configuredSecret}`);
  const actual = Buffer.from(authHeader);
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}

/** Failed-execution window for this endpoint's headline count - bounded, matching STUCK_THRESHOLD_MINUTES's own "recent, actionable window" spirit rather than an unbounded all-time count. */
const FAILED_EXECUTION_WINDOW_HOURS = 24;

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const thresholdIso = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();
  const failedSinceIso = new Date(Date.now() - FAILED_EXECUTION_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  // Executions running past EXECUTION_TIMEOUT_MINUTES (well beyond the
  // stuck threshold) are failed first, through the normal fail machinery,
  // so their events become failed/retryable instead of 'processing'
  // forever. Their earlier workflow_stuck incidents are then auto-resolved
  // below by resolve_stale_stuck_incidents, since they have left 'running'.
  const phaseFailures: string[] = [];
  const phase = async <T,>(name: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    const result = await runTickPhase(name, run);
    if (result.ok) return result.value;
    phaseFailures.push(name);
    return fallback;
  };

  const timeout = await phase("execution_timeout", () => failTimedOutExecutions(service), { timedOut: [], errors: 0 });

  // P0 A2: every failed execution (including the timeouts just failed) gets
  // one durable retry decision, then due retries run through the same path
  // as a staff retry - gate and all. See lib/automation/execution-retry.ts.
  const retryDecisions = await phase("retry_classification", () => classifyFailedExecutions(service), { decided: [], errors: 0 });
  const retries = await phase("retry_processing", () => processDueRetries(service), { started: [], stopped: [], errors: 0 });

  // P0 A4: the Follow-Up Engine's single dispatcher runs on this same tick
  // (no new scheduler). Only follow-ups an organization enabled exist.
  const followups = await phase("followup_dispatch", () => dispatchDueFollowups(service), [] as Awaited<ReturnType<typeof dispatchDueFollowups>>);

  const { data: stuck, error } = await service
    .from("workflow_executions")
    .select("id, organization_id, workflow_name, attempt, started_at")
    .eq("status", "running")
    .lt("started_at", thresholdIso)
    .order("started_at", { ascending: true })
    .limit(MAX_ROWS);

  if (error) {
    await reportOpsAlert({ severity: "critical", source: "automation.health", code: "health_tick_stuck_scan_failed", message: "The health tick could not read workflow executions; no heartbeat was recorded." });
    return NextResponse.json({ ok: false, error: "Could not query workflow executions.", failedPhases: [...phaseFailures, "stuck_scan"] }, { status: 500 });
  }

  // One incident signal per stuck row - collapses correctly across repeated
  // ticks (fingerprint context is the execution id), never floods.
  let incidentsOpened = 0;
  await phase("stuck_incidents", async () => {
    for (const row of stuck) {
      const automation = getAutomationForWorkflowName(row.workflow_name);
      const incident = await recordAutomationHealthSignal(service, {
        organizationId: row.organization_id,
        category: "workflow_stuck",
        severity: "warning",
        fingerprintContext: row.id,
        title: `${automation?.name ?? row.workflow_name} execution stuck`,
        description: `Running for over ${STUCK_THRESHOLD_MINUTES} minutes with no callback.`,
        automationId: automation?.id ?? null,
        workflowExecutionId: row.id,
      });
      if (incident && incident.occurrenceCount === 1) incidentsOpened += 1;
    }
  }, undefined);

  const resolvedCount = await phase("stuck_incident_resolution", async () => (await service.rpc("resolve_stale_stuck_incidents")).data, null);
  const incidentsResolved = typeof resolvedCount === "number" ? resolvedCount : 0;

  // Pass 5A: evaluates each of the 5 scheduled (cron-dependent) automations'
  // liveness on every tick - a pure, computed-live read (never a persisted
  // incident), so "avoid duplicate incidents" and "resolve when execution
  // resumes" are both trivially true by construction: there is nothing to
  // duplicate, and fresh evidence from any route's next invocation is
  // reflected on the very next read with no separate resolution step. See
  // lib/automation-health/scheduled-automation-liveness.ts's own header
  // comment for the full reasoning.
  const scheduledLiveness = await phase("scheduled_liveness", () => getScheduledAutomationLiveness(service), [] as Awaited<ReturnType<typeof getScheduledAutomationLiveness>>);
  const staleScheduledAutomations = scheduledLiveness.filter((liveness) => liveness.state === "stale");

  // Pass 5C Batch 7, Item 2: fans the one, already-computed, global stale
  // fact above out to a proactive owner notification per eligible
  // organization - see scheduled-automation-alert.ts's own header comment
  // for the full dedup/recovery reasoning. Best-effort by construction
  // (recordAutomationHealthSignal/notifyFounder never throw) - a failure
  // here must never fail this health-check tick's own reporting.
  if (!phaseFailures.includes("scheduled_liveness")) {
    await phase("scheduled_degraded_alert", () => evaluateScheduledAutomationDegradedAlert(service, staleScheduledAutomations.length > 0), undefined);
  }

  const [{ count: failedExecutionCount, error: failedCountError }, { count: criticalIncidentCount, error: criticalCountError }, { count: warningIncidentCount, error: warningCountError }] = await Promise.all([
    service.from("workflow_executions").select("id", { count: "exact", head: true }).eq("status", "failed").gte("started_at", failedSinceIso),
    service.from("automation_incidents").select("id", { count: "exact", head: true }).eq("severity", "critical").in("status", ["open", "acknowledged"]),
    service.from("automation_incidents").select("id", { count: "exact", head: true }).eq("severity", "warning").in("status", ["open", "acknowledged"]),
  ]);

  // Final Batch 4: the heartbeat records a COMPLETE tick only (see header).
  let heartbeatRecorded = false;
  if (phaseFailures.length === 0) {
    const { error: heartbeatError } = await service.from("automation_health_check_runs").insert({
      stuck_count: stuck.length,
      incidents_opened: incidentsOpened,
      incidents_resolved: incidentsResolved,
    });
    heartbeatRecorded = !heartbeatError;
    if (heartbeatError) {
      await reportOpsAlert({ severity: "critical", source: "automation.health", code: "health_heartbeat_write_failed", message: "The health tick ran but could not record its heartbeat; the scheduler watchdog will report it as stale." });
    }
  }

  // Batch 4 (operations hardening): the tick's verdict - an unread count is
  // unknown (never 0), a phase that swallowed its own error is degraded, and
  // executions Trackpr stopped retrying leave a structured operator line.
  // What the tick DID (phases, retries, heartbeat rule) is unchanged.
  const assessment = assessHealthTick({
    phaseFailures,
    phaseErrorCounts: { execution_timeout: timeout.errors, retry_classification: retryDecisions.errors, retry_processing: retries.errors },
    counts: {
      failedExecutions: failedCountError ? null : (failedExecutionCount ?? 0),
      criticalIncidents: criticalCountError ? null : (criticalIncidentCount ?? 0),
      warningIncidents: warningCountError ? null : (warningIncidentCount ?? 0),
    },
    stuckCount: stuck.length,
    staleScheduledAutomationCount: staleScheduledAutomations.length,
    heartbeatRecorded,
    retryDecisions: retryDecisions.decided,
  });
  for (const alert of assessment.alerts) await reportOpsAlert(alert);

  const tickOk = assessment.ok;
  return NextResponse.json({
    ok: tickOk,
    status: assessment.status,
    failedPhases: phaseFailures,
    phaseErrors: assessment.phaseErrors,
    countsUnavailable: assessment.countsUnavailable,
    stoppedRetrying: assessment.stoppedRetrying,
    heartbeatRecorded,
    timestamp: new Date().toISOString(),
    thresholdMinutes: STUCK_THRESHOLD_MINUTES,
    stuckCount: stuck.length,
    stuck,
    executionTimeoutMinutes: EXECUTION_TIMEOUT_MINUTES,
    timedOutCount: timeout.timedOut.length,
    timedOut: timeout.timedOut,
    retryDecisions: retryDecisions.decided,
    retriesStarted: retries.started,
    retriesStopped: retries.stopped,
    followupsDispatched: followups.length,
    followupOutcomes: followups.map((f) => f.outcome),
    failedExecutionCount: failedCountError ? null : (failedExecutionCount ?? 0),
    failedExecutionWindowHours: FAILED_EXECUTION_WINDOW_HOURS,
    activeCriticalIncidents: criticalCountError ? null : (criticalIncidentCount ?? 0),
    activeWarningIncidents: warningCountError ? null : (warningIncidentCount ?? 0),
    incidentsOpened,
    incidentsResolved,
    scheduledAutomationLiveness: scheduledLiveness,
    staleScheduledAutomationCount: staleScheduledAutomations.length,
    // Configuration-derived only, never a live probe - see this route's own
    // header comment on why n8n/Twilio are never pinged from here. A real
    // outage of either is what the dispatch/send-failure incident detectors
    // (lib/automation/executions.ts) already surface, not a synthetic ping.
    providerStatus: process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER ? "configured" : "not_configured",
    n8nStatus: process.env.N8N_BASE_URL && process.env.N8N_WEBHOOK_SECRET ? "configured" : "not_configured",
    database: "available",
  }, { status: tickOk ? 200 : 500 });
}
