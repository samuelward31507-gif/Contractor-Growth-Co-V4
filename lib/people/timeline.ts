import type { LucideIcon } from "lucide-react";
import { CalendarClock, UserPlus, Send, MessageCircle, ArrowRightLeft, Briefcase, Ban } from "lucide-react";
import type { Lead, LeadStatus } from "@/lib/leads/queries";
import type { Appointment } from "@/lib/appointments/queries";
import type { Estimate } from "@/lib/estimates/queries";
import type { Job } from "@/lib/jobs/queries";
import type { Message } from "@/lib/conversations/queries";
import type { LeadStageHistoryEntry } from "@/lib/automation/lead-stage-history";
import { formatAppointmentDate } from "@/lib/appointments/format";
import { formatCurrency } from "@/lib/dashboard/format";
import { STATUS_LABELS as LEAD_STATUS_LABELS } from "@/lib/leads/format";

export type TimelineEvent = {
  id: string;
  at: string;
  icon: LucideIcon;
  label: string;
  detail?: string;
};

function truncate(text: string, max = 90): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Phase 3 (People pass): the real work this phase is built on - the same
 * chronological event feed app/(app)/leads/[id]/page.tsx's own "What
 * happened" section already builds (lead created, stage transitions,
 * appointments scheduled, estimates sent/responded, job created, messages
 * sent/received), generalized from one lead to a whole person's history
 * across every lead, estimate, appointment, job, and conversation they've
 * ever had - a repeat customer's second job shows up in the same feed as
 * their first, not as an unrelated fresh page.
 *
 * Every timestamp this reads already exists on the real rows (created_at,
 * sent_at/responded_at, message.created_at, lead_stage_history.changed_at)
 * - no new field, no invented event, nothing this function can't trace
 * back to a real row. Multi-lead stage history is threaded through as an
 * already-resolved array (one getLeadStageHistory call per lead, made by
 * the caller) rather than this function performing its own I/O, so the
 * merge itself stays a pure, directly-testable function.
 */
export function buildPersonTimeline(params: {
  leads: Lead[];
  stageHistoryByLeadId: Map<string, LeadStageHistoryEntry[]>;
  appointments: Appointment[];
  estimates: Estimate[];
  jobs: Job[];
  messages: Message[];
  timeZone?: string;
}): TimelineEvent[] {
  const { leads, stageHistoryByLeadId, appointments, estimates, jobs, messages, timeZone } = params;

  const events: TimelineEvent[] = [
    ...leads.map((lead) => ({
      id: `lead-${lead.id}`,
      at: lead.created_at,
      icon: UserPlus,
      label: "Lead created",
      detail: lead.service ? (lead.source ? `${lead.service} · via ${lead.source}` : lead.service) : lead.source ? `via ${lead.source}` : undefined,
    })),

    ...leads.flatMap((lead) => {
      const history = stageHistoryByLeadId.get(lead.id) ?? [];
      return history
        .filter((entry) => entry.previousStatus !== null)
        .map((entry) => ({
          id: `stage-${entry.id}`,
          at: entry.changedAt,
          icon: ArrowRightLeft,
          label: `${LEAD_STATUS_LABELS[entry.previousStatus as LeadStatus]} → ${LEAD_STATUS_LABELS[entry.newStatus]}`,
          detail: entry.source === "automation" ? "Automatic" : "Updated by staff",
        }));
    }),

    ...appointments.map((appointment) => ({
      id: `apt-${appointment.id}`,
      at: appointment.created_at,
      icon: CalendarClock,
      label: "Appointment scheduled",
      detail: `${appointment.title} · ${formatAppointmentDate(appointment.start_at, timeZone)}`,
    })),

    ...estimates.flatMap((estimate) => {
      const estimateEvents: TimelineEvent[] = [];
      if (estimate.sent_at) {
        estimateEvents.push({
          id: `est-sent-${estimate.id}`,
          at: estimate.sent_at,
          icon: Send,
          label: "Estimate sent",
          detail: estimate.amount != null ? formatCurrency(estimate.amount) : estimate.title,
        });
      }
      if (estimate.responded_at) {
        estimateEvents.push({
          id: `est-responded-${estimate.id}`,
          at: estimate.responded_at,
          icon: estimate.status === "accepted" ? ArrowRightLeft : Ban,
          label: estimate.status === "accepted" ? "Estimate accepted" : estimate.status === "declined" ? "Estimate declined" : "Estimate responded to",
          detail: estimate.title,
        });
      }
      return estimateEvents;
    }),

    ...jobs.map((job) => ({
      id: `job-${job.id}`,
      at: job.created_at,
      icon: Briefcase,
      label: "Job created",
      detail: job.title,
    })),

    ...messages.map((message) => ({
      id: `msg-${message.id}`,
      at: message.created_at,
      icon: message.direction === "inbound" ? MessageCircle : Send,
      label:
        message.direction === "inbound"
          ? "Customer replied"
          : message.sender_type === "ai"
            ? "Automated follow-up sent"
            : message.sender_type === "system"
              ? "System message sent"
              : "You sent a message",
      detail: truncate(message.body),
    })),
  ];

  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
