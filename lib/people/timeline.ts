import { isSimulatedMessage } from "@/lib/messaging/simulated-delivery";
import type { LucideIcon } from "lucide-react";
import { CalendarClock, UserPlus, Send, MessageCircle, ArrowRightLeft, Briefcase, Ban, CalendarCheck2, CalendarX2, PlayCircle, Star, Share2 } from "lucide-react";
import type { Lead, LeadStatus } from "@/lib/leads/queries";
import type { Appointment } from "@/lib/appointments/queries";
import type { Estimate } from "@/lib/estimates/queries";
import type { Job } from "@/lib/jobs/queries";
import type { Message } from "@/lib/conversations/queries";
import type { LeadStageHistoryEntry } from "@/lib/automation/lead-stage-history";
import type { ReviewRequest, ReferralRequest } from "@/lib/reviews-referrals/queries";
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
  /** This person's completed-job review requests only (caller filters by job_id, matching every other array here) - see reviewRequests/referralRequests below for why requested_at/resolved_at are the real timestamps used, never invented. */
  reviewRequests?: ReviewRequest[];
  referralRequests?: ReferralRequest[];
  timeZone?: string;
}): TimelineEvent[] {
  const { leads, stageHistoryByLeadId, appointments, estimates, jobs, messages, reviewRequests = [], referralRequests = [], timeZone } = params;

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

    // Final Major Product Build: job.started_at/completed_at are real,
    // already-set timestamps (lib/jobs/queries.ts) written by the exact same
    // markJobStarted/markJobCompleted actions that already drive the Jobs
    // list and Job detail page - not a second, inferred notion of "when did
    // this job move" the way the appointment terminal-state events below
    // have to fall back to updated_at.
    ...jobs.flatMap((job) => {
      const jobEvents: TimelineEvent[] = [];
      if (job.started_at) {
        jobEvents.push({ id: `job-started-${job.id}`, at: job.started_at, icon: PlayCircle, label: "Job started", detail: job.title });
      }
      if (job.completed_at) {
        jobEvents.push({
          id: `job-completed-${job.id}`,
          at: job.completed_at,
          icon: CalendarCheck2,
          label: "Job completed",
          detail: job.amount != null ? `${job.title} · ${formatCurrency(job.amount)}` : job.title,
        });
      }
      return jobEvents;
    }),

    // Final Major Product Build: appointments carry no dedicated
    // completed_at/no_show_at/cancelled_at column (unlike jobs above), so a
    // terminal-state event uses the row's own real updated_at as the closest
    // honest timestamp for "when this appointment last changed" - the same
    // real field the rest of this codebase already treats as authoritative
    // for "last touched" (e.g. the Person page's own "Last updated" line),
    // never a fabricated or estimated time.
    ...appointments.flatMap((appointment) => {
      if (appointment.status === "completed") {
        return [{ id: `apt-completed-${appointment.id}`, at: appointment.updated_at, icon: CalendarCheck2, label: "Appointment completed", detail: appointment.title }];
      }
      if (appointment.status === "no_show") {
        return [{ id: `apt-noshow-${appointment.id}`, at: appointment.updated_at, icon: CalendarX2, label: "Missed appointment", detail: appointment.title }];
      }
      if (appointment.status === "cancelled") {
        return [{ id: `apt-cancelled-${appointment.id}`, at: appointment.updated_at, icon: Ban, label: "Appointment cancelled", detail: appointment.title }];
      }
      return [];
    }),

    // Review/referral requests are keyed by job_id, not contact_id directly -
    // the caller filters to this person's own completed jobs' requests
    // before passing them in, the same "caller filters, this function only
    // merges" contract every other array parameter here already follows.
    ...reviewRequests.flatMap((request) => {
      const events: TimelineEvent[] = [];
      if (request.requested_at) events.push({ id: `review-requested-${request.id}`, at: request.requested_at, icon: Star, label: "Review requested", detail: undefined });
      if (request.resolved_at && (request.status === "completed" || request.status === "declined")) {
        events.push({
          id: `review-resolved-${request.id}`,
          at: request.resolved_at,
          icon: Star,
          label: request.status === "completed" ? "Review received" : "Review declined",
          detail: undefined,
        });
      }
      return events;
    }),

    ...referralRequests.flatMap((request) => {
      const events: TimelineEvent[] = [];
      if (request.requested_at) events.push({ id: `referral-requested-${request.id}`, at: request.requested_at, icon: Share2, label: "Referral requested", detail: undefined });
      if (request.resolved_at && (request.status === "converted" || request.status === "declined")) {
        events.push({
          id: `referral-resolved-${request.id}`,
          at: request.resolved_at,
          icon: Share2,
          label: request.status === "converted" ? "Referral converted" : "Referral declined",
          detail: undefined,
        });
      }
      return events;
    }),

    ...messages.map((message) => ({
      id: `msg-${message.id}`,
      at: message.created_at,
      icon: message.direction === "inbound" ? MessageCircle : Send,
      label: messageTimelineLabel(message),
      detail: truncate(message.body),
    })),
  ];

  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/**
 * Phase 3 (W1): a message's timeline label says what actually happened. Only a
 * sent / delivered outbound message "was sent"; a failed or undelivered one
 * failed, a queued one is still sending, and a logged entry is an internal
 * note that never reached the customer.
 */
export function messageTimelineLabel(message: { direction: string; status: string | null; sender_type: string; provider_message_id?: string | null }): string {
  if (message.direction === "inbound") return "Customer replied";
  // A test-environment simulated send: recorded, never sent (lib/messaging/simulated-delivery.ts).
  if (message.status === "logged" && isSimulatedMessage({ provider_message_id: message.provider_message_id })) return "Simulated text (not sent)";
  if (message.status === "logged") return "Note added";
  const who = message.sender_type === "ai" ? "Automated follow-up" : message.sender_type === "system" ? "System message" : "Your message";
  if (message.status === "failed" || message.status === "undelivered") return `${who} failed to send`;
  if (message.status === "queued") return `${who} sending`;
  return message.sender_type === "ai" ? "Automated follow-up sent" : message.sender_type === "system" ? "System message sent" : "You sent a message";
}

export type TimelineTimestamp = {
  /** The stored value, for <time dateTime>. */
  iso: string;
  /** e.g. "Oct 9, 2026" in the organization's timezone. */
  date: string;
  /** e.g. "3:05 PM" in the organization's timezone. */
  time: string;
  /** e.g. "2 hours ago" - only within the last week, where it helps; null otherwise. */
  relative: string | null;
};

const RELATIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Final Batch 3: when a timeline event happened, from the event's own stored
 * timestamp - formatted, never altered or estimated. An unreadable stored
 * value yields null, so the UI shows no date rather than a made-up one.
 * Date and time are in the organization's timezone (UTC when unknown); a
 * relative phrase is added only for the last 7 days.
 */
export function formatTimelineTimestamp(at: string | null | undefined, timeZone: string | undefined, now: number = Date.now()): TimelineTimestamp | null {
  if (!at) return null;
  const ms = new Date(at).getTime();
  if (!Number.isFinite(ms)) return null;
  const zone = (() => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "UTC" }).format(0);
      return timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })();
  const date = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", year: "numeric" }).format(ms);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(ms);
  const age = now - ms;
  let relative: string | null = null;
  if (age >= 0 && age < RELATIVE_WINDOW_MS) {
    const minutes = Math.floor(age / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    relative = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : hours < 24 ? `${hours} hr ago` : days === 1 ? "yesterday" : `${days} days ago`;
  }
  return { iso: at, date, time, relative };
}
