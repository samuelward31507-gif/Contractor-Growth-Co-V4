import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent, createAutomationEventAsService } from "./events";
import { startWorkflowExecution, completeWorkflowExecution, failWorkflowExecution, startWorkflowExecutionAsService, failWorkflowExecutionAsService } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getEstimate } from "@/lib/estimates/queries";
import { getJob, getJobByEstimateId } from "@/lib/jobs/queries";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";
import { emitLeadStageChanged, emitLeadStageChangedAsService } from "./lead-stage-history";
import type { LeadStatus } from "@/lib/leads/queries";

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

  // Fast-Track Production Readiness, Pass 4: the audit found leads.status
  // was never synced when an estimate is accepted and a job is created, so
  // a lead could stay stuck at 'estimate' forever even after the deal was
  // actually won - a real dashboard/BI-pipeline drift, not just a display
  // nit. Scoped to the estimate's own lead (if any) and guarded with
  // neq("status", "won") so this is a safe no-op on the idempotent-replay
  // path above (job already existed) and never overwrites a lead a human
  // has since moved past 'won' for some other reason. Never blocks job
  // creation itself if this update fails.
  if (estimate.lead_id) {
    // Growth System Completion Pass 2 (Part 1): read the lead's own status
    // BEFORE the conditional update below, so a genuine transition can be
    // recorded with a real previous stage - the update itself still uses
    // the exact same neq("status", "won") guard as before (unchanged
    // behavior), this read only ever informs the history entry.
    const { data: leadBeforeWon } = await supabase.from("leads").select("status").eq("id", estimate.lead_id).eq("organization_id", organizationId).maybeSingle();

    const { data: wonLead, error: leadWonUpdateError } = await supabase
      .from("leads")
      .update({ status: "won" })
      .eq("id", estimate.lead_id)
      .eq("organization_id", organizationId)
      .neq("status", "won")
      .select("id")
      .maybeSingle();

    if (leadWonUpdateError) {
      console.error("[automation] failed to sync lead status to won", { estimateId, leadId: estimate.lead_id, error: leadWonUpdateError.message });
    } else if (wonLead && leadBeforeWon) {
      await emitLeadStageChanged(supabase, {
        leadId: estimate.lead_id,
        previousStatus: leadBeforeWon.status as LeadStatus,
        newStatus: "won",
        source: "automation",
        // Tied to this specific estimate - a retried/replayed call for the
        // SAME estimate acceptance resolves to the same history row; a
        // genuinely different estimate winning this lead again later gets
        // its own distinct entry.
        idempotencySuffix: estimateId,
      });
    }
  }

  await emitJobCreatedEvent(supabase, organizationId, jobId, estimateId);
}

/**
 * The service-role twin of emitJobCreatedFromEstimate above, for the two
 * estimate-acceptance paths that have no Supabase Auth session - the public
 * quote approval link (lib/estimates/approval.ts) and the customer's SMS
 * "yes" (lib/automation/estimate-reply.ts).
 *
 * Job creation and the lead -> won sync are the identical writes, guards and
 * 23505 resolution as the session variant; lead.stage_changed goes through
 * emitLeadStageChangedAsService with the same idempotency suffix (the
 * estimate id). job.created then goes through the SAME emitJobCreatedEvent
 * the contractor's manual Accept uses (service mode): same event, same
 * `job.created:<job_id>` idempotency key, same job_created_followup kickoff
 * dispatched to n8n, whose customer text can only ever be sent by the n8n
 * callback after evaluateOutboundGate. (Phase 1B-5 originally recorded only
 * a lifecycle marker here, so a customer who accepted on their own got less
 * than one whose contractor clicked Accept; the acceptance paths are now
 * normalized.) createAutomationEventAsService still applies the
 * job-lifecycle catalog toggle and automation_paused.
 *
 * `organizationId` must already be trusted - both callers derive it from
 * the estimate row itself (resolved from an approval token or from the
 * organization that owns the inbound SMS number), never from input.
 * Never throws: the estimate transition already committed.
 */
export async function emitJobCreatedFromEstimateAsService(
  supabase: SupabaseClient,
  organizationId: string,
  estimateId: string,
): Promise<void> {
  try {
    const estimate = await getEstimate(supabase, organizationId, estimateId);
    if (!estimate) {
      console.error("[automation] emitJobCreatedFromEstimateAsService: estimate not found", { estimateId, organizationId });
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

    if (estimate.lead_id) {
      const { data: leadBeforeWon } = await supabase.from("leads").select("status").eq("id", estimate.lead_id).eq("organization_id", organizationId).maybeSingle();

      const { data: wonLead, error: leadWonUpdateError } = await supabase
        .from("leads")
        .update({ status: "won" })
        .eq("id", estimate.lead_id)
        .eq("organization_id", organizationId)
        .neq("status", "won")
        .select("id")
        .maybeSingle();

      if (leadWonUpdateError) {
        console.error("[automation] failed to sync lead status to won", { estimateId, leadId: estimate.lead_id, error: leadWonUpdateError.message });
      } else if (wonLead && leadBeforeWon) {
        await emitLeadStageChangedAsService(supabase, organizationId, {
          leadId: estimate.lead_id,
          previousStatus: leadBeforeWon.status as LeadStatus,
          newStatus: "won",
          source: "automation",
          idempotencySuffix: estimateId,
        });
      }
    }

    // Every acceptance path - contractor "Mark Accepted", the public quote
    // link, the customer's SMS "accept" - converges on the same job.created
    // automation (event + n8n kickoff notification, gated by the callback's
    // outbound gate). Idempotent on job.created:<jobId>, so racing paths for
    // one job can only ever dispatch once.
    await emitJobCreatedEvent(supabase, organizationId, jobId, estimateId, "service");
  } catch (error) {
    console.error("[automation] emitJobCreatedFromEstimateAsService threw", { estimateId, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Growth System Completion Pass 1: extracted from emitJobCreatedFromEstimate
 * above (byte-identical behavior, not a rewrite) so Direct Job Creation
 * (app/(app)/jobs/actions.ts's createJob) can dispatch the exact same
 * job.created event/kickoff notification for a manually-created job -
 * "preserve lifecycle automation where appropriate" - without a second,
 * divergent implementation. `estimateId` is null for a directly-created job
 * (there is no originating estimate to record in the payload); everything
 * else - idempotency, the AI-drafted kickoff message, eligibility - is
 * identical regardless of which path created the job.
 */
export async function emitJobCreatedEvent(
  supabase: SupabaseClient,
  organizationId: string,
  jobId: string,
  estimateId: string | null,
  /** "service" for the session-less acceptance paths (quote link, SMS reply) - same event, same kickoff, service-role event/execution helpers. */
  mode: "session" | "service" = "session",
): Promise<void> {
  // Trackpr 2.0, n8n job-created payload fix: job/contact/conversation must
  // be resolved BEFORE createAutomationEvent below, not after - see that
  // call's own comment for why (same fix, same reasoning, as
  // lib/automation/post-job-followup.ts's emitPostJobFollowup).
  const job = await getJob(supabase, organizationId, jobId);
  if (!job) {
    console.error("[automation] job.created requested but job not found", { jobId, organizationId });
    return;
  }

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

  // Trackpr 2.0, n8n job-created payload fix: the stored payload must
  // include contact_id/lead_id/conversation_id, not just job_id/
  // estimate_id - the n8n callback route (app/api/automation/n8n-callback/
  // route.ts) re-derives contactId/leadId/conversationId for the outbound
  // gate exclusively from THIS STORED payload, never from the separate
  // contract object dispatched to n8n below. With these omitted, every
  // job.created send was unconditionally denied by the gate's own
  // missing_contact_id check - the same defect class already fixed for
  // job.post_followup, found live in production for this event type too.
  const eventInput = {
    eventType: "job.created",
    entityType: "job",
    entityId: jobId,
    payload: {
      job_id: jobId,
      ...(estimateId ? { estimate_id: estimateId } : {}),
      contact_id: job.contact_id,
      lead_id: job.lead_id,
      conversation_id: conversationId,
    },
    idempotencyKey: `job.created:${jobId}`,
  };
  const eventResult = mode === "service" ? await createAutomationEventAsService(supabase, organizationId, eventInput) : await createAutomationEvent(supabase, eventInput);

  if (!eventResult.ok) {
    console.error("[automation] failed to create job.created event", { jobId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;
  if (eventResult.skipped) return;

  const executionResult =
    mode === "service"
      ? await startWorkflowExecutionAsService(supabase, eventResult.event.id, JOB_CREATED_WORKFLOW)
      : await startWorkflowExecution(supabase, eventResult.event.id, JOB_CREATED_WORKFLOW);
  if (!executionResult.ok) {
    console.error("[automation] failed to start job.created execution", { jobId, error: executionResult.error });
    return;
  }

  const [aiSettings, businessProfile] = await Promise.all([
    getAiSettings(supabase, organizationId),
    getBusinessProfile(supabase, organizationId),
  ]);

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
      const failed =
        mode === "service"
          ? await failWorkflowExecutionAsService(supabase, executionId, dispatch.error, "n8n_dispatch_failed")
          : await failWorkflowExecution(supabase, executionId, dispatch.error, "n8n_dispatch_failed");
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
