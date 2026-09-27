import type { BadgeTone } from "@/lib/ui/badge";
import type { Lead } from "@/lib/leads/queries";
import type { Estimate } from "@/lib/estimates/queries";
import type { Job } from "@/lib/jobs/queries";
import type { Appointment } from "@/lib/appointments/queries";
import type { ReviewRequest } from "@/lib/reviews-referrals/queries";

/**
 * Usability audit fix (#2, Customers lifecycle signal): the Customers list
 * had no status indicator at all - a brand-new lead and a repeat customer
 * rendered identically. This derives one lifecycle badge per contact from
 * signals every other page already computes (lead/estimate/job/appointment
 * status, review-request status) - no new schema field, no new database
 * lifecycle column, no new business rule. Mirrors the existing
 * LEAD_STATUS_TONE/JOB_STATUS_TONE/ESTIMATE_STATUS_TONE convention
 * (lib/leads/.../lead-status.ts, lib/jobs/.../status.ts,
 * lib/estimates/.../status.ts) rather than inventing a second tone system.
 */
export type ContactLifecycleStage =
  | "new"
  | "needs_follow_up"
  | "appointment_set"
  | "estimate_sent"
  | "active_job"
  | "completed"
  | "review_requested"
  | "lost";

export const CONTACT_LIFECYCLE_LABEL: Record<ContactLifecycleStage, string> = {
  new: "New",
  needs_follow_up: "Needs follow-up",
  appointment_set: "Appointment set",
  estimate_sent: "Estimate sent",
  active_job: "Active job",
  completed: "Completed",
  review_requested: "Review requested",
  lost: "Lost",
};

/** Reuses the shared Badge tone set exactly (lib/ui/badge.tsx) - danger for the one state that means "you're dropping the ball," success for live paid work, warning for a time-sensitive customer decision, info for a booked-but-not-yet-quoted state, neutral for the three "nothing to do right now" states (new/completed/lost). */
export const CONTACT_LIFECYCLE_TONE: Record<ContactLifecycleStage, BadgeTone> = {
  new: "neutral",
  needs_follow_up: "danger",
  appointment_set: "info",
  estimate_sent: "warning",
  active_job: "success",
  completed: "neutral",
  review_requested: "info",
  lost: "neutral",
};

const ACTIVE_JOB_STATUSES = new Set<Job["status"]>(["scheduled", "in_progress"]);
const ACTIVE_APPOINTMENT_STATUSES = new Set<Appointment["status"]>(["scheduled", "confirmed"]);
const FOLLOW_UP_LEAD_STATUSES = new Set<Lead["status"]>(["contacted", "qualified"]);
const RESOLVABLE_REVIEW_STATUSES = new Set<ReviewRequest["status"]>(["requested", "responded"]);

export type ContactLifecycleSignals = {
  leads: Pick<Lead, "contact_id" | "status">[];
  estimates: Pick<Estimate, "contact_id" | "status">[];
  jobs: Pick<Job, "id" | "contact_id" | "status">[];
  appointments: Pick<Appointment, "contact_id" | "status">[];
  reviewRequests: Pick<ReviewRequest, "job_id" | "status">[];
};

/**
 * Checked in priority order, most-active/most-urgent first, over the
 * contact's FULL history - a repeat customer can have an old lost lead and a
 * brand-new active job at once; the more current signal wins. Every array in
 * `signals` is the org's full, already-fetched list (the same "join over
 * already-fetched data" pattern used throughout this codebase - see
 * lib/jobs/page.tsx's own review/referral join) - this function does no
 * fetching of its own.
 */
export function deriveContactLifecycle(contactId: string, signals: ContactLifecycleSignals): ContactLifecycleStage {
  const jobs = signals.jobs.filter((job) => job.contact_id === contactId);
  const estimates = signals.estimates.filter((estimate) => estimate.contact_id === contactId);
  const appointments = signals.appointments.filter((appointment) => appointment.contact_id === contactId);
  const leads = signals.leads.filter((lead) => lead.contact_id === contactId);

  if (jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status))) return "active_job";

  const completedJobIds = new Set(jobs.filter((job) => job.status === "completed").map((job) => job.id));
  const hasResolvableReview = signals.reviewRequests.some(
    (request) => completedJobIds.has(request.job_id) && RESOLVABLE_REVIEW_STATUSES.has(request.status),
  );
  if (hasResolvableReview) return "review_requested";

  if (estimates.some((estimate) => estimate.status === "sent")) return "estimate_sent";

  if (appointments.some((appointment) => ACTIVE_APPOINTMENT_STATUSES.has(appointment.status))) return "appointment_set";

  if (leads.some((lead) => FOLLOW_UP_LEAD_STATUSES.has(lead.status))) return "needs_follow_up";

  if (completedJobIds.size > 0) return "completed";

  if (leads.some((lead) => lead.status === "lost")) return "lost";

  return "new";
}
