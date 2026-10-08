import type { Lead } from "@/lib/leads/queries";
import type { Appointment } from "@/lib/appointments/queries";
import type { Estimate } from "@/lib/estimates/queries";
import type { Job } from "@/lib/jobs/queries";
import type { Conversation, Message } from "@/lib/conversations/queries";
import type { Invoice } from "@/lib/invoices/queries";
import { formatAppointmentDate, formatAppointmentTimeRange } from "@/lib/appointments/format";
import { calendarDateInTimeZone, formatInvoiceNumber, formatMoney, isOverdue } from "@/lib/invoices/domain";
import { INVOICING_LIVE_AT } from "@/lib/invoices/summary";
import { readCustomerReactivationConfig, readEstimateFollowupConfig } from "@/lib/automation/settings";
import { deriveLifecycleStage, type LifecycleResult } from "@/lib/lifecycle/derive";
import { isApprovedJobAwaitingSchedule } from "@/lib/jobs/schedule";
import type { LifecyclePolicy, LifecycleSnapshot } from "@/lib/lifecycle/snapshot";

export type NextStep = { label: string; detail?: string; href: string; attention: boolean };

/**
 * Final Batch 3: a person's next action, derived from the CANONICAL lifecycle
 * (lib/lifecycle, P0-B B1) - never from leads.status on its own.
 *
 *   database rows (already loaded by the page)
 *     -> buildPersonLifecycleSnapshot (pure field mapping, no rules)
 *     -> deriveLifecycleStage (B1: stage, precedence, the deciding entity)
 *     -> findPersonNextStep (stage + deciding entity -> one action)
 *     -> UI
 *
 * The only thing ranked above the lifecycle is a conversation waiting on the
 * business (a customer message nobody has answered) - that is a reply owed
 * right now, whatever the stage. Everything else comes from the canonical
 * stage, so an accepted estimate, an active job, a sent estimate or a newer
 * opportunity always outranks a stale lead status, and a cancelled/no-show
 * appointment is never treated as booked.
 *
 * Settled stages (paid / customer / dormant / lost / no activity) have no
 * next step, with one exception: an outstanding balance on a live invoice is
 * always surfaced (see `outstandingInvoiceStep`).
 */

/** The lifecycle policy for an organization; the defaults are the automation config defaults. */
export function lifecyclePolicyFrom(configs: { customerReactivation?: unknown; estimateFollowup?: unknown } = {}): LifecyclePolicy {
  return {
    dormancyDays: readCustomerReactivationConfig(configs.customerReactivation ?? null).inactivity_days,
    estimateFollowupHours: readEstimateFollowupConfig(configs.estimateFollowup ?? null).followup_1_hours,
    invoicingLiveAt: INVOICING_LIVE_AT,
  };
}

type AppointmentInput = Pick<Appointment, "id" | "start_at" | "end_at" | "status"> & Partial<Pick<Appointment, "lead_id" | "created_at">>;
type InvoiceInput = Pick<Invoice, "id" | "job_id" | "number" | "status" | "balance_due" | "due_date">;
type MessageInput = Pick<Message, "direction" | "status" | "created_at">;
type RequestInput = { id: string; job_id: string | null; status: string; requested_at: string | null };

export type PersonLifecycleInput = {
  contactId?: string;
  leads: Pick<Lead, "id" | "status" | "created_at">[];
  appointments: AppointmentInput[];
  estimates: Pick<Estimate, "id" | "lead_id" | "status" | "sent_at" | "expires_at" | "created_at">[];
  jobs: Pick<Job, "id" | "lead_id" | "estimate_id" | "status" | "created_at" | "completed_at">[];
  invoices?: InvoiceInput[];
  /** Review/referral requests on this person's jobs, when the page has them (they only ever decide the review/referral stages). */
  reviewRequests?: RequestInput[];
  referralRequests?: RequestInput[];
  /**
   * The person's messages, when the page has them. Without them the lead
   * phase cannot tell "new" from "responded" from "conversing", so a generic
   * follow-up is shown rather than a guess.
   */
  messages?: MessageInput[];
  smsOptOut?: boolean;
  policy?: LifecyclePolicy;
  now?: number;
};

/** Pure field mapping from the rows a page already loaded into the canonical snapshot - no rules live here. */
export function buildPersonLifecycleSnapshot(input: PersonLifecycleInput): LifecycleSnapshot {
  return {
    contactId: input.contactId ?? "",
    asOf: new Date(input.now ?? Date.now()).toISOString(),
    policy: input.policy ?? lifecyclePolicyFrom(),
    smsOptOut: Boolean(input.smsOptOut),
    leads: input.leads.map((lead) => ({ id: lead.id, status: lead.status, createdAt: lead.created_at })),
    appointments: input.appointments.map((appointment) => ({
      id: appointment.id,
      leadId: appointment.lead_id ?? null,
      status: appointment.status,
      startAt: appointment.start_at,
      endAt: appointment.end_at ?? null,
      createdAt: appointment.created_at ?? null,
    })),
    estimates: input.estimates.map((estimate) => ({ id: estimate.id, leadId: estimate.lead_id, status: estimate.status, sentAt: estimate.sent_at, expiresAt: estimate.expires_at, createdAt: estimate.created_at })),
    jobs: input.jobs.map((job) => ({ id: job.id, leadId: job.lead_id, estimateId: job.estimate_id, status: job.status, createdAt: job.created_at, completedAt: job.completed_at })),
    invoices: (input.invoices ?? []).map((invoice) => ({ id: invoice.id, jobId: invoice.job_id, status: invoice.status, dueDate: invoice.due_date })),
    reviewRequests: (input.reviewRequests ?? []).map((request) => ({ id: request.id, jobId: request.job_id, status: request.status, requestedAt: request.requested_at })),
    referralRequests: (input.referralRequests ?? []).map((request) => ({ id: request.id, jobId: request.job_id, status: request.status, requestedAt: request.requested_at })),
    messages: (input.messages ?? []).map((message) => ({ direction: message.direction, status: message.status, createdAt: message.created_at })),
    openOpportunityTypes: [],
  };
}

/** The canonical lifecycle for one person, from the rows the page already loaded. */
export function derivePersonLifecycle(input: PersonLifecycleInput): LifecycleResult {
  return deriveLifecycleStage(buildPersonLifecycleSnapshot(input));
}

export type PersonNextStepInput = Omit<PersonLifecycleInput, "estimates" | "jobs"> & {
  estimates: Pick<Estimate, "id" | "lead_id" | "status" | "sent_at" | "expires_at" | "created_at" | "title">[];
  /** scheduled_for is optional: a caller that did not read it keeps the plain job step (never treated as unscheduled). */
  jobs: (Pick<Job, "id" | "lead_id" | "estimate_id" | "status" | "created_at" | "completed_at" | "title"> & Partial<Pick<Job, "scheduled_for">>)[];
  conversations: Pick<Conversation, "id" | "status">[];
  /**
   * Phase 2-13 (§3): the open conversations waiting on the business - the
   * latest customer message is inbound with no successful outbound after it
   * (lib/conversations/getWaitingConversationIds).
   */
  waitingConversationIds: ReadonlySet<string>;
  timeZone?: string;
  /** The organization records jobs (contractor vertical): a lead marked won with no job then gets "Create the job". */
  jobsEnabled?: boolean;
  /** A precomputed lifecycle for the same rows (the page may already hold it for the badge). */
  lifecycle?: LifecycleResult;
};

export function findPersonNextStep(params: PersonNextStepInput): NextStep | null {
  const { conversations, waitingConversationIds, timeZone, invoices = [], now = Date.now() } = params;

  const waitingConversation = conversations.find((conversation) => conversation.status === "open" && waitingConversationIds.has(conversation.id));
  if (waitingConversation) {
    return { label: "Needs your attention", detail: "A conversation is waiting for a reply.", href: `/conversations/${waitingConversation.id}`, attention: true };
  }

  const lifecycle = params.lifecycle ?? derivePersonLifecycle({ ...params, now });
  const personHref = params.contactId ? `/people/${params.contactId}` : "/people";
  const newEstimateHref = params.contactId ? `/estimates?new=estimate&contactId=${params.contactId}` : "/estimates?new=estimate";
  const primaryId = lifecycle.primary?.id ?? null;
  const estimate = (id: string | null) => params.estimates.find((row) => row.id === id) ?? null;
  const job = (id: string | null) => params.jobs.find((row) => row.id === id) ?? null;
  const appointment = (id: string | null) => params.appointments.find((row) => row.id === id) ?? null;
  const messagesKnown = params.messages !== undefined;

  switch (lifecycle.stage) {
    case "job_active": {
      const active = job(primaryId);
      // Job scheduling state: the customer approved, the job exists, and the work has not been scheduled yet.
      if (active && isApprovedJobAwaitingSchedule({ status: active.status, estimate_id: active.estimate_id, scheduled_for: active.scheduled_for }, estimate(active.estimate_id)?.status)) {
        return { label: "Schedule the work", detail: `Customer approved · ${active.title}`, href: `/jobs/${active.id}`, attention: true };
      }
      return { label: "Job in progress", detail: active?.title, href: active ? `/jobs/${active.id}` : personHref, attention: false };
    }
    case "won": {
      if (lifecycle.primary?.type === "estimate") {
        const accepted = estimate(primaryId);
        return { label: "Create the job", detail: accepted ? `Estimate accepted · ${accepted.title}` : "Estimate accepted · no job yet", href: `/estimates/${primaryId}`, attention: true };
      }
      // A lead marked won with no job and no accepted estimate (e.g. a gym
      // membership conversion): only an organization that records jobs is
      // pointed at one.
      return params.jobsEnabled ? { label: "Create the job", detail: "Marked won · no job recorded yet", href: "/jobs", attention: true } : null;
    }
    case "invoicing":
      return invoiceStepForJob(job(primaryId), invoices, timeZone, now);
    case "estimate_follow_up": {
      const sent = estimate(primaryId);
      return { label: "Follow up on estimate", detail: sent?.title, href: `/estimates/${primaryId}`, attention: true };
    }
    case "estimate_sent": {
      const sent = estimate(primaryId);
      return { label: "Estimate awaiting response", detail: sent?.title, href: `/estimates/${primaryId}`, attention: false };
    }
    case "estimating": {
      if (lifecycle.primary?.type === "estimate") {
        const draft = estimate(primaryId);
        return { label: "Send the estimate", detail: draft ? `Draft · ${draft.title}` : "Draft estimate", href: `/estimates/${primaryId}`, attention: true };
      }
      return { label: "Create the estimate", detail: "Lead marked Estimate · no estimate yet", href: newEstimateHref, attention: true };
    }
    case "visited": {
      const visit = appointment(primaryId);
      if (visit && (visit.status === "scheduled" || visit.status === "confirmed")) {
        return {
          label: "Close out the appointment",
          detail: `Past visit not marked completed · ${formatAppointmentDate(visit.start_at, timeZone)}`,
          href: `/appointments/${visit.id}`,
          attention: true,
        };
      }
      return { label: "Send an estimate", detail: "Visit completed · nothing quoted yet", href: newEstimateHref, attention: true };
    }
    case "booked": {
      const booked = appointment(primaryId);
      if (booked) {
        return {
          label: "Appointment scheduled",
          detail: `${formatAppointmentDate(booked.start_at, timeZone)} · ${formatAppointmentTimeRange(booked.start_at, booked.end_at, timeZone)}`,
          href: `/appointments/${booked.id}`,
          attention: false,
        };
      }
      return { label: "Schedule the appointment", detail: "Lead marked Appointment · nothing on the calendar", href: "/schedule", attention: true };
    }
    case "qualified":
      return { label: "Book an appointment", detail: "Qualified lead · nothing booked yet", href: "/schedule", attention: true };
    case "conversing":
    case "responding":
    case "new_lead": {
      if (!messagesKnown) return { label: "Follow up with customer", detail: "No appointment or estimate in motion yet.", href: personHref, attention: true };
      if (lifecycle.stage === "new_lead") return { label: "Respond to new lead", detail: "Nobody has replied yet.", href: personHref, attention: true };
      if (lifecycle.stage === "conversing") return { label: "Continue the conversation", detail: "The customer replied.", href: personHref, attention: true };
      return { label: "Follow up with customer", detail: "Waiting on the customer · nothing booked yet.", href: personHref, attention: true };
    }
    case "review":
    case "referral":
    case "dormant":
    case "paid":
    case "customer":
    case "lost":
    case "no_activity":
      return outstandingInvoiceStep(params.jobs, invoices, timeZone, now);
  }
}

function collectPaymentStep(invoice: InvoiceInput, timeZone: string | undefined, now: number): NextStep {
  const today = calendarDateInTimeZone(new Date(now), timeZone ?? "UTC");
  const overdue = isOverdue({ status: invoice.status, dueDate: invoice.due_date }, today);
  return {
    label: "Collect payment",
    detail: `${formatInvoiceNumber(invoice.number)} · ${formatMoney(invoice.balance_due)} due${overdue ? " · overdue" : ""}`,
    href: `/invoices/${invoice.id}`,
    attention: overdue,
  };
}

/** Phase 1B-4's invoice step for a completed job the canonical model says is still being invoiced. */
function invoiceStepForJob(job: Pick<Job, "id" | "title"> | null, invoices: InvoiceInput[], timeZone: string | undefined, now: number): NextStep | null {
  if (!job) return null;
  const liveInvoice = invoices.find((invoice) => invoice.job_id === job.id && invoice.status !== "void") ?? null;
  if (!liveInvoice) return { label: "Create invoice", detail: job.title, href: `/jobs/${job.id}`, attention: false };
  if (liveInvoice.status === "draft") return { label: "Issue invoice", detail: `${formatInvoiceNumber(liveInvoice.number)} · ${job.title}`, href: `/invoices/${liveInvoice.id}`, attention: false };
  if (liveInvoice.status === "sent" || liveInvoice.status === "partially_paid") return collectPaymentStep(liveInvoice, timeZone, now);
  return null;
}

/**
 * Money still owed on a live invoice is always worth surfacing, even when the
 * canonical stage is settled - e.g. a job completed before invoicing went
 * live that was later invoiced by hand (B1 never counts such a job as
 * "invoicing"; reported, not changed).
 */
function outstandingInvoiceStep(jobs: Pick<Job, "id">[], invoices: InvoiceInput[], timeZone: string | undefined, now: number): NextStep | null {
  const jobIds = new Set(jobs.map((row) => row.id));
  const open = invoices.find((invoice) => (invoice.status === "sent" || invoice.status === "partially_paid") && invoice.job_id !== null && jobIds.has(invoice.job_id));
  return open ? collectPaymentStep(open, timeZone, now) : null;
}
