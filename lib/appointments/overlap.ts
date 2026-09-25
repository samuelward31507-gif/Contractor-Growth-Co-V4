import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Production-readiness audit finding (HIGH): double-booking was previously
 * completely unprevented - two appointments could be created with
 * overlapping start_at/end_at for this organization with zero warning, no
 * DB constraint, no application check. appointments has no assignee/
 * technician column, so this organization does not (yet) support per-tech
 * scheduling - overlap is therefore checked organization-wide, matching the
 * only granularity the schema actually supports today. Only
 * scheduled/confirmed/completed appointments occupy a slot: a cancelled
 * appointment never happened (slot is free), and a no-show means the
 * customer didn't arrive (the contractor's time is free to rebook).
 *
 * Extracted into its own module (rather than living inline in the "use
 * server" app/(app)/appointments/actions.ts) so it is directly unit/
 * integration testable under plain node:test, matching this codebase's own
 * established convention for pure/security-relevant logic used by a server
 * action (see lib/automation/retry.ts's planRetryAudit).
 */
export async function checkAppointmentOverlap(
  supabase: SupabaseClient,
  organizationId: string,
  input: { start_at: string; end_at: string },
  excludeId?: string,
): Promise<boolean> {
  let query = supabase
    .from("appointments")
    .select("id")
    .eq("organization_id", organizationId)
    .in("status", ["scheduled", "confirmed", "completed"])
    .lt("start_at", input.end_at)
    .gt("end_at", input.start_at)
    .limit(1);

  if (excludeId) {
    query = query.neq("id", excludeId);
  }

  const { data } = await query.maybeSingle();
  return Boolean(data);
}

/**
 * Pass 2 (Native Calendar System): the same range-overlap predicate as
 * checkAppointmentOverlap above, applied to blocked_time instead of
 * appointments - the manual create/edit path's own pre-check that a new or
 * rescheduled appointment does not land inside a blocked period. This is a
 * fast, friendly UX pre-check only; blocked_time carries no database-level
 * exclusion constraint of its own (see the blocked_time migration's own
 * comment for why), so this - together with the AI/SMS path's identical
 * enforcement inside lib/scheduling/availability.ts's getAvailableSlots -
 * is the actual, sufficient safeguard for a schema that, by design, never
 * lets blocked_time and appointments race against each other at the
 * database level the way two appointments can.
 */
export async function checkBlockedTimeOverlap(
  supabase: SupabaseClient,
  organizationId: string,
  input: { start_at: string; end_at: string },
): Promise<boolean> {
  const { data } = await supabase
    .from("blocked_time")
    .select("id")
    .eq("organization_id", organizationId)
    .lt("start_at", input.end_at)
    .gt("end_at", input.start_at)
    .limit(1)
    .maybeSingle();

  return Boolean(data);
}
