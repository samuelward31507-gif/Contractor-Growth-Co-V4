import type { OpsAlert } from "@/lib/ops/alert";

/**
 * Batch 4 (production operations hardening): the truthful verdict of one
 * health tick (app/api/automation/health). Pure, so every outcome is
 * testable. It changes nothing about what the tick does - which phases
 * run, the retry decisions, the heartbeat rule (a heartbeat only for a tick
 * with no failed phase) - only what the tick REPORTS:
 *
 *   - a phase that swallowed its own error (it returned `errors > 0`
 *     instead of throwing - e.g. the retry classifier could not read
 *     failed executions) is a degraded tick, never "healthy";
 *   - an incident / failed-execution count that could not be read is
 *     "unknown", never 0 - so the tick can never say "healthy" about
 *     numbers it did not see;
 *   - executions Trackpr stopped retrying (exhausted, or not safely
 *     retryable) get one structured operator line per tick, with ids only.
 *
 * Every alert here is log-only (`notify` false): the tick runs every 15
 * minutes, so paging stays with the once-daily scheduler watchdog.
 */
export type TickHealthStatus = "healthy" | "degraded" | "unhealthy";

export type TickAssessmentInput = {
  /** Phases that threw (runTickPhase contained them). */
  phaseFailures: string[];
  /** Phases that finished but reported internal errors (their own `errors` count). */
  phaseErrorCounts: Record<string, number>;
  /** null = the count could not be read. */
  counts: { failedExecutions: number | null; criticalIncidents: number | null; warningIncidents: number | null };
  stuckCount: number;
  staleScheduledAutomationCount: number;
  heartbeatRecorded: boolean;
  retryDecisions: { id: string; retryState: string }[];
};

export type TickAssessment = {
  /** The tick completed: no phase threw and the heartbeat was written (unchanged meaning). */
  ok: boolean;
  status: TickHealthStatus;
  /** Phases that finished with internal errors. */
  phaseErrors: string[];
  /** Counts that could not be read. */
  countsUnavailable: string[];
  /** Executions Trackpr will not retry on its own this tick. */
  stoppedRetrying: { exhausted: number; notRetryable: number };
  alerts: OpsAlert[];
};

/** 5 UUIDs fit the alert sanitizer's 200-character string limit. */
const MAX_IDS_IN_CONTEXT = 5;

export function assessHealthTick(input: TickAssessmentInput): TickAssessment {
  const phaseErrors = Object.entries(input.phaseErrorCounts)
    .filter(([, count]) => count > 0)
    .map(([phase]) => phase);
  const countsUnavailable = Object.entries(input.counts)
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  const exhausted = input.retryDecisions.filter((decision) => decision.retryState === "exhausted");
  const notRetryable = input.retryDecisions.filter((decision) => decision.retryState === "not_retryable");

  const ok = input.phaseFailures.length === 0 && input.heartbeatRecorded;
  const observedStatus: TickHealthStatus =
    (input.counts.criticalIncidents ?? 0) > 0
      ? "unhealthy"
      : (input.counts.warningIncidents ?? 0) > 0 || input.stuckCount > 0 || input.staleScheduledAutomationCount > 0
        ? "degraded"
        : "healthy";
  // An incomplete tick, a swallowed phase error or an unread count can never report "healthy".
  const status: TickHealthStatus = !ok || phaseErrors.length > 0 || countsUnavailable.length > 0 ? (observedStatus === "unhealthy" ? "unhealthy" : "degraded") : observedStatus;

  const alerts: OpsAlert[] = [];
  if (phaseErrors.length > 0) {
    alerts.push({
      severity: "warning",
      source: "automation.health",
      code: "health_tick_phase_errors",
      message: "A health tick phase finished with internal errors; part of the automation runtime was not checked this tick.",
      context: { phases: phaseErrors.join(","), errorCount: phaseErrors.reduce((sum, phase) => sum + input.phaseErrorCounts[phase], 0) },
    });
  }
  if (countsUnavailable.length > 0) {
    alerts.push({
      severity: "warning",
      source: "automation.health",
      code: "health_tick_counts_unavailable",
      message: "The health tick could not read incident or failed-execution counts; its status is reported as degraded, not healthy.",
      context: { counts: countsUnavailable.join(",") },
    });
  }
  if (exhausted.length + notRetryable.length > 0) {
    alerts.push({
      severity: "warning",
      source: "automation.health",
      code: "executions_stopped_retrying",
      message: "Trackpr stopped retrying one or more failed executions; each now needs a person (shown on the organization's Today).",
      context: {
        exhausted: exhausted.length,
        notRetryable: notRetryable.length,
        executionIds: [...exhausted, ...notRetryable]
          .slice(0, MAX_IDS_IN_CONTEXT)
          .map((decision) => decision.id)
          .join(","),
      },
    });
  }

  return { ok, status, phaseErrors, countsUnavailable, stoppedRetrying: { exhausted: exhausted.length, notRetryable: notRetryable.length }, alerts };
}
