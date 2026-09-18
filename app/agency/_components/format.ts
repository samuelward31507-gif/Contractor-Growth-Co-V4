/**
 * Small, agency-page-local formatting helpers. lib/dashboard/format.ts
 * already covers currency/relative-time (reused directly where needed) -
 * this file only adds the one thing that module doesn't have: a null-safe
 * rate formatter, matching the exact "Not enough data yet" convention
 * app/(app)/dashboard/_components/key-metrics.tsx already established for
 * the client dashboard, so the two surfaces read consistently.
 */
export function formatRate(rate: number | null): string {
  if (rate === null) return "Not enough data yet";
  return `${Math.round(rate)}%`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
