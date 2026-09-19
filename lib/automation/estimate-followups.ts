import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import {
  startWorkflowExecutionAsService,
  completeWorkflowExecutionAsService,
  failWorkflowExecutionAsService,
  type WorkflowExecutionTriggerSource,
} from "./executions";
import { evaluateOutboundGate } from "./outbound-gate";
import { getAutomationEnabled } from "./settings";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import type { EstimateStatus } from "@/lib/estimates/queries";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";

export const ESTIMATE_FOLLOWUP_WORKFLOW = "estimate_followup";
export const ESTIMATE_EXPIRED_WORKFLOW = "estimate_expired_lifecycle";

const FOLLOWUP_1_HOURS = 24;
const FOLLOWUP_2_HOURS = 72;
const ACTIVE_STATUSES: EstimateStatus[] = ["sent"];

type CandidateEstimate = {
  id: string;
  organization_id: string;
  contact_id: string | null;
  lead_id: string | null;
  title: string;
  status: EstimateStatus;
  sent_at: string;
  expires_at: string | null;
};

export type FollowupOutcome =
  | { estimateId: string; outcome: "sent"; occurrence: 1 | 2; messageId: string }
  | { estimateId: string; outcome: "expired" }
  | { estimateId: string; outcome: "blocked"; reason: string }
  | { estimateId: string; outcome: "skipped_duplicate" }
  | { estimateId: string; outcome: "skipped_disabled" }
  | { estimateId: string; outcome: "not_due" }
  | { estimateId: string; outcome: "failed"; error: string };

export type FollowupRunResult = {
  candidates: number;
  outcomes: FollowupOutcome[];
};

function composeFollowupBody(estimate: CandidateEstimate, occurrence: 1 | 2): string {
  if (occurrence === 1) {
    return `Just checking in on the estimate we sent for "${estimate.title}" - happy to answer any questions. Reply STOP to opt out of texts.`;
  }
  return `Following up one more time on the estimate for "${estimate.title}" - let us know if you'd like to move forward or have any questions. Reply STOP to opt out of texts.`;
}

/**
 * Finds `sent` estimates due for auto-expiration or their next follow-up,
 * and processes each one: expiration transitions the estimate and records
 * estimate.expired (lifecycle-only, no message, blocks all future
 * follow-ups by leaving 'sent'); a due follow-up sends through the exact
 * same safe outbound gate + sendOutboundMessage path every other automated
 * message uses. Designed to be called repeatedly on a schedule (see
 * app/api/automation/estimate-followups/route.ts) - every step is
 * idempotent, so calling this twice in the same window is always safe.
 *
 * At most one follow-up per estimate per call: if both the 24h and 72h
 * thresholds are already crossed (e.g. the cron was down for a while), the
 * more current one (72h) is preferred over sending an outdated first
 * touchpoint - the 24h one simply never fires in that case, rather than
 * bursting both in the same tick.
 */
export async function processEstimateFollowups(
  supabase: SupabaseClient,
  now: Date = new Date(),
  /** Test seam only - production callers must never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
  /** Phase D: "manual" when triggered by an org admin's "Run now" action; every real cron tick omits this and keeps the column's own 'event' default. */
  triggerSource: WorkflowExecutionTriggerSource = "event",
): Promise<FollowupRunResult> {
  const { data: rawCandidates } = await supabase
    .from("estimates")
    .select("id, organization_id, contact_id, lead_id, title, status, sent_at, expires_at")
    .in("status", ACTIVE_STATUSES)
    .not("sent_at", "is", null)
    .limit(500);

  const candidates = (rawCandidates ?? []) as CandidateEstimate[];
  const outcomes: FollowupOutcome[] = [];

  for (const estimate of candidates) {
    outcomes.push(await processOneEstimate(supabase, estimate, now, sendSmsFn, triggerSource));
  }

  return { candidates: candidates.length, outcomes };
}

async function processOneEstimate(
  supabase: SupabaseClient,
  estimate: CandidateEstimate,
  now: Date,
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
  triggerSource: WorkflowExecutionTriggerSource = "event",
): Promise<FollowupOutcome> {
  // Phase C: covers both branches below (expiration and follow-up) - both
  // event types (estimate.expired, estimate.followup) belong to the same
  // "estimate-followup" catalog automation, so one check up front is
  // correct and avoids duplicating it in both expireEstimate/sendFollowup.
  if (!(await getAutomationEnabled(supabase, estimate.organization_id, "estimate-followup"))) {
    return { estimateId: estimate.id, outcome: "skipped_disabled" };
  }

  if (estimate.expires_at && new Date(estimate.expires_at).getTime() <= now.getTime()) {
    return expireEstimate(supabase, estimate, triggerSource);
  }

  const hoursSinceSent = (now.getTime() - new Date(estimate.sent_at).getTime()) / (60 * 60 * 1000);

  let occurrence: 1 | 2 | null = null;
  if (hoursSinceSent >= FOLLOWUP_2_HOURS) {
    occurrence = 2;
  } else if (hoursSinceSent >= FOLLOWUP_1_HOURS) {
    occurrence = 1;
  }

  if (!occurrence) {
    return { estimateId: estimate.id, outcome: "not_due" };
  }

  return sendFollowup(supabase, estimate, occurrence, sendSmsFn, triggerSource);
}

async function expireEstimate(
  supabase: SupabaseClient,
  estimate: CandidateEstimate,
  triggerSource: WorkflowExecutionTriggerSource = "event",
): Promise<FollowupOutcome> {
  const idempotencyKey = `estimate.expired:${estimate.id}`;

  const eventResult = await createAutomationEventAsService(supabase, estimate.organization_id, {
    eventType: "estimate.expired",
    entityType: "estimate",
    entityId: estimate.id,
    payload: { estimate_id: estimate.id },
    idempotencyKey,
  });

  if (!eventResult.ok) {
    return { estimateId: estimate.id, outcome: "failed", error: eventResult.error };
  }

  // Transition the estimate regardless of duplicate - if a prior tick
  // already recorded the event but crashed before the status update landed,
  // this still needs to happen; the update itself is naturally idempotent
  // (WHERE status = 'sent' guards against re-expiring an estimate a human
  // has since accepted/declined).
  await supabase
    .from("estimates")
    .update({ status: "expired" })
    .eq("id", estimate.id)
    .eq("status", "sent");

  if (eventResult.duplicate) {
    return { estimateId: estimate.id, outcome: "skipped_duplicate" };
  }
  // Unreachable in practice - processOneEstimate's own top-of-function check
  // already returned before calling this - but the type system correctly
  // requires narrowing event: AutomationEvent | null before using it below.
  if (eventResult.skipped) {
    return { estimateId: estimate.id, outcome: "skipped_disabled" };
  }

  const executionResult = await startWorkflowExecutionAsService(
    supabase,
    eventResult.event.id,
    ESTIMATE_EXPIRED_WORKFLOW,
    {},
    triggerSource,
  );
  if (executionResult.ok) {
    await completeWorkflowExecutionAsService(supabase, executionResult.execution.id, {
      lifecycle_only: true,
      estimate_id: estimate.id,
    });
  }

  return { estimateId: estimate.id, outcome: "expired" };
}

async function sendFollowup(
  supabase: SupabaseClient,
  estimate: CandidateEstimate,
  occurrence: 1 | 2,
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
  triggerSource: WorkflowExecutionTriggerSource = "event",
): Promise<FollowupOutcome> {
  const idempotencyKey = `estimate.followup:${estimate.id}:${occurrence}`;

  const eventResult = await createAutomationEventAsService(supabase, estimate.organization_id, {
    eventType: "estimate.followup",
    entityType: "estimate",
    entityId: estimate.id,
    payload: { estimate_id: estimate.id, contact_id: estimate.contact_id, lead_id: estimate.lead_id, occurrence },
    idempotencyKey,
  });

  if (!eventResult.ok) {
    return { estimateId: estimate.id, outcome: "failed", error: eventResult.error };
  }
  if (eventResult.duplicate) {
    return { estimateId: estimate.id, outcome: "skipped_duplicate" };
  }
  if (eventResult.skipped) {
    return { estimateId: estimate.id, outcome: "skipped_disabled" };
  }

  const executionResult = await startWorkflowExecutionAsService(
    supabase,
    eventResult.event.id,
    ESTIMATE_FOLLOWUP_WORKFLOW,
    {},
    triggerSource,
  );
  if (!executionResult.ok) {
    return { estimateId: estimate.id, outcome: "failed", error: executionResult.error };
  }

  const executionId = executionResult.execution.id;

  let conversationId: string | null = null;
  if (estimate.contact_id) {
    const conversation = await findOrCreateOpenConversation(
      supabase,
      estimate.organization_id,
      estimate.contact_id,
      "sms",
      estimate.lead_id,
    );
    conversationId = conversation?.id ?? null;
  }

  const body = composeFollowupBody(estimate, occurrence);

  const gateResult = await evaluateOutboundGate(supabase, {
    organizationId: estimate.organization_id,
    executionId,
    contactId: estimate.contact_id,
    conversationId,
    leadId: estimate.lead_id,
    aiResult: { should_send: true, response_message: body, needs_human: false },
    estimateId: estimate.id,
    estimateEligibleStatuses: ACTIVE_STATUSES,
  });

  if (!gateResult.allowed) {
    await completeWorkflowExecutionAsService(supabase, executionId, {
      should_send: false,
      blocked_reason: gateResult.reason,
      blocked_detail: gateResult.detail ?? null,
      estimate_id: estimate.id,
      occurrence,
    });
    return { estimateId: estimate.id, outcome: "blocked", reason: gateResult.reason };
  }

  const sendResult = await sendOutboundMessage(supabase, {
    organizationId: estimate.organization_id,
    contactId: gateResult.contactId,
    conversationId: gateResult.conversationId,
    channel: "sms",
    body: gateResult.body,
    senderType: "ai",
    workflowExecutionId: executionId,
    sendSmsFn,
  });

  if (!sendResult.ok) {
    await failWorkflowExecutionAsService(supabase, executionId, sendResult.error);
    return { estimateId: estimate.id, outcome: "failed", error: sendResult.error };
  }

  await completeWorkflowExecutionAsService(supabase, executionId, {
    should_send: true,
    message_id: sendResult.messageId,
    conversation_id: sendResult.conversationId,
    provider_message_id: sendResult.providerMessageId,
    estimate_id: estimate.id,
    occurrence,
  });

  return { estimateId: estimate.id, outcome: "sent", occurrence, messageId: sendResult.messageId };
}

export type FollowupPreview =
  | { outcome: "would_send"; estimateId: string; occurrence: 1 | 2; body: string }
  | { outcome: "would_expire"; estimateId: string }
  | { outcome: "no_candidates" }
  | { outcome: "no_contact"; estimateId: string }
  | { outcome: "contact_opted_out"; estimateId: string };

/**
 * Phase D dry run: a read-only preview, never a fake execution - see
 * previewAppointmentReminders in appointment-reminders.ts for the same
 * rationale. Mirrors processOneEstimate's per-candidate eligibility logic
 * (expiration check, then follow-up occurrence timing) but never creates an
 * automation_events/workflow_executions row, never updates estimates.status,
 * and never calls sendOutboundMessage, evaluateOutboundGate, or any
 * provider/n8n code path - this function does not import any of them.
 */
export async function previewEstimateFollowups(
  supabase: SupabaseClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<FollowupPreview> {
  const { data: rawCandidates } = await supabase
    .from("estimates")
    .select("id, organization_id, contact_id, lead_id, title, status, sent_at, expires_at")
    .eq("organization_id", organizationId)
    .in("status", ACTIVE_STATUSES)
    .not("sent_at", "is", null)
    .limit(500);

  const candidates = (rawCandidates ?? []) as CandidateEstimate[];

  for (const estimate of candidates) {
    if (estimate.expires_at && new Date(estimate.expires_at).getTime() <= now.getTime()) {
      return { outcome: "would_expire", estimateId: estimate.id };
    }

    const hoursSinceSent = (now.getTime() - new Date(estimate.sent_at).getTime()) / (60 * 60 * 1000);

    let occurrence: 1 | 2 | null = null;
    if (hoursSinceSent >= FOLLOWUP_2_HOURS) {
      occurrence = 2;
    } else if (hoursSinceSent >= FOLLOWUP_1_HOURS) {
      occurrence = 1;
    }

    if (!occurrence) continue;

    if (!estimate.contact_id) {
      return { outcome: "no_contact", estimateId: estimate.id };
    }

    const { data: contact } = await supabase
      .from("contacts")
      .select("sms_opt_out")
      .eq("id", estimate.contact_id)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (contact?.sms_opt_out) {
      return { outcome: "contact_opted_out", estimateId: estimate.id };
    }

    return { outcome: "would_send", estimateId: estimate.id, occurrence, body: composeFollowupBody(estimate, occurrence) };
  }

  return { outcome: "no_candidates" };
}
