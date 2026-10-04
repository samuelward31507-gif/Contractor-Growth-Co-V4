import type { Lead, LeadStatus } from "@/lib/leads/queries";
import type { Appointment } from "@/lib/appointments/queries";
import type { Estimate } from "@/lib/estimates/queries";
import type { Job } from "@/lib/jobs/queries";
import type { Conversation } from "@/lib/conversations/queries";
import type { Invoice } from "@/lib/invoices/queries";
import { formatAppointmentDate, formatAppointmentTimeRange } from "@/lib/appointments/format";
import { calendarDateInTimeZone, formatInvoiceNumber, formatMoney, isOverdue } from "@/lib/invoices/domain";
import { isLegacyCompletedJob } from "@/lib/invoices/summary";

export type NextStep = { label: string; detail?: string; href: string; attention: boolean };

/**
 * Phase 3 (People pass): the same priority chain
 * app/(app)/leads/[id]/page.tsx's own "What happens next" already uses -
 * a conversation waiting on a human outranks a scheduled appointment,
 * which outranks a pending estimate, which outranks a plain follow-up
 * nudge - generalized from one lead's own records to every record across
 * a whole person's history, so a repeat customer's next step is found
 * regardless of which of their (possibly several) leads it belongs to.
 * Every field this reads is real and already fetched; nothing here is
 * derived from a second, independent calculation.
 *
 * Phase 1B-4 (Close the Money Loop): the won-lead branch now reads the
 * job's own status and its one live invoice instead of always answering
 * "Job in progress":
 *   scheduled / in_progress                      Job in progress (unchanged)
 *   completed, live invoice with an open balance Collect payment (attention
 *                                                when overdue)
 *   completed, live invoice still a draft         Issue invoice
 *   completed, invoice fully paid                 no payment-related step
 *   completed, no live invoice, after go-live     Create invoice
 *   completed, no live invoice, legacy job        no next step
 *   cancelled                                     no next step
 * Balance, status and due date come from the invoice row (the database's
 * own figures); "overdue" is the same read-time derivation Money uses.
 */
export function findPersonNextStep(params: {
  leads: Lead[];
  // Final Major Product Build: loosened from Appointment[] to the exact
  // fields this function reads, matching ContactLifecycleSignals's own
  // Pick<...> convention (lib/customers/lifecycle-stage.ts) - lets the Inbox
  // context panel reuse this function with its own lighter
  // RelevantAppointment[] (lib/conversations/queries.ts) instead of a full
  // Appointment[] fetch it doesn't otherwise need.
  appointments: Pick<Appointment, "id" | "start_at" | "end_at" | "status">[];
  estimates: Estimate[];
  jobs: Job[];
  conversations: Conversation[];
  /**
   * Phase 2-13 (§3): the open conversations waiting on the business - the
   * latest customer message is inbound with no successful outbound after it
   * (lib/conversations/getWaitingConversationIds). Whether AI is on is not
   * part of it. Required, so no caller can fall back to the old AI-off rule.
   */
  waitingConversationIds: ReadonlySet<string>;
  /** Phase 1B-4: this person's invoices (any status). Optional so older callers keep compiling; without it a completed job can only ever suggest "Create invoice". */
  invoices?: Pick<Invoice, "id" | "job_id" | "number" | "status" | "balance_due" | "due_date">[];
  timeZone?: string;
  now?: number;
}): NextStep | null {
  const { leads, appointments, estimates, jobs, conversations, waitingConversationIds, invoices = [], timeZone, now = Date.now() } = params;

  const waitingConversation = conversations.find((conversation) => conversation.status === "open" && waitingConversationIds.has(conversation.id));
  if (waitingConversation) {
    return {
      label: "Needs your attention",
      detail: "A conversation is waiting for a reply.",
      href: `/conversations/${waitingConversation.id}`,
      attention: true,
    };
  }

  const nextAppointment = appointments.find(
    (appointment) => (appointment.status === "scheduled" || appointment.status === "confirmed") && new Date(appointment.start_at).getTime() > now,
  );
  if (nextAppointment) {
    return {
      label: "Appointment scheduled",
      detail: `${formatAppointmentDate(nextAppointment.start_at, timeZone)} · ${formatAppointmentTimeRange(nextAppointment.start_at, nextAppointment.end_at, timeZone)}`,
      href: `/appointments/${nextAppointment.id}`,
      attention: false,
    };
  }

  const pendingEstimate = estimates.find((estimate) => estimate.status === "sent");
  if (pendingEstimate) {
    return {
      label: "Estimate awaiting response",
      detail: pendingEstimate.title,
      href: `/estimates/${pendingEstimate.id}`,
      attention: false,
    };
  }

  // A person can have several leads across their history - the most
  // recently created is the one whose own won/lost/open status decides
  // whether a follow-up nudge is still warranted, matching a single
  // lead's own status check exactly, just applied to the freshest one.
  const mostRecentLead = [...leads].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  if (!mostRecentLead) return null;

  const statusIsWon: LeadStatus = "won";
  if (mostRecentLead.status === statusIsWon) {
    const job = jobs.find((candidate) => candidate.lead_id === mostRecentLead.id);
    if (!job) return null;
    if (job.status === "cancelled") return null;
    if (job.status !== "completed") return { label: "Job in progress", detail: job.title, href: `/jobs/${job.id}`, attention: false };

    const liveInvoice = invoices.find((invoice) => invoice.job_id === job.id && invoice.status !== "void") ?? null;
    if (!liveInvoice) {
      if (isLegacyCompletedJob(job)) return null;
      return { label: "Create invoice", detail: job.title, href: `/jobs/${job.id}`, attention: false };
    }
    if (liveInvoice.status === "draft") {
      return { label: "Issue invoice", detail: `${formatInvoiceNumber(liveInvoice.number)} · ${job.title}`, href: `/invoices/${liveInvoice.id}`, attention: false };
    }
    if (liveInvoice.status === "sent" || liveInvoice.status === "partially_paid") {
      const today = calendarDateInTimeZone(new Date(now), timeZone ?? "UTC");
      const overdue = isOverdue({ status: liveInvoice.status, dueDate: liveInvoice.due_date }, today);
      return {
        label: "Collect payment",
        detail: `${formatInvoiceNumber(liveInvoice.number)} · ${formatMoney(liveInvoice.balance_due)} due${overdue ? " · overdue" : ""}`,
        href: `/invoices/${liveInvoice.id}`,
        attention: overdue,
      };
    }
    return null;
  }
  if (mostRecentLead.status === "lost") return null;

  return { label: "Follow up with customer", detail: "No appointment or estimate in motion yet.", href: "/people", attention: true };
}
