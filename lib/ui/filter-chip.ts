// Trackpr 2.0 (step 2G): the one filter-chip style - a row of mutually
// exclusive filters such as a date range (Analytics, Agency Revenue/Costs).
// A filter is not a primary action, so the selected chip is a quiet
// selected fill with a hairline, never the pine accent. 6px controls, a
// 44px touch floor below `sm`. View switchers (Day/Week/Month/List,
// Priority/By type) keep the segmented-control pattern instead.
export function filterChipClass(active: boolean): string {
  return `inline-flex min-h-11 items-center rounded-full px-3 text-xs font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-8 ${
    active ? "bg-surface text-ink shadow-control inset-ring inset-ring-line-strong" : "text-ink-2 hover:bg-ink/[0.045] hover:text-ink"
  }`;
}
