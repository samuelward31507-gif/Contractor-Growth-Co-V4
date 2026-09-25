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
