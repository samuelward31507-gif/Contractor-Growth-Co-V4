import type { LeadStatus } from "@/lib/leads/queries";
import type { AppointmentStatus } from "@/lib/appointments/queries";
import type { EstimateStatus } from "@/lib/estimates/queries";
import type { JobStatus } from "@/lib/jobs/queries";
import type { InvoiceStatus } from "@/lib/invoices/domain";
import type { ReviewRequestStatus, ReferralRequestStatus } from "@/lib/reviews-referrals/queries";

/**
 * P0-B B1: the ONE place the canonical lifecycle model reads entity statuses
 * from. Every set is a copy of a definition the codebase already uses - the
 * source is named on each - so this module interprets the existing statuses
 * and never redefines them. The existing copies are deliberately NOT
 * rewired to import from here in B1 (no consumer changes);
 * lib/lifecycle/statuses.test.ts pins every set to its source so the two can
 * never silently drift apart.
 *
 * Every list is the full set of values the database CHECK allows (or a
 * subset of it), so anything else seen at runtime is "unrecognized" and is
 * reported, never guessed.
 */

export const LEAD_STATUS_VALUES: readonly LeadStatus[] = ["new", "contacted", "qualified", "appointment", "estimate", "won", "lost"];
/** lib/leads/queries.ts OPEN_LEAD_STATUSES. */
export const OPEN_LEAD_STATUS_VALUES: readonly LeadStatus[] = ["new", "contacted", "qualified", "appointment", "estimate"];

export const APPOINTMENT_STATUS_VALUES: readonly AppointmentStatus[] = ["scheduled", "confirmed", "completed", "cancelled", "no_show"];
/** Not yet happened (or not closed out): lib/automation/lifecycle-eligibility.ts ACTIVE_APPOINTMENT_STATUSES. */
export const ACTIVE_APPOINTMENT_STATUS_VALUES: readonly AppointmentStatus[] = ["scheduled", "confirmed"];
/** A visit that books a lead (cancelled and no_show never do): lib/opportunities/lifecycle.ts BOOKED_APPOINTMENT_STATUSES. */
export const BOOKED_APPOINTMENT_STATUS_VALUES: readonly AppointmentStatus[] = ["scheduled", "confirmed", "completed"];

export const ESTIMATE_STATUS_VALUES: readonly EstimateStatus[] = ["draft", "sent", "accepted", "declined", "cancelled", "expired"];
/** Awaiting the customer's decision: lib/automation/estimate-followups.ts ACTIVE_STATUSES. */
export const AWAITING_DECISION_ESTIMATE_STATUS_VALUES: readonly EstimateStatus[] = ["sent"];
/** The customer said no / it lapsed: never active again. */
export const CLOSED_ESTIMATE_STATUS_VALUES: readonly EstimateStatus[] = ["declined", "cancelled", "expired"];

export const JOB_STATUS_VALUES: readonly JobStatus[] = ["scheduled", "in_progress", "completed", "cancelled"];
/** lib/automation/lifecycle-eligibility.ts ACTIVE_JOB_STATUSES. */
export const ACTIVE_JOB_STATUS_VALUES: readonly JobStatus[] = ["scheduled", "in_progress"];

export const INVOICE_STATUS_VALUES: readonly InvoiceStatus[] = ["draft", "sent", "partially_paid", "paid", "void"];
/** Money still owed on a live invoice: lib/people/next-step.ts ("Issue invoice" / "Collect payment"). */
export const UNPAID_INVOICE_STATUS_VALUES: readonly InvoiceStatus[] = ["draft", "sent", "partially_paid"];

export const REVIEW_REQUEST_STATUS_VALUES: readonly ReviewRequestStatus[] = ["not_requested", "requested", "responded", "completed", "declined", "failed"];
/** An ask still open with the customer: lib/customers/lifecycle-stage.ts RESOLVABLE_REVIEW_STATUSES. */
export const OPEN_REVIEW_REQUEST_STATUS_VALUES: readonly ReviewRequestStatus[] = ["requested", "responded"];

export const REFERRAL_REQUEST_STATUS_VALUES: readonly ReferralRequestStatus[] = ["not_requested", "requested", "responded", "converted", "declined", "failed"];
/** Same meaning as the review set, for referrals. */
export const OPEN_REFERRAL_REQUEST_STATUS_VALUES: readonly ReferralRequestStatus[] = ["requested", "responded"];

/** Outbound messages that reached (or were logged by staff as reaching) the customer. queued, failed and undelivered never count as a response. */
export const RESPONDED_OUTBOUND_MESSAGE_STATUS_VALUES: readonly string[] = ["sent", "delivered", "logged"];

export function isKnown<T extends string>(values: readonly T[], status: string | null | undefined): status is T {
  return typeof status === "string" && (values as readonly string[]).includes(status);
}
