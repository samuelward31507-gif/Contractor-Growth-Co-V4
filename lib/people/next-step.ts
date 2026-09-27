import type { Lead, LeadStatus } from "@/lib/leads/queries";
import type { Appointment } from "@/lib/appointments/queries";
import type { Estimate } from "@/lib/estimates/queries";
import type { Job } from "@/lib/jobs/queries";
import type { Conversation } from "@/lib/conversations/queries";
import { formatAppointmentDate, formatAppointmentTimeRange } from "@/lib/appointments/format";

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
 */
export function findPersonNextStep(params: {
  leads: Lead[];
  appointments: Appointment[];
  estimates: Estimate[];
  jobs: Job[];
  conversations: Conversation[];
  timeZone?: string;
  now?: number;
}): NextStep | null {
  const { leads, appointments, estimates, jobs, conversations, timeZone, now = Date.now() } = params;

  const waitingConversation = conversations.find((conversation) => conversation.status === "open" && !conversation.ai_enabled);
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
    return job ? { label: "Job in progress", detail: job.title, href: `/jobs/${job.id}`, attention: false } : null;
  }
  if (mostRecentLead.status === "lost") return null;

  return { label: "Follow up with customer", detail: "No appointment or estimate in motion yet.", href: "/people", attention: true };
}
