import type { BusinessMetricsSnapshot, PeriodComparison, UnavailableComparison } from "@/lib/bi/types";

/**
 * Local formatting helpers for the BusinessMetricsSnapshot fields this page
 * reads. lib/dashboard/format.ts only exports formatCurrency/formatRelativeTime
 * (reused directly where needed, e.g. currency values below) - formatRate and
 * formatComparisonBadge themselves are defined locally in
 * app/(app)/dashboard/_components/key-metrics.tsx, not exported from a shared
 * module, so this mirrors that file's exact same null-safe semantics and
 * wording ("Not enough data yet" / "vs previous period") rather than
 * importing across a route group or inventing different copy for the same
 * concept.
 */
export function formatRate(rate: number | null): string {
  if (rate === null) return "Not enough data yet";
  return `${Math.round(rate)}%`;
}

/**
 * Pass 5C, Batch 3B: formats a millisecond duration (leadStageFunnel.timing/
 * responseTime figures) as a short, human string - "under a minute" / "4m" /
 * "6h" / "3d". Null-safe like formatRate, using the identical "Not enough
 * data yet" wording for the same reason (no fabricated 0 for an unmeasured
 * duration). Rounds to the coarsest single unit rather than a compound
 * "1d 4h 12m" - this page's own stat strips are single short values, not a
 * duration-breakdown widget.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "Not enough data yet";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export function formatComparisonBadge(comparison: PeriodComparison | UnavailableComparison): string | null {
  if (comparison.previous === null) return null;

  if (comparison.percentageChange === null) {
    if (comparison.change === null || comparison.change === 0) return null;
    const sign = comparison.change > 0 ? "+" : "";
    return `${sign}${comparison.change} vs previous period`;
  }

  const rounded = Math.round(comparison.percentageChange);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}% vs previous period`;
}

/**
 * The owner-facing version of snapshot.dataQuality.notes for the Analytics
 * calculations footer - the same facts, built from the snapshot's own flags
 * and counts, in plain business language. The source notes stay as they are
 * (the AI observations prompt and agency cost-readiness read them); they
 * name internal fields and providers, so the page never renders them raw.
 */
export function ownerDataNotes(snapshot: Pick<BusinessMetricsSnapshot, "dataQuality" | "leadStageFunnel" | "aiMetrics"> & Partial<Pick<BusinessMetricsSnapshot, "funnelUnavailable">>): string[] {
  const { dataQuality, leadStageFunnel, aiMetrics, funnelUnavailable } = snapshot;
  const { leadsWithRecordedHistory, leadsInRange } = leadStageFunnel.timing;
  return [
    dataQuality.collectedRevenueUnavailable
      ? "Your invoice and payment records couldn't be read for this period, so payment figures show as unavailable rather than zero. Open lead value, estimate value and contracted job value are quoted or contracted amounts, never money received."
      : "Only Collected is money received. Open lead value, estimate value, contracted job value and Invoiced are quoted, contracted or billed amounts.",
    "Lead source is typed by hand and not standardized, so sources are shown for visibility only, never ranked by performance.",
    funnelUnavailable?.stageTransitions || funnelUnavailable?.stageTiming
      ? "Lead stage history couldn't be read for this period, so stage changes and timing show as unavailable rather than zero."
      : dataQuality.stageHistoryUnavailable
      ? "No lead stage changes were recorded in this period, so stage timing isn't available yet."
      : `Stage timing only covers leads whose stage changes were recorded: ${leadsWithRecordedHistory} of ${leadsInRange} ${leadsInRange === 1 ? "lead" : "leads"} in this period. Treat the averages as a sample, not every lead.`,
    dataQuality.aiTokenUsageUnavailable
      ? "None of this period's AI work reported usage details."
      : `Usage details were reported for ${aiMetrics.interactionsWithUsageData} of ${aiMetrics.aiInteractions} AI ${aiMetrics.aiInteractions === 1 ? "interaction" : "interactions"} in this period.`,
  ];
}
