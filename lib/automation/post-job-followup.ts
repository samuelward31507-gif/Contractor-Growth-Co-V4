import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent } from "./events";
import { startWorkflowExecution, failWorkflowExecution } from "./executions";
import { triggerN8nWorkflow, type N8nWorkflowContract } from "./n8n";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getJob } from "@/lib/jobs/queries";
import { getAiSettings, getBusinessProfile } from "@/lib/settings/queries";

export const POST_JOB_FOLLOWUP_WORKFLOW = "post_job_followup";

/**
 * Emits the single `post_job_followup` event (Phase 4.7 - one combined
 * thank-you + review-ask (when configured) + referral-ask message, not two
 * separate review.requested/referral.requested events) and dispatches an
 * AI-drafted message to n8n. Called from app/(app)/jobs/actions.ts's
 * markJobCompleted(), right after the existing job.completed lifecycle
 * event - always has an authenticated user session, hence the plain
 * (non-service) event/execution helpers, exactly like
 * emitJobCreatedFromEstimate. Never throws: a failure here must never fail
 * the job-completion transition itself (already committed by the caller).
 *
 * Idempotent via post_job_followup:<job_id> - a completed job can only
 * ever produce one of these events, ever (requirements A/B).
 */
export async function emitPostJobFollowup(
  supabase: SupabaseClient,
  organizationId: string,
  jobId: string,
): Promise<void> {
  // event_type is "job.post_followup" (dot-namespaced), not literally
  // "post_job_followup" - the existing EVENT_TYPE_PATTERN validation
  // (enforced both in lib/automation/events.ts and inside the
  // create_automation_event RPC itself) requires a "namespace.action" form
  // like every other event type in this codebase (lead.created,
  // job.created, estimate.sent, ...); a bare identifier with no dot fails
  // it. The idempotency key and the n8n workflow_name - both specified
  // exactly as "post_job_followup" - have no such constraint and use that
  // literal string unchanged.
  const eventResult = await createAutomationEvent(supabase, {
    eventType: "job.post_followup",
    entityType: "job",
    entityId: jobId,
    payload: { job_id: jobId },
    idempotencyKey: `post_job_followup:${jobId}`,
  });

  if (!eventResult.ok) {
    console.error("[automation] failed to create post_job_followup event", { jobId, error: eventResult.error });
    return;
  }
  if (eventResult.duplicate) return;

  const job = await getJob(supabase, organizationId, jobId);
  if (!job) {
    console.error("[automation] post_job_followup event created but job not found", { jobId, organizationId });
    return;
  }

  const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, POST_JOB_FOLLOWUP_WORKFLOW);
  if (!executionResult.ok) {
    console.error("[automation] failed to start post_job_followup execution", { jobId, error: executionResult.error });
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

  // review_url is passed through exactly as stored - Trackpr is the only
  // place this value can ever originate; the n8n prompt is instructed to
  // use it verbatim or omit any review mention entirely when it's null,
  // never to invent or modify one (requirement E). Missing review_url is
  // never itself a reason to withhold dispatch - the referral portion of
  // the message is still fully valid without it (requirement D).
  const contract: N8nWorkflowContract = {
    version: 1,
    event: {
      id: eventResult.event.id,
      type: "job.post_followup",
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
        review_url: businessProfile?.review_url ?? null,
      },
    },
    execution: {
      id: executionResult.execution.id,
      workflow_name: POST_JOB_FOLLOWUP_WORKFLOW,
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
      const failed = await failWorkflowExecution(supabase, executionId, dispatch.error);
      if (!failed.ok) {
        console.error("[automation] failed to record post_job_followup dispatch failure", {
          executionId,
          dispatchError: dispatch.error,
          recordError: failed.error,
        });
      }
    }
  });
}
