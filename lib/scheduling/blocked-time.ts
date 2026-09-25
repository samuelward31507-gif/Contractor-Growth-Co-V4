import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Pass 2 (Native Calendar System): the read layer for blocked_time (see
 * supabase/migrations/20260925010000_blocked_time.sql for the schema and
 * its own rationale). Mirrors lib/appointments/queries.ts's own shape -
 * a plain org-scoped, range-scoped SELECT, RLS already enforcing
 * organization isolation for a session client. Writes live in
 * app/(app)/calendar/actions.ts as "use server" Server Actions, the same
 * queries-vs-actions split this codebase already uses for appointments.
 */
export type BlockedTime = {
  id: string;
  start_at: string;
  end_at: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
};

export async function getBlockedTimeInRange(
  supabase: SupabaseClient,
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<BlockedTime[]> {
  const { data } = await supabase
    .from("blocked_time")
    .select("id, start_at, end_at, reason, created_at, updated_at")
    .eq("organization_id", organizationId)
    .lt("start_at", rangeEnd.toISOString())
    .gt("end_at", rangeStart.toISOString())
    .order("start_at", { ascending: true })
    .limit(1000);

  return (data ?? []) as BlockedTime[];
}

/** Scoped to the org, matching every other single-row lookup in this codebase - any error (invalid id, wrong org) resolves to null rather than throwing. */
export async function getBlockedTimeById(supabase: SupabaseClient, organizationId: string, id: string): Promise<BlockedTime | null> {
  const { data, error } = await supabase
    .from("blocked_time")
    .select("id, start_at, end_at, reason, created_at, updated_at")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return data as BlockedTime;
}
