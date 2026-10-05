import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttentionItem } from "@/lib/dashboard/queries";
import { getAutomationForWorkflowName } from "./catalog";
import type { WorkflowExecutionOutcome, WorkflowRetryState } from "./executions";

/**
 * P0 A2: what Today says about automations, in contractor terms - built from
 * workflow_executions' durable outcome / retry_state (never from logs, and
 * never from the per-automation failure incident, which folds executions
 * together and auto-resolves when a later run succeeds).
 *
 *   Needs you (an operational exception on Today, one row per automation):
 *     - Trackpr stopped retrying (retry_state 'exhausted')
 *     - the automation can't be retried automatically ('not_retryable')
 *     - a send was blocked by something only a person can fix
 *       (NEEDS_PERSON_BLOCK_REASONS: billing, an unusable phone number,
 *       missing records, an AI message the safety screen rejected)
 *   Trackpr is handling it (counted in "Trackpr is handling N"):
 *     - a retry is scheduled, or a failure is waiting for its retry decision
 *     - an automation is processing right now
 *
 * A legitimate block that needs no one (opted out, paused, TEST mode,
 * business hours, a record that moved on) is neither - it is the correct
 * outcome and stays visible in Automations' execution history. Historical
 * failures from before A2 (retry_detail 'pre_a2_failure') never surface.
 * A permanent failure stops surfacing once a newer attempt exists for its
 * event (someone retried it).
 */
export const NEEDS_PERSON_BLOCK_REASONS = new Set([
  "organization_payment_inactive",
  "invalid_destination",
  "unsafe_content",
  "response_message_too_long",
  "missing_response_message",
  "missing_contact_id",
  "contact_not_found",
  "missing_conversation_id",
  "conversation_not_found",
  "lead_conversation_mismatch",
]);

/** How far back a permanent failure or person-blocked send stays on Today. */
export const NEEDS_YOU_WINDOW_DAYS = 7;

export type ExecutionVisibilityRow = {
  id: string;
  automation_event_id: string | null;
  workflow_name: string;
  status: string;
  outcome: WorkflowExecutionOutcome | null;
  retry_state: WorkflowRetryState | null;
  retry_detail: string | null;
  next_retry_at: string | null;
  attempt: number;
  metadata: Record<string, unknown> | null;
};

export type ExecutionDisposition = "processing" | "succeeded" | "blocked_needs_person" | "blocked" | "retry_pending" | "retry_scheduled" | "retried" | "stopped_retrying" | "not_retryable";

/** Pure: one execution's place in the lifecycle, as Today reasons about it. */
export function executionDisposition(row: ExecutionVisibilityRow): ExecutionDisposition {
  if (row.status === "running") return "processing";
  if (row.outcome === "blocked") {
    const reason = typeof row.metadata?.blocked_reason === "string" ? row.metadata.blocked_reason : null;
    return reason && NEEDS_PERSON_BLOCK_REASONS.has(reason) ? "blocked_needs_person" : "blocked";
  }
  if (row.status === "failed") {
    if (row.retry_state === "scheduled") return "retry_scheduled";
    if (row.retry_state === "retried") return "retried";
    if (row.retry_state === "exhausted") return "stopped_retrying";
    if (row.retry_state === "not_retryable") return "not_retryable";
    return "retry_pending";
  }
  return "succeeded";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Pure: Today's automation items. `supersededIds` are permanent failures a
 * newer attempt already took over (they no longer need anyone).
 */
export function buildAutomationAttentionItems(rows: ExecutionVisibilityRow[], supersededIds: ReadonlySet<string> = new Set()): AttentionItem[] {
  const needsYou = new Map<string, { name: string; href: string; stopped: number; notRetryable: number; blocked: number }>();
  const handling = new Map<string, { name: string; href: string; count: number }>();

  for (const row of rows) {
    const disposition = executionDisposition(row);
    if (row.retry_detail === "pre_a2_failure") continue;
    const automation = getAutomationForWorkflowName(row.workflow_name);
    const key = automation?.id ?? row.workflow_name;
    const name = automation?.name ?? "An automation";
    const href = automation ? `/automations/${automation.id}` : "/automations";

    if (disposition === "stopped_retrying" || disposition === "not_retryable" || disposition === "blocked_needs_person") {
      if (supersededIds.has(row.id)) continue;
      const entry = needsYou.get(key) ?? { name, href, stopped: 0, notRetryable: 0, blocked: 0 };
      if (disposition === "stopped_retrying") entry.stopped += 1;
      else if (disposition === "not_retryable") entry.notRetryable += 1;
      else entry.blocked += 1;
      needsYou.set(key, entry);
    } else if (disposition === "retry_scheduled" || disposition === "retry_pending" || disposition === "processing") {
      const entry = handling.get(key) ?? { name, href, count: 0 };
      entry.count += 1;
      handling.set(key, entry);
    }
  }

  const items: AttentionItem[] = [];
  for (const [key, entry] of needsYou) {
    const parts = [
      entry.stopped ? `${plural(entry.stopped, "run", "runs")} failed and Trackpr stopped retrying` : null,
      entry.notRetryable ? `${plural(entry.notRetryable, "run", "runs")} failed and can't be retried automatically` : null,
      entry.blocked ? `${plural(entry.blocked, "message was", "messages were")} held back for something only you can fix` : null,
    ].filter(Boolean);
    items.push({ id: `automation-attention-${key}`, kind: "automation_needs_attention", title: entry.name, detail: `${parts.join("; ")}.`, value: null, href: entry.href });
  }
  for (const [key, entry] of handling) {
    items.push({ id: `automation-handling-${key}`, kind: "automation_retrying", title: entry.name, detail: `Trackpr is working on ${plural(entry.count, "run", "runs")} and will retry if needed.`, value: null, href: entry.href });
  }
  return items;
}

/**
 * Today's read: running work, undecided/scheduled failures, and permanent
 * failures or person-blocked sends from the last NEEDS_YOU_WINDOW_DAYS.
 * Never throws - a database without the A2 columns (or any read error)
 * yields no items rather than breaking Today.
 */
export async function loadAutomationAttention(supabase: SupabaseClient, organizationId: string, now: Date = new Date()): Promise<AttentionItem[]> {
  try {
    const since = new Date(now.getTime() - NEEDS_YOU_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const columns = "id, automation_event_id, workflow_name, status, outcome, retry_state, retry_detail, next_retry_at, attempt, metadata";
    const [{ data: active, error: activeError }, { data: recent, error: recentError }] = await Promise.all([
      supabase.from("workflow_executions").select(columns).eq("organization_id", organizationId).eq("status", "running").limit(200),
      supabase
        .from("workflow_executions")
        .select(columns)
        .eq("organization_id", organizationId)
        .or("status.eq.failed,outcome.eq.blocked")
        .gte("started_at", since)
        .order("started_at", { ascending: false })
        .limit(500),
    ]);
    if (activeError || recentError) {
      console.error("[automation] Today automation read failed", { organizationId, error: (activeError ?? recentError)?.message });
      return [];
    }
    const rows = [...((active ?? []) as ExecutionVisibilityRow[]), ...((recent ?? []) as ExecutionVisibilityRow[])];

    // A permanent failure whose event has a newer attempt was retried by a
    // person - it no longer needs anyone.
    const permanent = rows.filter((row) => (row.retry_state === "exhausted" || row.retry_state === "not_retryable") && row.automation_event_id);
    const superseded = new Set<string>();
    if (permanent.length > 0) {
      const { data: attempts } = await supabase
        .from("workflow_executions")
        .select("automation_event_id, attempt")
        .eq("organization_id", organizationId)
        .in("automation_event_id", [...new Set(permanent.map((row) => row.automation_event_id as string))]);
      const latest = new Map<string, number>();
      for (const attempt of (attempts ?? []) as { automation_event_id: string; attempt: number }[]) {
        latest.set(attempt.automation_event_id, Math.max(latest.get(attempt.automation_event_id) ?? 0, attempt.attempt));
      }
      for (const row of permanent) if ((latest.get(row.automation_event_id as string) ?? 0) > row.attempt) superseded.add(row.id);
    }
    return buildAutomationAttentionItems(rows, superseded);
  } catch (error) {
    console.error("[automation] Today automation read threw", { organizationId, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
