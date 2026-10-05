import type { SupabaseClient } from "@supabase/supabase-js";
import { failWorkflowExecutionAsService } from "@/lib/automation/executions";

/**
 * Stuck-execution timeout. Every dispatched execution is expected to be
 * completed or failed by its callback within minutes; one still 'running'
 * this long never will be (n8n crashed mid-run, a dead callback URL, a lost
 * delivery). Left alone it stays 'running' forever and its event stays
 * 'processing' - invisible to retry, since only a failed event is retryable.
 *
 * Deliberately conservative: double the 30-minute workflow_stuck incident
 * threshold in app/api/automation/health/route.ts, so an execution is first
 * reported stuck and only failed well after that.
 *
 * Uses the existing fail machinery (fail_workflow_execution via
 * failWorkflowExecutionAsService): the execution becomes 'failed', its
 * event becomes 'failed' and retryable, and a workflow_failed incident is
 * recorded. Sends nothing to the customer. Idempotent: the RPC only fails a
 * row still 'running', so a repeated tick or a concurrent callback never
 * double-fails, and a callback arriving after the timeout finds the
 * execution no longer running and is ignored by the callback route's
 * alreadyProcessed short-circuit (no AI processing, no send).
 */
export const EXECUTION_TIMEOUT_MINUTES = 60;
const MAX_TIMEOUTS_PER_RUN = 100;

export type ExecutionTimeoutResult = {
  timedOut: { id: string; organization_id: string; workflow_name: string }[];
  errors: number;
};

export async function failTimedOutExecutions(service: SupabaseClient, now: Date = new Date()): Promise<ExecutionTimeoutResult> {
  const cutoffIso = new Date(now.getTime() - EXECUTION_TIMEOUT_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await service
    .from("workflow_executions")
    .select("id, organization_id, workflow_name, started_at")
    .eq("status", "running")
    .lt("started_at", cutoffIso)
    .order("started_at", { ascending: true })
    .limit(MAX_TIMEOUTS_PER_RUN);

  const result: ExecutionTimeoutResult = { timedOut: [], errors: 0 };
  if (error || !data) {
    if (error) console.error("[automation] execution timeout scan failed", { error: error.message });
    return { ...result, errors: error ? 1 : 0 };
  }

  for (const row of data as { id: string; organization_id: string; workflow_name: string }[]) {
    const failed = await failWorkflowExecutionAsService(
      service,
      row.id,
      `execution_timeout: no callback after ${EXECUTION_TIMEOUT_MINUTES} minutes`,
      "workflow_failed",
    );
    if (!failed.ok) {
      // "Execution is not running" here means a callback settled it between
      // the scan and this call - benign, nothing was timed out.
      if (failed.error !== "Execution is not running") {
        result.errors += 1;
        console.error("[automation] failed to time out execution", { executionId: row.id, error: failed.error });
      }
      continue;
    }
    // failWorkflowExecutionAsService returns ok with the settled row when
    // something else already completed/failed it first - only count rows
    // this call actually failed.
    if (failed.execution.status === "failed" && failed.execution.error_message?.startsWith("execution_timeout:")) {
      result.timedOut.push({ id: row.id, organization_id: row.organization_id, workflow_name: row.workflow_name });
    }
  }
  return result;
}
