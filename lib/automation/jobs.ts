import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent } from "./events";
import { startWorkflowExecution, completeWorkflowExecution, failWorkflowExecution } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getEstimate } from "@/lib/estimates/queries";
import { getJob, getJobByEstimateId } from "@/lib/jobs/queries";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";

export const JOB_CREATED_WORKFLOW = "job_created_followup";

export type JobLifecycleEventType = "job.completed" | "job.cancelled";

/**
 * The sole job-creation path for Phase 4.6, per explicit decision: an
 * estimate transitioning to 'accepted' creates exactly one job. Called
 * from app/(app)/estimates/actions.ts's transitionEstimate() - always has
 * an authenticated user session, hence the plain (non-service) event/
 * execution helpers. Idempotent at two layers:
 *
 * 1. The database itself: a unique index on jobs.estimate_id (see
 *    20260918134457_add_jobs_table.sql) makes a second concurrent insert
 *    for the same estimate fail atomically (23505), handled below by
 *    resolving the existing row instead of erroring - the same pattern
 *    already used for messages.workflow_execution_id in
 *    lib/messaging/outbound.ts.
 * 2. job.created's own idempotency key (job.created:<job_id>), so even a
 *    retried call that resolves the same existing job never dispatches a
 *    second n8n workflow execution for it.
 *
 * Never throws: a failure here must never fail the estimate-acceptance
 * transition itself (already committed by the caller).
 */
export async function emitJobCreatedFromEstimate(
  supabase: SupabaseClient,
  organizationId: string,
  estimateId: string,
): Promise<void> {
  const estimate = await getEstimate(supabase, organizationId, estimateId);
  if (!estimate) {
    console.error("[automation] emitJobCreatedFromEstimate: estimate not found", { estimateId, organizationId });
    return;
  }

  let jobId: string;
  const { data: inserted, error: insertError } = await supabase
    .from("jobs")
    .insert({
      organization_id: organizationId,
      contact_id: estimate.contact_id,
      lead_id: estimate.lead_id,
      estimate_id: estimateId,
      title: estimate.title,
      amount: estimate.amount,
      status: "scheduled",
    })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      // A job already exists for this estimate - resolve it instead of
      // erroring. This is the expected, safe outcome of a replayed
      // estimate.accepted call (requirement B), not a failure.
      const existing = await getJobByEstimateId(supabase, organizationId, estimateId);
      if (!existing) {
        console.error("[automation] job insert conflicted but existing row not found", { estimateId, organizationId });
        return;
      }
      jobId = existing.id;
    } else {
      console.error("[automation] failed to create job from estimate", { estimateId, error: insertError.message });
      return;
    }
  } else {
    jobId = inserted.id;
  }

  const eventResult = await createAutomationEvent(supabase, {
    eventType: "job.created",
    entityType: "job",
    entityId: jobId,
    payload: { job_id: jobId, estimate_id: estimateId },
    idempotencyKey: `job.created:${jobId}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create job.created event", { jobId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const job = await getJob(supabase, organizationId, jobId);
  if (!job) {
    console.error("[automation] job.created event created but job not found", { jobId });
    return;
  }

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, JOB_CREATED_WORKFLOW);
  if (!executionResult.ok) {
    console.error("[automation] failed to start job.created execution", { jobId, error: executionResult.error });
    return;
  }

  const [aiSettings, businessProfile] = await Promise.all([
    getAiSettings(supabase, organizationId),
    getBusinessProfile(supabase, organizationId),
  ]);

  let conversationId: string | null = null;
  let contact: { id: string; first_name: string | null; last_name: string | null; phone: string | null; email: string | null } | null = null;

  if (job.contact_id) {
    const { getContact } = await import("@/lib/contacts/queries");
    const fetchedContact = await getContact(supabase, organizationId, job.contact_id);
    contact = fetchedContact
      ? {
          id: fetchedContact.id,
          first_name: fetchedContact.first_name,
          last_name: fetchedContact.last_name,
          phone: fetchedContact.phone,
          email: fetchedContact.email,
        }
      : null;

    const conversation = await findOrCreateOpenConversation(supabase, organizationId, job.contact_id, "sms", job.lead_id);
    conversationId = conversation?.id ?? null;
  }

  const contract: N8nWorkflowContract = {
    version: 1,
    event: {
      id: eventResult.event.id,
      type: "job.created",
      organization_id: organizationId,
      entity_type: "job",
      entity_id: jobId,
      payload: {
        job_id: jobId,
        contact_id: job.contact_id,
        lead_id: job.lead_id,
        conversation_id: conversationId,
        title: job.title,
        status: job.status,
      },
    },
    execution: {
      id: executionResult.execution.id,
      workflow_name: JOB_CREATED_WORKFLOW,
      attempt: executionResult.execution.attempt,
    },
    context: {
      organization: {
        id: organizationId,
        name: businessProfile?.name ?? "",
        timezone: businessProfile?.timezone ?? "UTC",
      },
      ai: {
        enabled: aiSettings.ai_enabled,
        tone: aiSettings.tone,
        business_introduction: aiSettings.business_introduction,
        general_instructions: aiSettings.general_instructions,
      },
      contact,
    },
  };

  const executionId = executionResult.execution.id;
  after(async () => {
    const dispatch = await triggerN8nWorkflow(contract);
    if (!dispatch.ok) {
      const failed = await failWorkflowExecution(supabase, executionId, dispatch.error, "n8n_dispatch_failed");
      if (!failed.ok) {
        console.error("[automation] failed to record job.created dispatch failure", {
          executionId,
          dispatchError: dispatch.error,
          recordError: failed.error,
        });
      }
    }
  });
}

/**
 * Records a lifecycle-only job automation event: created, immediately
 * started, immediately completed, no AI generation, no outbound message -
 * per explicit decision, job.completed/job.cancelled are lifecycle-only
 * this phase (no review-request automation), mirroring Phase 4.4/4.5's
 * identical treatment of appointment/estimate terminal states. Triggered
 * from app/(app)/jobs/actions.ts, which always has an authenticated user
 * session.
 */
export async function emitJobLifecycleEvent(
  supabase: SupabaseClient,
  jobId: string,
  eventType: JobLifecycleEventType,
): Promise<void> {
  const idempotencyKey = `${eventType}:${jobId}`;

  const eventResult = await createAutomationEvent(supabase, {
    eventType,
    entityType: "job",
    entityId: jobId,
    payload: { job_id: jobId },
    idempotencyKey,
  });

  if (!eventResult.ok) {
    console.error(`[automation] failed to create ${eventType} event`, { jobId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, `${eventType.replace(".", "_")}_lifecycle`);
  if (!executionResult.ok) {
    console.error(`[automation] failed to start ${eventType} execution`, { jobId, error: executionResult.error });
    return;
  }

  const completed = await completeWorkflowExecution(supabase, executionResult.execution.id, {
    lifecycle_only: true,
    job_id: jobId,
  });
  if (!completed.ok) {
    console.error(`[automation] failed to complete ${eventType} execution`, { jobId, error: completed.error });
  }
}
