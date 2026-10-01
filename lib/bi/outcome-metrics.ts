import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "./revenue-attribution";
import type { ResolvedDateRange } from "./types";

/**
 * Phase 2D (Analytics only): the outcome-dated versions of three Analytics
 * figures that the shared snapshot dates by creation. Not part of
 * BusinessMetricsSnapshot, so Agency, Today and the AI observations keep
 * their own (creation-dated) semantics unchanged.
 *
 * Every figure uses the organization-calendar range the page already
 * resolves (Phase 2A):
 *   - Completed jobs / completed job value: jobs with status completed and
 *     jobs.completed_at in the period, summing jobs.amount (the contracted
 *     amount, never collected payments). Exactly the filters Revenue by
 *     source's completed read uses, so the headline equals that table's
 *     completed-value total.
 *   - Estimate acceptance: accepted vs. accepted + declined estimates, by
 *     estimates.responded_at (when the customer said yes or no).
 *   - Lead → booking: of the leads created in the period, those with at
 *     least one appointment that wasn't cancelled and wasn't a no-show,
 *     whenever booked.
 * "All time" applies no date filter, so a completed job or a decided
 * estimate missing its outcome date is still counted there.
 *
 * Query strategy: head-only counts for the estimate and lead figures (the
 * lead → booking count is a server-side inner join, no ID lists), and the
 * Phase 2C pager for the completed-job amounts - no .in() lists, no silent
 * cap; past the ceiling the read reports failed.
 */

export type OutcomeMetrics = {
  completedJobs: number;
  completedJobValue: number;
  acceptedEstimates: number;
  declinedEstimates: number;
  /** accepted / (accepted + declined) as a percentage; null when none were decided. */
  estimateAcceptanceRate: number | null;
  leadsInRange: number;
  leadsWithActiveBooking: number;
  /** leadsWithActiveBooking / leadsInRange as a percentage; null with no leads. */
  leadToBookingRate: number | null;
};

/** Appointment outcomes that never count as a booking. */
export const NOT_A_BOOKING_STATUSES = ["cancelled", "no_show"] as const;

const percent = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : (numerator / denominator) * 100);
const amountOf = (amount: number | string | null): number => {
  const value = amount === null ? 0 : Number(amount);
  return Number.isFinite(value) ? value : 0;
};

/** Pure: the outcome figures from the reads' counts and completed-job amounts. */
export function summarizeOutcomeMetrics(input: {
  completedJobAmounts: (number | string | null)[];
  acceptedEstimates: number;
  declinedEstimates: number;
  leadsInRange: number;
  leadsWithActiveBooking: number;
}): OutcomeMetrics {
  return {
    completedJobs: input.completedJobAmounts.length,
    completedJobValue: input.completedJobAmounts.reduce<number>((sum, amount) => sum + amountOf(amount), 0),
    acceptedEstimates: input.acceptedEstimates,
    declinedEstimates: input.declinedEstimates,
    estimateAcceptanceRate: percent(input.acceptedEstimates, input.acceptedEstimates + input.declinedEstimates),
    leadsInRange: input.leadsInRange,
    leadsWithActiveBooking: input.leadsWithActiveBooking,
    leadToBookingRate: percent(input.leadsWithActiveBooking, input.leadsInRange),
  };
}

export async function getOutcomeMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<OutcomeMetrics & { failed: boolean }> {
  const inRange = <Q extends { gte: (column: string, value: string) => Q; lt: (column: string, value: string) => Q }>(query: Q, column: string): Q => {
    let scoped = query;
    if (range.from) scoped = scoped.gte(column, range.from);
    if (range.to) scoped = scoped.lt(column, range.to);
    return scoped;
  };

  const [completed, accepted, declined, leads, booked] = await Promise.all([
    readAllPages<{ amount: number | string | null }>(() => inRange(supabase.from("jobs").select("amount").eq("organization_id", organizationId).eq("status", "completed"), "completed_at").order("id")),
    inRange(supabase.from("estimates").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "accepted"), "responded_at"),
    inRange(supabase.from("estimates").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "declined"), "responded_at"),
    inRange(supabase.from("leads").select("id", { count: "exact", head: true }).eq("organization_id", organizationId), "created_at"),
    inRange(
      supabase
        .from("leads")
        .select("id, appointments!appointments_lead_id_fkey!inner(id)", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .not("appointments.status", "in", `(${NOT_A_BOOKING_STATUSES.join(",")})`),
      "created_at",
    ),
  ]);

  return {
    ...summarizeOutcomeMetrics({
      completedJobAmounts: completed.rows.map((row) => row.amount),
      acceptedEstimates: accepted.count ?? 0,
      declinedEstimates: declined.count ?? 0,
      leadsInRange: leads.count ?? 0,
      leadsWithActiveBooking: booked.count ?? 0,
    }),
    failed: completed.failed || accepted.error != null || declined.error != null || leads.error != null || booked.error != null,
  };
}
