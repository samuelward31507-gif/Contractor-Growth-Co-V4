import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent, createAutomationEventAsService } from "./events";
import { startWorkflowExecution, startWorkflowExecutionAsService, completeWorkflowExecution, completeWorkflowExecutionAsService } from "./executions";
import type { LeadStatus } from "@/lib/leads/queries";

/**
 * Growth System Completion Pass 2 (Part 1): persistent lead-stage history,
 * reusing the existing automation_events table rather than a new one -
 * exactly the same "internal lifecycle marker, no dispatched workflow, no
 * catalog entry" pattern lib/automation/lead-lost.ts's own emitLeadLost
 * already established for lead.lost. getAutomationForEventType("lead.stage_changed")
 * resolves to null (no catalog automation claims it), so this is never
 * subject to any automation enable/disable toggle and is always recorded -
 * appropriate for an audit trail, not a customer-facing automation. No new
 * migration, no new table - "reuse existing audit/event infrastructure",
 * per the task's own explicit instruction.
 *
 * Each event is created -> started -> immediately completed
 * (lifecycle_only: true), the same 3-step shape every other lifecycle-only
 * event in this codebase already uses (appointment.completed, job.completed,
 * lead.lost) - this both records the transition AND leaves the
 * automation_events row in a real terminal status ('completed'), never
 * dangling at 'pending'.
 */

export type LeadStageChangeSource = "manual" | "automation";

export type LeadStageChangeInput = {
  leadId: string;
  /** null only for the very first entry (lead creation) - every subsequent transition has a real previous stage. */
  previousStatus: LeadStatus | null;
  newStatus: LeadStatus;
  source: LeadStageChangeSource;
  /** The authenticated user who made a manual change, when known. Always null for source: "automation". */
  actorUserId?: string | null;
  /**
   * Deterministic idempotency suffix for an automation-driven transition
   * that could genuinely be retried (e.g. the estimate id that caused a
   * "won" transition) - lets a retried call resolve to the same history
   * row instead of a duplicate. Manual saves omit this entirely; each is
   * already a distinct, deliberate user action, not a retry.
   */
  idempotencySuffix?: string;
};

function buildPayload(input: LeadStageChangeInput): Record<string, unknown> {
  return {
    lead_id: input.leadId,
    previous_status: input.previousStatus,
    new_status: input.newStatus,
    source: input.source,
    actor_user_id: input.actorUserId ?? null,
    changed_at: new Date().toISOString(),
  };
}

function idempotencyKeyFor(input: LeadStageChangeInput): string | null {
  if (input.source !== "automation") return null;
  const suffix = input.idempotencySuffix ? `:${input.idempotencySuffix}` : "";
  return `lead.stage_changed:${input.leadId}:${input.newStatus}${suffix}`;
}

/** Session-authenticated variant - used by app/(app)/leads/actions.ts (createLead/updateLead), which always has a real user session. */
export async function emitLeadStageChanged(supabase: SupabaseClient, input: LeadStageChangeInput): Promise<void> {
  const eventResult = await createAutomationEvent(supabase, {
    eventType: "lead.stage_changed",
    entityType: "lead",
    entityId: input.leadId,
    payload: buildPayload(input),
    idempotencyKey: idempotencyKeyFor(input),
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create lead.stage_changed event", { leadId: input.leadId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, "lead_stage_changed_lifecycle");
  if (!executionResult.ok) {
    console.error("[automation] failed to start lead.stage_changed execution", { leadId: input.leadId, error: executionResult.error });
    return;
  }

  const completed = await completeWorkflowExecution(supabase, executionResult.execution.id, { lifecycle_only: true, lead_id: input.leadId });
  if (!completed.ok) {
    console.error("[automation] failed to complete lead.stage_changed execution", { leadId: input.leadId, error: completed.error });
  }
}

/** Service-role variant - used by unauthenticated webhooks (voice/inbound, leads/capture) and background automation (emitJobCreatedFromEstimate's own 'won' transition). */
export async function emitLeadStageChangedAsService(supabase: SupabaseClient, organizationId: string, input: LeadStageChangeInput): Promise<void> {
  const eventResult = await createAutomationEventAsService(supabase, organizationId, {
    eventType: "lead.stage_changed",
    entityType: "lead",
    entityId: input.leadId,
    payload: buildPayload(input),
    idempotencyKey: idempotencyKeyFor(input),
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create lead.stage_changed event", { leadId: input.leadId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, "lead_stage_changed_lifecycle");
  if (!executionResult.ok) {
    console.error("[automation] failed to start lead.stage_changed execution", { leadId: input.leadId, error: executionResult.error });
    return;
  }

  const completed = await completeWorkflowExecutionAsService(supabase, executionResult.execution.id, { lifecycle_only: true, lead_id: input.leadId });
  if (!completed.ok) {
    console.error("[automation] failed to complete lead.stage_changed execution", { leadId: input.leadId, error: completed.error });
  }
}

export type LeadStageHistoryEntry = {
  id: string;
  previousStatus: LeadStatus | null;
  newStatus: LeadStatus;
  source: LeadStageChangeSource;
  actorUserId: string | null;
  changedAt: string;
};

/**
 * Reads a lead's stage history for the Lead Detail timeline, oldest first.
 * Org-scoped and lead-scoped explicitly (never trusts RLS alone) - a
 * service-role caller (e.g. an agency view) must pass the real
 * organizationId, never a value derived from anything client-supplied.
 */
export async function getLeadStageHistory(supabase: SupabaseClient, organizationId: string, leadId: string): Promise<LeadStageHistoryEntry[]> {
  const { data } = await supabase
    .from("automation_events")
    .select("id, payload, created_at")
    .eq("organization_id", organizationId)
    .eq("entity_type", "lead")
    .eq("entity_id", leadId)
    .eq("event_type", "lead.stage_changed")
    .order("created_at", { ascending: true })
    .limit(200);

  return ((data ?? []) as { id: string; payload: Record<string, unknown>; created_at: string }[]).map((row) => ({
    id: row.id,
    previousStatus: (row.payload.previous_status as LeadStatus | null) ?? null,
    newStatus: row.payload.new_status as LeadStatus,
    source: (row.payload.source as LeadStageChangeSource) ?? "manual",
    actorUserId: (row.payload.actor_user_id as string | null) ?? null,
    changedAt: (row.payload.changed_at as string | undefined) ?? row.created_at,
  }));
}
