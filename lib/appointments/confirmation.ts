import type { AppointmentStatus } from "./queries";

/**
 * Pass 5B, Part A5: the appointment-mutation invalidation rule, extracted as
 * a pure function so both call sites that can change an appointment's time -
 * app/(app)/appointments/actions.ts's applyAppointmentUpdate (the full edit
 * form + the calendar's compact reschedule action) and
 * lib/scheduling/booking.ts's rescheduleAppointment (the AI/SMS-driven
 * reschedule) - apply the exact same rule rather than two independently
 * maintained copies.
 *
 * The rule: a confirmation is a statement about a SPECIFIC time. The moment
 * that time changes, any prior confirmation (and any outstanding
 * confirmation request, which was worded around the old time) must not
 * silently carry over onto the new one - otherwise the appointment would
 * read as "the customer confirmed" a time they never saw. Concretely: null
 * out confirmed_at/confirmation_requested_at, and if the appointment was
 * 'confirmed', revert it to 'scheduled' so it correctly re-enters the
 * awaiting-confirmation state and gets a fresh reminder+confirmation ask at
 * the new time.
 *
 * Deliberately does nothing for cancel/complete/no_show - those transitions
 * don't have a "new time" a stale confirmation could misleadingly apply to,
 * and every place that displays confirmation state already gates on
 * status === 'scheduled' first, so a stale confirmed_at sitting under a
 * cancelled/completed/no_show status is never shown as meaningful.
 */
export type ConfirmationInvalidationFields = {
  confirmed_at: null;
  confirmation_requested_at: null;
  status?: "scheduled";
};

export function computeConfirmationInvalidationOnTimeChange(previousStatus: AppointmentStatus, timeChanged: boolean): ConfirmationInvalidationFields | Record<string, never> {
  if (!timeChanged) return {};
  return previousStatus === "confirmed" ? { confirmed_at: null, confirmation_requested_at: null, status: "scheduled" } : { confirmed_at: null, confirmation_requested_at: null };
}
