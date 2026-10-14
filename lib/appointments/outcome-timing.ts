import type { AppointmentStatus } from "./queries";

/**
 * QA: an appointment's outcome (completed / no-show) can only be recorded
 * once the appointment has started. Recording it days early (as happened on
 * TEST: two appointments marked completed 6 and 8 days before their
 * scheduled times) fires the completion automations, closes the visit in
 * every report and leaves a future slot on the calendar that will never
 * happen. If the visit really took place at another time, the person
 * reschedules it to when it happened and then records the outcome - the
 * edit form accepts both in one save, judged against the new start time.
 *
 * Pure: returns an error message, or null when the change is allowed.
 * Statuses that are not outcomes (scheduled, confirmed, cancelled) and an
 * unchanged status are never refused.
 */
export const OUTCOME_STATUSES: readonly AppointmentStatus[] = ["completed", "no_show"];

export const PREMATURE_OUTCOME_ERROR = "This appointment hasn't started yet. If it already happened, change its date and time to when it took place, then mark it.";

export function checkAppointmentOutcomeTiming(input: { previousStatus: AppointmentStatus; nextStatus: AppointmentStatus; startAt: string; now: Date }): string | null {
  if (input.nextStatus === input.previousStatus) return null;
  if (!OUTCOME_STATUSES.includes(input.nextStatus)) return null;
  const start = new Date(input.startAt).getTime();
  if (Number.isNaN(start)) return PREMATURE_OUTCOME_ERROR;
  return start > input.now.getTime() ? PREMATURE_OUTCOME_ERROR : null;
}
