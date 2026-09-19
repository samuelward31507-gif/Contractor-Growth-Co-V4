import type { SupabaseClient } from "@supabase/supabase-js";
import { getAutomationAndFollowUpMetrics, resolveDateRange } from "@/lib/bi/queries";
import type { AutomationMetrics } from "@/lib/bi/types";
import { AUTOMATION_CATALOG, type AutomationDefinition } from "./catalog";

/**
 * Automation Control Center read layer - server-only, RLS-scoped by the
 * caller's own session client exactly like every other query in this
 * codebase (no organization id is ever accepted as a parameter and trusted;
 * callers pass an already-authenticated Supabase client, and every table
 * read here is protected by the same is_org_member() RLS policy as
 * everywhere else - see workflow_executions_select/automation_events_select
 * in the schema).
 *
 * Reuses lib/bi/queries.ts's getAutomationAndFollowUpMetrics for the
 * organization-wide summary (it already computes exactly that), and adds
 * only what does not already exist: a per-workflow-name status breakdown
 * (needed for "0 failures" per automation row, which the existing aggregate
 * - a single name -> count map with no status split - cannot answer) and a
 * bounded recent-executions list.
 */

const MAX_EXECUTION_ROWS = 500;
const DEFAULT_RECENT_LIMIT = 25;

export type WorkflowExecutionStatus = "running" | "completed" | "failed" | "cancelled";

export type WorkflowNameStats = {
  workflowName: string;
  total: number;
  completed: number;
  failed: number;
  running: number;
  cancelled: number;
  lastExecutionAt: string | null;
  lastStatus: WorkflowExecutionStatus | null;
};

export type WorkflowExecutionTriggerSource = "event" | "manual" | "retry";

export type AutomationExecutionRow = {
  id: string;
  workflowName: string;
  status: WorkflowExecutionStatus;
  attempt: number;
  startedAt: string;
  completedAt: string | null;
  triggerSource: WorkflowExecutionTriggerSource;
  /** Whether this execution recorded an error - never the raw error text itself. Matches app/api/automation/health/route.ts's own precedent: upstream dispatch/provider error text has no guaranteed-safe content, so it is never surfaced client-side. The full, sanitized error text is available on demand via getExecutionDetail (Phase F), for a deliberate detail-view drill-down only. */
  hasError: boolean;
};

export type AutomationDisplayStatus = "active" | "attention" | "no_activity" | "not_configured" | "disabled";

export type AutomationSummary = {
  definition: AutomationDefinition;
  status: AutomationDisplayStatus;
  totalExecutions: number;
  failedExecutions: number;
  runningExecutions: number;
  lastExecutionAt: string | null;
  /** Phase G: from automation_settings, defaulting to true - see lib/automation/settings.ts's own default-enabled documentation. Always true for the safety-layer capability, which has no automation_settings row of its own. */
  enabled: boolean;
};

/**
 * Narrow-column read across the last MAX_EXECUTION_ROWS executions for this
 * organization, reduced in memory into a per-workflow-name breakdown - the
 * same "fetch once, reduce in memory" pattern already established across
 * lib/bi/queries.ts, so the automation list never issues one query per row.
 */
export async function getWorkflowNameStats(supabase: SupabaseClient, organizationId: string): Promise<Map<string, WorkflowNameStats>> {
  const stats = new Map<string, WorkflowNameStats>();

  const { data, error } = await supabase
    .from("workflow_executions")
    .select("workflow_name, status, started_at")
    .eq("organization_id", organizationId)
    .order("started_at", { ascending: false })
    .limit(MAX_EXECUTION_ROWS);

  if (error || !data) return stats;

  for (const row of data as { workflow_name: string; status: WorkflowExecutionStatus; started_at: string }[]) {
    const existing = stats.get(row.workflow_name) ?? {
      workflowName: row.workflow_name,
      total: 0,
      completed: 0,
      failed: 0,
      running: 0,
      cancelled: 0,
      lastExecutionAt: null,
      lastStatus: null,
    };

    existing.total += 1;
    if (row.status === "completed") existing.completed += 1;
    else if (row.status === "failed") existing.failed += 1;
    else if (row.status === "running") existing.running += 1;
    else if (row.status === "cancelled") existing.cancelled += 1;

    // Rows are ordered newest-first, so the first time a workflow_name is
    // seen here is its most recent execution.
    if (existing.lastExecutionAt === null) {
      existing.lastExecutionAt = row.started_at;
      existing.lastStatus = row.status;
    }

    stats.set(row.workflow_name, existing);
  }

  return stats;
}

export async function getRecentExecutionsForWorkflows(
  supabase: SupabaseClient,
  organizationId: string,
  workflowNames: string[],
  limit: number = DEFAULT_RECENT_LIMIT,
): Promise<AutomationExecutionRow[]> {
  if (workflowNames.length === 0) return [];

  const { data, error } = await supabase
    .from("workflow_executions")
    .select("id, workflow_name, status, attempt, started_at, completed_at, error_message, trigger_source")
    .eq("organization_id", organizationId)
    .in("workflow_name", workflowNames)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return (
    data as {
      id: string;
      workflow_name: string;
      status: WorkflowExecutionStatus;
      attempt: number;
      started_at: string;
      completed_at: string | null;
      error_message: string | null;
      trigger_source: WorkflowExecutionTriggerSource;
    }[]
  ).map((row) => ({
    id: row.id,
    workflowName: row.workflow_name,
    status: row.status,
    attempt: row.attempt,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    triggerSource: row.trigger_source,
    hasError: row.error_message !== null,
  }));
}

/** Reuses lib/bi/queries.ts's existing aggregate directly - never recomputed. */
export async function getAutomationOverview(supabase: SupabaseClient, organizationId: string): Promise<AutomationMetrics> {
  const range = resolveDateRange("last30Days");
  const { automation } = await getAutomationAndFollowUpMetrics(supabase, organizationId, range);
  return automation;
}

/**
 * Whether the two server-only env vars n8n dispatch requires are configured
 * - never exposed to the browser, read only server-side, matching
 * lib/automation/n8n.ts's own "unconfigured" failure mode. An automation
 * whose dispatch is "n8n" but whose orchestrator is unconfigured is
 * genuinely not configured, not merely inactive - the UI says so honestly
 * rather than showing "No activity" for a different reason.
 */
function isN8nConfigured(): boolean {
  return Boolean(process.env.N8N_BASE_URL && process.env.N8N_WEBHOOK_SECRET);
}

/**
 * Combines the real per-workflow-name execution stats with each catalog
 * definition into one summary per automation. "Active" means real execution
 * history exists and its most recent run did not fail; the one
 * safety-layer capability (no workflow of its own) is always "active"/
 * enabled since it is infrastructure, not something independently
 * triggered or user-disableable (setAutomationEnabled itself rejects
 * disabling it).
 *
 * `enabledByAutomationId` (Phase G) comes from getAutomationEnabledMap - a
 * real, automation_settings-backed value, never fabricated - and is
 * checked before every other status so a disabled automation always reads
 * "disabled" regardless of what its execution history would otherwise
 * imply.
 */
export function buildAutomationSummaries(statsByName: Map<string, WorkflowNameStats>, enabledByAutomationId: Map<string, boolean>): AutomationSummary[] {
  const n8nConfigured = isN8nConfigured();

  return AUTOMATION_CATALOG.map((definition) => {
    if (definition.kind === "safety-layer") {
      return {
        definition,
        status: "active" as AutomationDisplayStatus,
        totalExecutions: 0,
        failedExecutions: 0,
        runningExecutions: 0,
        lastExecutionAt: null,
        enabled: true,
      };
    }

    const enabled = enabledByAutomationId.get(definition.id) ?? true;

    const relevantStats = definition.workflowNames.map((name) => statsByName.get(name)).filter((s): s is WorkflowNameStats => s !== undefined);

    const totalExecutions = relevantStats.reduce((sum, s) => sum + s.total, 0);
    const failedExecutions = relevantStats.reduce((sum, s) => sum + s.failed, 0);
    const runningExecutions = relevantStats.reduce((sum, s) => sum + s.running, 0);
    const lastExecutionAt = relevantStats.reduce<string | null>((latest, s) => {
      if (!s.lastExecutionAt) return latest;
      if (!latest) return s.lastExecutionAt;
      return s.lastExecutionAt > latest ? s.lastExecutionAt : latest;
    }, null);
    const mostRecentFailed = relevantStats.some((s) => s.lastStatus === "failed");

    let status: AutomationDisplayStatus;
    if (!enabled) {
      status = "disabled";
    } else if (definition.dispatch === "n8n" && !n8nConfigured) {
      status = "not_configured";
    } else if (totalExecutions === 0) {
      status = "no_activity";
    } else if (mostRecentFailed) {
      status = "attention";
    } else {
      status = "active";
    }

    return { definition, status, totalExecutions, failedExecutions, runningExecutions, lastExecutionAt, enabled };
  });
}
