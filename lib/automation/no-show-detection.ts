import type { SupabaseClient } from "@supabase/supabase-js";
import { emitAppointmentNoShowAsService } from "./appointments";
import type { AppointmentStatus } from "@/lib/appointments/queries";

/**
 * Pass 5B, Part B: automated no-show detection. The Pass 5 audit's own
 * finding was that a no-show status transition was always a manual
 * contractor click - this closes that gap with a deterministic, scheduled
 * scan, reusing the EXISTING no-show follow-up machinery
 * (emitAppointmentNoShowAsService, unchanged) rather than building a second
 * one. No AI anywhere in this file, per that pass's own explicit "no AI
 * required for status transitions" rule.
 */

const ELIGIBLE_STATUSES: AppointmentStatus[] = ["scheduled", "confirmed"];

/**
 * Part B3: the grace period basis. `end_at` (not `start_at` + a guessed
 * duration) is the authoritative basis this codebase already has - it
 * already encodes each appointment's own real, per-service duration
 * (end_at - start_at), so no-show eligibility is anchored to when the
 * SCHEDULED WORK was expected to be done, not just when it started. No
 * existing configuration (business hours, reminder lead time, service
 * duration itself) provides a ready-made "how late is too late" number, so
 * this is a deliberately conservative, documented, centrally-defined
 * default rather than an invented magic number scattered inline: 60 minutes
 * past the scheduled end time gives a contractor a full hour to either mark
 * the job complete or simply be running behind, before the system concludes
 * the customer never showed. Tune this once real usage data suggests a
 * better value; there is no existing precedent in this codebase to derive
 * it from more precisely today.
 *
 * TIMEZONE CORRECTNESS (Part B2): this is pure epoch/instant arithmetic on
 * `end_at`, which is already an absolute timestamptz - it deliberately never
 * parses a wall-clock string or consults the organization's timezone at
 * all. A duration-based comparison on two already-absolute instants is
 * immune to DST/timezone effects by construction; timezone only matters for
 * DISPLAYING a date (see lib/appointments/format.ts), never for this
 * eligibility decision. This is the same reason lib/automation/
 * appointment-reminders.ts's own isReminderDue never touches a timezone
 * either.
 */
export const NO_SHOW_GRACE_PERIOD_MS = 60 * 60 * 1000;

/**
 * Pure eligibility check, extracted for direct unit testing - mirrors
 * isReminderDue's own established shape in appointment-reminders.ts.
 */
export function isNoShowEligible(appointment: { end_at: string }, now: Date = new Date()): boolean {
  return now.getTime() - new Date(appointment.end_at).getTime() > NO_SHOW_GRACE_PERIOD_MS;
}

type CandidateAppointment = { id: string; organization_id: string; end_at: string };

export type NoShowDetectionOutcome =
  | { appointmentId: string; outcome: "marked_no_show" }
  | { appointmentId: string; outcome: "already_transitioned" };

export type NoShowDetectionResult = { candidates: number; outcomes: NoShowDetectionOutcome[] };

const MAX_CANDIDATE_ROWS = 200;

/**
 * Finds every organization's eligible past-due appointments in one bounded,
 * indexed, cross-org scan (idx_appointments_noshow_scan - see this pass's
 * own migration) and, for each one, atomically transitions it to no_show -
 * designed to be called repeatedly on a schedule (see
 * app/api/automation/no-show-detection/route.ts), matching every other
 * scheduled automation in this codebase (appointment-reminders.ts,
 * customer-reactivation.ts) exactly: every step here is idempotent/
 * race-safe, so calling this twice in the same window is always safe.
 */
export async function processNoShowDetection(supabase: SupabaseClient, now: Date = new Date()): Promise<NoShowDetectionResult> {
  const cutoff = new Date(now.getTime() - NO_SHOW_GRACE_PERIOD_MS).toISOString();

  const { data: rawCandidates } = await supabase
    .from("appointments")
    .select("id, organization_id, end_at")
    .in("status", ELIGIBLE_STATUSES)
    .lt("end_at", cutoff)
    .order("end_at", { ascending: true })
    .limit(MAX_CANDIDATE_ROWS);

  const candidates = (rawCandidates ?? []) as CandidateAppointment[];
  const outcomes: NoShowDetectionOutcome[] = [];

  for (const appointment of candidates) {
    outcomes.push(await processOneAppointment(supabase, appointment));
  }

  return { candidates: candidates.length, outcomes };
}

/**
 * Part B5 (atomicity/race safety): the conditional UPDATE itself is the
 * entire guarantee - `.eq("status", ...)` re-checked against
 * ELIGIBLE_STATUSES at write time, not merely at the SELECT above. If a
 * contractor concurrently marked this appointment completed/cancelled (or
 * another scan tick already caught it) between the SELECT and this UPDATE,
 * the WHERE clause matches zero rows and this is a safe, silent no-op -
 * exactly the same "the conditional UPDATE is the idempotency guard"
 * pattern cancelAppointmentAsService/confirmAppointmentAsService already
 * establish (lib/automation/appointments.ts). Only one terminal outcome can
 * ever win; there is no read-decide-write gap for a race to land in.
 */
async function processOneAppointment(supabase: SupabaseClient, appointment: CandidateAppointment): Promise<NoShowDetectionOutcome> {
  const { data: updated, error } = await supabase
    .from("appointments")
    .update({ status: "no_show" })
    .eq("id", appointment.id)
    .eq("organization_id", appointment.organization_id)
    .in("status", ELIGIBLE_STATUSES)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[automation] failed to mark appointment no_show", { appointmentId: appointment.id, error: error.message });
    return { appointmentId: appointment.id, outcome: "already_transitioned" };
  }
  if (!updated) {
    return { appointmentId: appointment.id, outcome: "already_transitioned" };
  }

  // Reuses the EXISTING no-show follow-up machinery unchanged (Part C) -
  // this scan's only job is the deterministic status transition; everything
  // downstream (the n8n-dispatched reschedule invitation, the outbound
  // safety gate, the no_show opportunity detector) is already built and
  // already correct, whether a human clicked "No-show" or this scan did.
  await emitAppointmentNoShowAsService(supabase, appointment.organization_id, appointment.id);

  return { appointmentId: appointment.id, outcome: "marked_no_show" };
}
