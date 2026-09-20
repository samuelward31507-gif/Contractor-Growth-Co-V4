import type { PeriodComparison } from "@/lib/bi/types";

/**
 * Formatting helpers for the "Last 30 days" figures shown in
 * business-glance.tsx (the dashboard's reference rail) - kept in this file,
 * not moved, since they were written and documented alongside the period-
 * comparison semantics they format.
 *
 * "Leads" (not "New Leads") is used deliberately: the only lead-related
 * period comparison (comparisons.leadCount) measures ALL leads created in
 * the period, not specifically leads currently in the "new" status -
 * labeling it "New Leads" while showing a total-leads-created comparison
 * would misrepresent what the number means. The dashboard's own "New leads"
 * figure (a current-state count, not a period comparison) covers that
 * separate meaning - see business-glance.tsx's "Right now" group.
 */

export function formatComparisonBadge(comparison: PeriodComparison): string | null {
  // No defined previous period (e.g. an open-ended range) - Phase 5.2
  // returns previous: null in that case; showing nothing is correct here,
  // never a fabricated comparison.
  if (comparison.previous === null) return null;

  if (comparison.percentageChange === null) {
    // previous was 0 - a percentage is undefined, not "0%" or "100%". Show
    // the raw count change instead, which is still a real, non-misleading
    // number.
    if (comparison.change === null || comparison.change === 0) return null;
    const sign = comparison.change > 0 ? "+" : "";
    return `${sign}${comparison.change} vs previous period`;
  }

  const rounded = Math.round(comparison.percentageChange);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}% vs previous period`;
}

export function formatRate(rate: number | null): string {
  if (rate === null) return "Not enough data yet";
  return `${Math.round(rate)}%`;
}
