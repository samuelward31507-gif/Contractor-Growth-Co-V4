import type { PeriodComparison } from "@/lib/bi/types";

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

export function formatComparisonBadge(comparison: PeriodComparison): string | null {
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
