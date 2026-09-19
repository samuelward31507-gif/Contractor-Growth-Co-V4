import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent } from "./events";
import { startWorkflowExecution, completeWorkflowExecution } from "./executions";

/**
 * Records the `lead.lost` lifecycle event - created, immediately started,
 * immediately completed, no AI generation, no outbound message - mirroring
 * Phase 4.4/4.5/4.6's identical treatment of terminal-state lifecycle
 * events (appointment.completed, estimate.declined, job.cancelled). Called
 * from app/(app)/leads/actions.ts's updateLead() ONLY when this specific
 * save is a genuine NEW transition into 'lost' (the caller is responsible
 * for that read-before-write comparison - this function itself has no way
 * to know the lead's previous status, only its current one).
 *
 * This event's own `created_at` is the sole timing anchor
 * lib/automation/lead-nurture.ts measures the 72-hour/14-day touch
 * thresholds against - deliberately not leads.updated_at, which is
 * contaminated by Trackpr's own automation writes (e.g. the n8n callback
 * route's ai_summary updates) and would not reflect a clean "went lost at"
 * moment. No new schema is introduced for this timing anchor - see the
 * Phase 4.8 report for the full reasoning.
 *
 * Idempotent via lead.lost:<lead_id> - a lead can only ever produce one of
 * these events, ever (requirements B/C) - repeatedly saving an
 * already-lost lead must never create a second one.
 */
export async function emitLeadLost(supabase: SupabaseClient, leadId: string): Promise<void> {
  const eventResult = await createAutomationEvent(supabase, {
    eventType: "lead.lost",
    entityType: "lead",
    entityId: leadId,
    payload: { lead_id: leadId },
    idempotencyKey: `lead.lost:${leadId}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create lead.lost event", { leadId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, "lead_lost_lifecycle");
  if (!executionResult.ok) {
    console.error("[automation] failed to start lead.lost execution", { leadId, error: executionResult.error });
    return;
  }

  const completed = await completeWorkflowExecution(supabase, executionResult.execution.id, {
    lifecycle_only: true,
    lead_id: leadId,
  });
  if (!completed.ok) {
    console.error("[automation] failed to complete lead.lost execution", { leadId, error: completed.error });
  }
}
