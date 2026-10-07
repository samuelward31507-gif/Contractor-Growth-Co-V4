import { reportOpsAlert, type OpsAlertResult } from "@/lib/ops/alert";
import type { SchedulerWatchdogResult } from "./scheduler-watchdog";

/**
 * Final Batch 4: the operator-facing outcome of one scheduler-watchdog run.
 * The watchdog runs once a day (vercel.json), so emailing here can never
 * storm. A healthy run reports nothing.
 */
export type WatchdogOutcome = { kind: "threw"; errorType: string } | { kind: "ran"; result: SchedulerWatchdogResult };

export async function reportSchedulerWatchdogOutcome(outcome: WatchdogOutcome, report: typeof reportOpsAlert = reportOpsAlert): Promise<OpsAlertResult | null> {
  if (outcome.kind === "threw") {
    return report({
      severity: "critical",
      source: "automation.scheduler_watchdog",
      code: "scheduler_watchdog_failed",
      message: "The daily scheduler watchdog itself failed, so scheduler health is unknown.",
      context: { errorType: outcome.errorType },
      notify: true,
    });
  }
  const { result } = outcome;
  if (result.heartbeatReadFailed) {
    return report({
      severity: "critical",
      source: "automation.scheduler_watchdog",
      code: "scheduler_heartbeat_unreadable",
      message: "The scheduler watchdog could not read the health-check heartbeat; scheduler health is unknown.",
      notify: true,
    });
  }
  if (result.degraded) {
    return report({
      severity: "critical",
      source: "automation.scheduler_watchdog",
      code: "scheduler_degraded",
      message: result.heartbeatStale
        ? "The 15-minute health tick has not completed recently - scheduled automation may have stopped."
        : "One or more scheduled automations have not run recently.",
      context: {
        heartbeatStale: result.heartbeatStale,
        lastHeartbeatAt: result.lastHeartbeatAt,
        staleAutomationCount: result.staleAutomations.length,
        staleAutomations: result.staleAutomations.join(","),
        ownersNotified: result.alert?.notified ?? 0,
      },
      notify: true,
    });
  }
  return null;
}
