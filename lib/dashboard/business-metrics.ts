import type { SupabaseClient } from "@supabase/supabase-js";
import { buildAiMetrics, getBusinessMetricsSnapshot } from "@/lib/bi/metrics";
import { getLeadAndPipelineMetrics, resolveDateRange } from "@/lib/bi/queries";
import type { BiAiMetrics, BusinessMetricsSnapshot } from "@/lib/bi/types";
import { INSIGHT_TYPES, INSIGHT_SEVERITIES, INSIGHT_CONFIDENCES, type BusinessInsightsReport } from "@/lib/bi/insights";

/**
 * Phase 5.4 - the dashboard's own thin adapter over the frozen Phase 5.1/5.2/
 * 5.3 BI layers. This file does not calculate anything itself - it only
 * picks a default period for the dashboard and reads the most recently
 * persisted AI insight (never generating a new one on a plain page render -
 * see getCachedBusinessInsights below and the Server Action in
 * app/(app)/dashboard/actions.ts for the only place a new one is ever
 * requested).
 *
 * lib/dashboard/queries.ts (getDashboardData) is untouched by this phase -
 * its existing overview/pipeline/attention/activity calculations keep their
 * exact current semantics. This file adds a NEW, separate data source
 * rather than editing the old one.
 *
 * Trackpr 2.0, Phase 4C (P2 #9): the "pendingEstimates is lead-status-based,
 * not estimates-table-based" discrepancy this comment used to describe was
 * already stale by the time of that audit (getDashboardData's own
 * OverviewMetrics.pendingEstimates was already estimates-table-based via
 * distinctLeadIdsWithPendingEstimate, just still deduplicated by lead) - the
 * real, verified discrepancy was a unit mismatch against Analytics'
 * BiEstimateMetrics.sentEstimates (distinct leads vs. estimate rows), now
 * fixed directly in lib/dashboard/queries.ts's own OverviewMetrics
 * computation - see that file's own comment at the fix site.
 */

/** A simple, sensible default - "how are things going lately." Phase 5.2 already supports this preset; no new date-range system is introduced. */
export const DASHBOARD_DEFAULT_RANGE = "last30Days" as const;

/** How long a persisted insight is shown without prompting for a refresh. Purely a display decision - it does not affect what was already persisted. */
const INSIGHTS_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export async function getDashboardBusinessMetrics(supabase: SupabaseClient, organizationId: string): Promise<BusinessMetricsSnapshot> {
  return getBusinessMetricsSnapshot(supabase, organizationId, DASHBOARD_DEFAULT_RANGE);
}

/**
 * Phase 2A-1: the Dashboard renders exactly two things from business
 * metrics - the pipeline value (last 30 days, the same range
 * getDashboardBusinessMetrics uses) and the "What AI handled" panel (today's
 * AI metrics) - so it now computes just those, with the very helpers
 * getBusinessMetricsSnapshot itself uses for them, instead of two whole
 * snapshots (~58 queries) whose other figures were never shown.
 *
 * Same definitions, same ranges, same numbers: getBusinessMetricsSnapshot's
 * pipelineMetrics.pipelineValue is getLeadAndPipelineMetrics(range)'s
 * pipeline.pipelineValue, and its aiMetrics is buildAiMetrics(range).metrics
 * (parity pinned by lib/dashboard/business-metrics.parity.test.ts).
 *
 * `failed` is each read's own failure flag - the same per-read flags the
 * snapshot's partialData is built from - so the Dashboard's partial-data
 * notice now reflects the reads behind the values it actually shows.
 */
export async function getDashboardPipelineValue(supabase: SupabaseClient, organizationId: string): Promise<{ pipelineValue: number; failed: boolean }> {
  const { pipeline, failed } = await getLeadAndPipelineMetrics(supabase, organizationId, resolveDateRange(DASHBOARD_DEFAULT_RANGE));
  return { pipelineValue: pipeline.pipelineValue, failed };
}

/** Today's AI metrics for the Dashboard's "What AI handled" panel - see getDashboardPipelineValue above. */
export async function getDashboardAiHandled(supabase: SupabaseClient, organizationId: string): Promise<{ aiMetrics: BiAiMetrics; failed: boolean }> {
  const { metrics, failed } = await buildAiMetrics(supabase, organizationId, resolveDateRange("today"));
  return { aiMetrics: metrics, failed };
}

export type CachedBusinessInsights = {
  report: BusinessInsightsReport;
  generatedAt: string;
  isFresh: boolean;
};

/**
 * A lightweight shape guard for data read back out of ai_interactions.output
 * - NOT a re-run of Phase 5.3's full validateInsightsReport (that function
 * additionally re-checks every number against the ORIGINAL generation-time
 * input, which this read path doesn't have on hand, and re-running it here
 * would risk rejecting a genuinely valid past insight just because today's
 * metrics have since changed). This only protects the dashboard's render
 * path from a malformed/legacy row - it can never make a report "more
 * valid" than Phase 5.3's own validation already made it at persist time.
 */
function isDisplayableReport(value: unknown): value is BusinessInsightsReport {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string") return false;
  if (!Array.isArray(record.insights)) return false;
  if (!Array.isArray(record.dataLimitations)) return false;

  return record.insights.every((insight) => {
    if (typeof insight !== "object" || insight === null) return false;
    const i = insight as Record<string, unknown>;
    return (
      typeof i.type === "string" &&
      (INSIGHT_TYPES as readonly string[]).includes(i.type) &&
      typeof i.title === "string" &&
      typeof i.description === "string" &&
      Array.isArray(i.evidence) &&
      typeof i.severity === "string" &&
      (INSIGHT_SEVERITIES as readonly string[]).includes(i.severity) &&
      typeof i.confidence === "string" &&
      (INSIGHT_CONFIDENCES as readonly string[]).includes(i.confidence)
    );
  });
}

/**
 * Reads the most recently persisted business_insights ai_interactions row
 * for this organization, if any - never calls Claude, never generates a new
 * one. This is the ONLY way the dashboard's ordinary render path surfaces AI
 * insights, so a plain page load/refresh never triggers a paid API call
 * (see the "AI refresh / cost control" section of the Phase 5.4 report).
 * Returns null on any error, missing row, or malformed data - the dashboard
 * must render fully either way.
 */
export async function getCachedBusinessInsights(supabase: SupabaseClient, organizationId: string): Promise<CachedBusinessInsights | null> {
  const { data, error } = await supabase
    .from("ai_interactions")
    .select("output, created_at")
    .eq("organization_id", organizationId)
    .eq("interaction_type", "business_insights")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data || !isDisplayableReport(data.output)) return null;

  const ageMs = Date.now() - new Date(data.created_at).getTime();
  return {
    report: data.output,
    generatedAt: data.created_at,
    isFresh: ageMs < INSIGHTS_FRESHNESS_MS,
  };
}
