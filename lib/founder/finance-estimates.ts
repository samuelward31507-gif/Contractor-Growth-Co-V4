import type { SupabaseClient } from "@supabase/supabase-js";
import { getAgencyAiCosts, getAgencySmsCosts, type CostCurrencyAmount } from "@/lib/agency/costs";

/**
 * AI and SMS cost ESTIMATES for the founder finance overview - shown beside,
 * never inside, actual expenses (Gate A decision 8: AI cost is excluded from
 * the founder's expense figures).
 *
 * There is no founder-level read for these: ai_cost_events and
 * sms_cost_events are readable by agency admins only (RLS: is_agency_admin()).
 * So this reuses the existing Agency cost reads exactly as /agency/costs
 * does - they re-check agency-admin access themselves - and keeps only the
 * agency-wide totals: no per-client rows leave this function. A founder who
 * isn't also an agency admin gets "unavailable"; nothing is widened to make
 * the figure appear.
 */

export type CostEstimates =
  | { status: "available"; ai: { known: CostCurrencyAmount[]; unpriced: number; unknown: number }; sms: { known: CostCurrencyAmount[]; unknown: number }; partial: boolean }
  | { status: "no_agency_access" }
  | { status: "error" };

export async function getCostEstimates(sessionSupabase: SupabaseClient, serviceSupabase: SupabaseClient, range: { from: string; to: string }): Promise<CostEstimates> {
  try {
    const [ai, sms] = await Promise.all([getAgencyAiCosts(sessionSupabase, serviceSupabase, range), getAgencySmsCosts(sessionSupabase, serviceSupabase, range)]);
    if (!ai.ok || !sms.ok) return { status: "no_agency_access" };
    return {
      status: "available",
      ai: { known: ai.totals.knownCost, unpriced: ai.totals.unpricedInteractionCount, unknown: ai.totals.unknownInteractionCount },
      sms: { known: sms.totals.knownCost, unknown: sms.totals.unknownMessageCount },
      partial: ai.partialData || sms.partialData,
    };
  } catch {
    return { status: "error" };
  }
}
