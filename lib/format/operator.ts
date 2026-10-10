/**
 * Display helpers for the operator areas (Agency Command Center and the
 * Founder workspace) - money per currency, and every time shown in the
 * zone the caller passes. Display only. Moved here unchanged from
 * lib/founder/format.ts so the Agency Command Center doesn't depend on the
 * Founder workspace; lib/founder/format.ts re-exports it.
 */

export function formatMoney(value: number, currency = "USD"): string {
  const hasCents = Math.round(value * 100) % 100 !== 0;
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: hasCents ? 2 : 0, maximumFractionDigits: hasCents ? 2 : 0 }).format(value);
}

/** Per-currency totals as one line ("$2,500 · €900"), never added across currencies. Empty -> null. */
export function formatTotals(totals: Record<string, number>): string | null {
  const keys = Object.keys(totals).sort();
  return keys.length ? keys.map((currency) => formatMoney(totals[currency], currency)).join(" · ") : null;
}

/** +$1,200 / −$300 / $0 - for MRR movements. */
export function formatSignedMoney(value: number): string {
  if (value === 0) return formatMoney(0);
  return `${value > 0 ? "+" : "−"}${formatMoney(Math.abs(value))}`;
}

export function formatTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
}

export function formatDay(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string, timeZone: string): string {
  return `${formatDay(iso, timeZone)}, ${formatTime(iso, timeZone)}`;
}

/** "Friday, October 9" for a YYYY-MM-DD key (a calendar date, no zone shift). */
export function formatDateKey(key: string, options: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" }): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...options });
}

/** "Oct 2026" for a YYYY-MM-01 key. */
export function formatMonthKey(key: string, long = false): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: long ? "long" : "short", year: "numeric" });
}
