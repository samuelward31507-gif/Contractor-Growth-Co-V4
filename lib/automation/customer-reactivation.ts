import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEventAsService } from "./events";
import { startWorkflowExecutionAsService, completeWorkflowExecutionAsService, failWorkflowExecutionAsService } from "./executions";
import { evaluateOutboundGate } from "./outbound-gate";
import { sendOutboundMessage } from "@/lib/messaging/outbound";
import { findOrCreateOpenConversation } from "@/lib/conversations/queries";
import { getAutomationEnabled, getAutomationConfigByOrganization, readCustomerReactivationConfig, type CustomerReactivationConfig } from "./settings";
import { OPEN_LEAD_STATUSES, type LeadStatus } from "@/lib/leads/queries";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";

export const CUSTOMER_REACTIVATION_WORKFLOW = "customer_reactivation_followup";

// Exported (Pass 3, Revenue Intelligence Foundation): reused verbatim by
// lib/opportunities/detect.ts's dormant-customer opportunity detector, so
// "what counts as an active engagement that excludes a contact from
// dormancy" has exactly one definition in this codebase, never a second,
// potentially-drifting copy.
export const ACTIVE_APPOINTMENT_STATUSES = ["scheduled", "confirmed"];
export const ACTIVE_ESTIMATE_STATUSES = ["sent", "accepted"];
export const ACTIVE_JOB_STATUSES = ["scheduled", "in_progress"];

type CandidateJob = {
  id: string;
  organization_id: string;
  contact_id: string;
  title: string;
  completed_at: string;
};

type ReactivationContact = {
  id: string;
  organization_id: string;
  first_name: string | null;
  phone: string | null;
  sms_opt_out: boolean;
};

export type CustomerReactivationOutcome =
  | { contactId: string; outcome: "sent"; messageId: string }
  | { contactId: string; outcome: "blocked"; reason: string }
  | { contactId: string; outcome: "not_due" }
  | { contactId: string; outcome: "skipped_duplicate" }
  | { contactId: string; outcome: "skipped_disabled" }
  | { contactId: string; outcome: "payment_inactive" }
  | { contactId: string; outcome: "active_engagement" }
  | { contactId: string; outcome: "has_open_conversation" }
  | { contactId: string; outcome: "job_not_completed" }
  | { contactId: string; outcome: "no_contact" }
  | { contactId: string; outcome: "failed"; error: string };

export type CustomerReactivationRunResult = {
  candidates: number;
  outcomes: CustomerReactivationOutcome[];
};

/**
 * Composes the reactivation body directly in Trackpr, with no AI/n8n round
 * trip - the same dispatch:"trackpr" choice appointment-reminders.ts already
 * made for a fact-only message with no judgment call for a model to make.
 * job.title is a real, stored fact (jobs.title is NOT NULL) - never a
 * hardcoded/invented service, satisfying "Do not hard-code a fake service.
 * Use known customer/job information where available."
 */
function composeReactivationBody(contact: ReactivationContact, job: CandidateJob): string {
  const name = contact.first_name?.trim() || "there";
  return `Hey ${name}, it's been a while since we helped with ${job.title}. If you need anything checked or serviced, we'd be happy to help. Reply STOP to opt out of texts.`;
}

/**
 * The pure eligibility check behind processCustomerReactivation - extracted
 * so "a configured inactivity threshold, not a hardcoded constant, drives
 * occurrence" can be unit tested directly.
 */
export function isReactivationDue(completedAt: string, config: CustomerReactivationConfig, now: Date): boolean {
  const thresholdMs = config.inactivity_days * 24 * 60 * 60 * 1000;
  return now.getTime() - new Date(completedAt).getTime() >= thresholdMs;
}

/**
 * Growth System Completion Pass 2, Part 7 (Old Customer Reactivation).
 * Finds past customers - contacts whose most recently completed job crossed
 * the organization's configured inactivity threshold - and sends each one a
 * single, deterministic re-engagement touch. Structurally mirrors
 * lib/automation/lead-reactivation.ts (the same "find dormant X, dispatch a
 * touch, respect the outbound gate" shape) but reuses
 * lib/automation/appointment-reminders.ts's dispatch:"trackpr" choice
 * instead: this message is pure fact-recitation (the customer's name, the
 * service they last had done), not a judgment call, so there is no AI
 * drafting and no n8n round trip - and per the task's own "do not modify
 * n8n workflows unless absolutely required" instruction, none is needed
 * here.
 *
 * Candidates are found from `jobs` directly (there is no prior lifecycle
 * event to scan, unlike processLeadReactivation) - the single most recently
 * completed job per contact, since that job both anchors the elapsed-time
 * calculation and supplies the real "service" fact the message names. A
 * contact with a LATER completed job automatically starts a fresh dormancy
 * period once that job crosses the threshold, since the idempotency key
 * below is derived from the specific job id, not the contact alone.
 */
export async function processCustomerReactivation(
  supabase: SupabaseClient,
  now: Date = new Date(),
  /** Test seam only - production callers must never pass this; see lib/messaging/outbound.ts. */
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<CustomerReactivationRunResult> {
  const configByOrg = await getAutomationConfigByOrganization(supabase, "customer-reactivation");

  const { data: rawCompletedJobs } = await supabase
    .from("jobs")
    .select("id, organization_id, contact_id, title, completed_at")
    .eq("status", "completed")
    .not("contact_id", "is", null)
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(1000);

  // Reduce to the single most recently completed job per contact - jobs
  // were fetched newest-first, so the first one seen for a given contact_id
  // is that contact's latest.
  const latestJobByContact = new Map<string, CandidateJob>();
  for (const row of (rawCompletedJobs ?? []) as CandidateJob[]) {
    if (!latestJobByContact.has(row.contact_id)) {
      latestJobByContact.set(row.contact_id, row);
    }
  }

  const candidates = Array.from(latestJobByContact.values()).filter((job) => {
    const config = readCustomerReactivationConfig(configByOrg.get(job.organization_id) ?? null);
    return isReactivationDue(job.completed_at, config, now);
  });

  const outcomes: CustomerReactivationOutcome[] = [];
  for (const job of candidates) {
    const config = readCustomerReactivationConfig(configByOrg.get(job.organization_id) ?? null);
    outcomes.push(await processOneCustomer(supabase, job, config, now, sendSmsFn));
  }

  return { candidates: candidates.length, outcomes };
}

async function processOneCustomer(
  supabase: SupabaseClient,
  job: CandidateJob,
  config: CustomerReactivationConfig,
  now: Date,
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
): Promise<CustomerReactivationOutcome> {
  const contactId = job.contact_id;
  const organizationId = job.organization_id;

  // Checked first, before any further query cost - mirrors
  // processOneLead's identical ordering rationale.
  if (!(await getAutomationEnabled(supabase, organizationId, "customer-reactivation"))) {
    return { contactId, outcome: "skipped_disabled" };
  }

  // Customer Reactivation Safety (Part 12): evaluateOutboundGate itself
  // never checks organizations.payment_status (it only checks automation_mode
  // and automation_paused) - a gap shared by every scheduled automation in
  // this codebase, not something specific to this one. Rather than silently
  // change that shared, heavily-relied-on gate's behavior for every existing
  // automation as a side effect of this task, this automation adds its own
  // explicit, narrow payment check up front - an org whose payment lapsed
  // must never receive a new outbound campaign message, full stop.
  const { data: organizationRow } = await supabase.from("organizations").select("payment_status").eq("id", organizationId).maybeSingle();
  if (organizationRow?.payment_status !== "active") {
    return { contactId, outcome: "payment_inactive" };
  }

  if (!isReactivationDue(job.completed_at, config, now)) {
    return { contactId, outcome: "not_due" };
  }

  const idempotencyKey = `customer.reactivation:${contactId}:${job.id}`;

  // Fast-path duplicate check - an optimization only; the real, race-proof
  // guarantee remains createAutomationEventAsService's own idempotency-key
  // unique index below, exactly like every other scheduled automation in
  // this codebase.
  const { data: existingEvent } = await supabase
    .from("automation_events")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingEvent) {
    return { contactId, outcome: "skipped_duplicate" };
  }

  // "No recent active opportunity" (requirement): a past customer with an
  // open lead, an active appointment, an active estimate, or another active
  // job right now is already being engaged through that channel - a
  // reactivation ping would be redundant, not helpful.
  const [{ data: openLead }, { data: activeAppointment }, { data: activeEstimate }, { data: activeJob }] = await Promise.all([
    supabase
      .from("leads")
      .select("id, status")
      .eq("contact_id", contactId)
      .eq("organization_id", organizationId)
      .limit(20),
    supabase
      .from("appointments")
      .select("id")
      .eq("contact_id", contactId)
      .eq("organization_id", organizationId)
      .in("status", ACTIVE_APPOINTMENT_STATUSES)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("estimates")
      .select("id")
      .eq("contact_id", contactId)
      .eq("organization_id", organizationId)
      .in("status", ACTIVE_ESTIMATE_STATUSES)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("jobs")
      .select("id")
      .eq("contact_id", contactId)
      .eq("organization_id", organizationId)
      .in("status", ACTIVE_JOB_STATUSES)
      .limit(1)
      .maybeSingle(),
  ]);

  const hasOpenLead = ((openLead ?? []) as { id: string; status: LeadStatus }[]).some((lead) => OPEN_LEAD_STATUSES.has(lead.status));
  if (hasOpenLead || activeAppointment || activeEstimate || activeJob) {
    return { contactId, outcome: "active_engagement" };
  }

  // "No recent active conversation" (Part 12 safety checklist): an already
  // -open conversation means this contact is currently mid-thread with the
  // business for some other reason - never interject an unrelated
  // reactivation ping into it. findOrCreateOpenConversation below would
  // otherwise silently reuse that same thread.
  const { data: openConversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .maybeSingle();

  if (openConversation) {
    return { contactId, outcome: "has_open_conversation" };
  }

  // Step 9 (mirroring processOneLead's identical "re-check live state
  // immediately before dispatch" principle): the job could have been
  // reopened/edited during the queries above.
  const { data: freshJob } = await supabase
    .from("jobs")
    .select("id, status, title")
    .eq("id", job.id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!freshJob || freshJob.status !== "completed") {
    return { contactId, outcome: "job_not_completed" };
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, organization_id, first_name, phone, sms_opt_out")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!contact) {
    return { contactId, outcome: "no_contact" };
  }

  const eventResult = await createAutomationEventAsService(supabase, organizationId, {
    eventType: "customer.reactivation",
    entityType: "job",
    entityId: job.id,
    payload: { contact_id: contactId, job_id: job.id, job_title: freshJob.title },
    idempotencyKey,
  });

  if (!eventResult.ok) {
    return { contactId, outcome: "failed", error: eventResult.error };
  }
  if (eventResult.duplicate) {
    return { contactId, outcome: "skipped_duplicate" };
  }
  if (eventResult.skipped) {
    return { contactId, outcome: "skipped_disabled" };
  }

  const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, CUSTOMER_REACTIVATION_WORKFLOW);
  if (!executionResult.ok) {
    return { contactId, outcome: "failed", error: executionResult.error };
  }
  const executionId = executionResult.execution.id;

  const conversation = await findOrCreateOpenConversation(supabase, organizationId, contactId, "sms");
  const conversationId = conversation?.id ?? null;

  const body = composeReactivationBody(contact as ReactivationContact, { ...job, title: freshJob.title });

  const gateResult = await evaluateOutboundGate(supabase, {
    organizationId,
    executionId,
    contactId,
    conversationId,
    leadId: null,
    aiResult: { should_send: true, response_message: body, needs_human: false },
    jobId: job.id,
    jobEligibleStatuses: ["completed"],
    respectBusinessHours: config.respect_business_hours,
  });

  if (!gateResult.allowed) {
    await completeWorkflowExecutionAsService(supabase, executionId, {
      should_send: false,
      blocked_reason: gateResult.reason,
      blocked_detail: gateResult.detail ?? null,
      job_id: job.id,
    });
    return { contactId, outcome: "blocked", reason: gateResult.reason };
  }

  const sendResult = await sendOutboundMessage(supabase, {
    organizationId,
    contactId: gateResult.contactId,
    conversationId: gateResult.conversationId,
    channel: "sms",
    body: gateResult.body,
    senderType: "ai",
    workflowExecutionId: executionId,
    sendSmsFn,
  });

  if (!sendResult.ok) {
    await failWorkflowExecutionAsService(supabase, executionId, sendResult.error, "sms_send_failed");
    return { contactId, outcome: "failed", error: sendResult.error };
  }

  await completeWorkflowExecutionAsService(supabase, executionId, {
    should_send: true,
    message_id: sendResult.messageId,
    conversation_id: sendResult.conversationId,
    provider_message_id: sendResult.providerMessageId,
    job_id: job.id,
  });

  return { contactId, outcome: "sent", messageId: sendResult.messageId };
}
