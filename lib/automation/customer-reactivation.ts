import type { SupabaseClient } from "@supabase/supabase-js";
import { runDerivedTouch, type DerivedTouchAdapter } from "./touch-runtime";
import { getAutomationEnabled, getAutomationConfigByOrganization, readCustomerReactivationConfig, type CustomerReactivationConfig } from "./settings";
import { OPEN_LEAD_STATUSES, type LeadStatus } from "@/lib/leads/queries";
import type { SendSmsInput, SendSmsResult } from "@/lib/automation/sms";
import { readAllPages } from "@/lib/bi/revenue-attribution";
import { enabledPerOrganization } from "./late-touch";

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

  // Phase 3 (W2): every completed job, paged newest-first with an id tie-break - the old single read stopped
  // at the 1,000 newest jobs across every organization, which dropped exactly the long-dormant customers this
  // automation exists for. A failed page stops the run with nothing processed.
  const read = await readAllPages<CandidateJob>(() =>
    supabase
      .from("jobs")
      .select("id, organization_id, contact_id, title, completed_at")
      .eq("status", "completed")
      .not("contact_id", "is", null)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .order("id"),
  );
  if (read.failed) {
    throw new Error("Customer reactivation: the candidate read failed or reached the row limit - no customer was processed.");
  }

  // Reduce to the single most recently completed job per contact - jobs
  // were fetched newest-first, so the first one seen for a given contact_id
  // is that contact's latest.
  const latestJobByContact = new Map<string, CandidateJob>();
  for (const row of read.rows) {
    if (!latestJobByContact.has(row.contact_id)) {
      latestJobByContact.set(row.contact_id, row);
    }
  }

  const candidates = Array.from(latestJobByContact.values()).filter((job) => {
    const config = readCustomerReactivationConfig(configByOrg.get(job.organization_id) ?? null);
    return isReactivationDue(job.completed_at, config, now);
  });

  const outcomes: CustomerReactivationOutcome[] = [];
  const isEnabled = enabledPerOrganization((organizationId) => getAutomationEnabled(supabase, organizationId, "customer-reactivation"));
  for (const job of candidates) {
    const config = readCustomerReactivationConfig(configByOrg.get(job.organization_id) ?? null);
    outcomes.push(await processOneCustomer(supabase, job, config, now, sendSmsFn, isEnabled));
  }

  return { candidates: candidates.length, outcomes };
}

type ReactivationItem = { job: CandidateJob; config: CustomerReactivationConfig };
type ReactivationFacts = { contact: ReactivationContact; title: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * P0-B B2.4: customer reactivation's kind adapter for the shared touch
 * runtime (lib/automation/touch-runtime.ts). Every value below is this
 * automation's existing behavior, unchanged: one touch per (contact, latest
 * completed job) under the legacy key customer.reactivation:<contact>:<job>,
 * anchored on the job's completed_at + the organization's inactivity_days,
 * the organization payment check, the "no recent active opportunity / open
 * conversation / job still completed / contact exists" checks in their
 * original order, the 48-hour overdue rule, the deterministic Trackpr-composed
 * message, and the gate's job + business-hours options (no automation-enabled
 * re-check at the gate, as before). It is not retried by A2.
 */
export const CUSTOMER_REACTIVATION_ADAPTER: DerivedTouchAdapter<ReactivationItem, ReactivationFacts> = {
  identity: { automationId: "customer-reactivation", eventType: "customer.reactivation", workflowName: CUSTOMER_REACTIVATION_WORKFLOW },
  policy: { requiresActivePayment: true, stale: "record_overdue", gateChecksAutomationEnabled: false, senderType: "ai" },
  subject: ({ job }) => ({ organizationId: job.organization_id, contactId: job.contact_id, leadId: null, entityType: "job", entityId: job.id }),
  idempotencyKey: ({ job }) => `customer.reactivation:${job.contact_id}:${job.id}`,
  isDue: ({ job, config }, now) => isReactivationDue(job.completed_at, config, now),
  dueAt: ({ job, config }) => ({ anchorMs: new Date(job.completed_at).getTime(), delayMs: config.inactivity_days * DAY_MS }),
  stillOwed: async (supabase, { job }) => {
    const contactId = job.contact_id;
    const organizationId = job.organization_id;

    // "No recent active opportunity" (requirement): a past customer with an
    // open lead, an active appointment, an active estimate, or another active
    // job right now is already being engaged through that channel - a
    // reactivation ping would be redundant, not helpful.
    const [{ data: openLead }, { data: activeAppointment }, { data: activeEstimate }, { data: activeJob }] = await Promise.all([
      supabase.from("leads").select("id, status").eq("contact_id", contactId).eq("organization_id", organizationId).limit(20),
      supabase.from("appointments").select("id").eq("contact_id", contactId).eq("organization_id", organizationId).in("status", ACTIVE_APPOINTMENT_STATUSES).limit(1).maybeSingle(),
      supabase.from("estimates").select("id").eq("contact_id", contactId).eq("organization_id", organizationId).in("status", ACTIVE_ESTIMATE_STATUSES).limit(1).maybeSingle(),
      supabase.from("jobs").select("id").eq("contact_id", contactId).eq("organization_id", organizationId).in("status", ACTIVE_JOB_STATUSES).limit(1).maybeSingle(),
    ]);
    const hasOpenLead = ((openLead ?? []) as { id: string; status: LeadStatus }[]).some((lead) => OPEN_LEAD_STATUSES.has(lead.status));
    if (hasOpenLead || activeAppointment || activeEstimate || activeJob) return { owed: false, reason: "active_engagement" };

    // "No recent active conversation" (Part 12 safety checklist): an already
    // -open conversation means this contact is currently mid-thread with the
    // business for some other reason - never interject an unrelated
    // reactivation ping into it.
    const { data: openConversation } = await supabase.from("conversations").select("id").eq("organization_id", organizationId).eq("contact_id", contactId).eq("status", "open").maybeSingle();
    if (openConversation) return { owed: false, reason: "has_open_conversation" };

    // Re-check live state immediately before dispatch: the job could have
    // been reopened/edited during the queries above.
    const { data: freshJob } = await supabase.from("jobs").select("id, status, title").eq("id", job.id).eq("organization_id", organizationId).maybeSingle();
    if (!freshJob || freshJob.status !== "completed") return { owed: false, reason: "job_not_completed" };

    const { data: contact } = await supabase.from("contacts").select("id, organization_id, first_name, phone, sms_opt_out").eq("id", contactId).eq("organization_id", organizationId).maybeSingle();
    if (!contact) return { owed: false, reason: "no_contact" };

    return { owed: true, facts: { contact: contact as ReactivationContact, title: freshJob.title as string } };
  },
  payload: ({ job }, facts) => ({ contact_id: job.contact_id, job_id: job.id, job_title: facts.title }),
  compose: ({ job }, facts) => composeReactivationBody(facts.contact, { ...job, title: facts.title }),
  gateOptions: ({ job, config }) => ({ jobId: job.id, jobEligibleStatuses: ["completed"], respectBusinessHours: config.respect_business_hours }),
  resultMetadata: ({ job }) => ({ job_id: job.id }),
};

async function processOneCustomer(
  supabase: SupabaseClient,
  job: CandidateJob,
  config: CustomerReactivationConfig,
  now: Date,
  sendSmsFn?: (input: SendSmsInput) => Promise<SendSmsResult>,
  isEnabled: (organizationId: string) => Promise<boolean> = (organizationId) => getAutomationEnabled(supabase, organizationId, "customer-reactivation"),
): Promise<CustomerReactivationOutcome> {
  const contactId = job.contact_id;
  const result = await runDerivedTouch(supabase, CUSTOMER_REACTIVATION_ADAPTER, { job, config }, now, { isEnabled, sendSmsFn });
  switch (result.status) {
    case "sent":
      return { contactId, outcome: "sent", messageId: result.messageId };
    case "blocked":
      return { contactId, outcome: "blocked", reason: result.reason };
    case "failed":
      return { contactId, outcome: "failed", error: result.error };
    case "lifecycle_failed":
      return { contactId, outcome: "failed", error: `lifecycle_snapshot_failed: ${result.error}` };
    case "subject_missing":
      return { contactId, outcome: "no_contact" };
    case "not_owed":
      return { contactId, outcome: result.reason as "active_engagement" | "has_open_conversation" | "job_not_completed" | "no_contact" };
    default:
      return { contactId, outcome: result.status };
  }
}
