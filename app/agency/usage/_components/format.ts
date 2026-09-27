/**
 * Trackpr Phase 5B: the one new formatting rule this page needs beyond
 * app/agency/_components/format.ts's existing formatCount/formatRate - a
 * nullable count (AI tokens, missed calls) must never render as "0" when the
 * underlying value is null. Null means "unavailable" (no interaction in this
 * period reported usage, or the query itself failed) - a real 0 means the
 * query succeeded and found none. These are never the same thing.
 */
export function formatNullableCount(value: number | null): string {
  if (value === null) return "Unknown";
  return new Intl.NumberFormat("en-US").format(value);
}
