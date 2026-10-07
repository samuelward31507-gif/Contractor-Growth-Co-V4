import { reportOpsAlert } from "@/lib/ops/alert";

/**
 * Final Batch 4: runs one independent phase of the 15-minute health tick
 * (app/api/automation/health) so that one phase throwing can no longer abort
 * every phase after it. A failure is reported as a structured ops alert
 * (log only - the tick runs every 15 minutes, so no email here; the
 * once-daily watchdog emails) and returned, never rethrown. The phase's own
 * behavior is unchanged: this only catches what it throws.
 */
export type TickPhaseResult<T> = { ok: true; value: T } | { ok: false; phase: string };

export async function runTickPhase<T>(phase: string, run: () => Promise<T>, report: typeof reportOpsAlert = reportOpsAlert): Promise<TickPhaseResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    await report({
      severity: "critical",
      source: "automation.health",
      code: "health_tick_phase_failed",
      message: `The health tick's "${phase}" phase failed; the remaining phases still ran and no heartbeat was recorded for this tick.`,
      context: { phase, errorType: error instanceof Error ? error.name : typeof error },
    });
    return { ok: false, phase };
  }
}
