/**
 * Batch 1 (Cinder design foundation): the one currency formatter. Display
 * only - it never rounds, converts or computes an amount that is stored or
 * charged; callers pass the dollar value they already hold.
 *
 * `cents`:
 *   - "auto" (default): whole dollars when the amount has no cents, two
 *     decimals otherwise ("$1,200", "$1,300.25") - the money pages' rule.
 *   - "never": whole dollars, for headline figures and KPIs ("$4,821").
 *   - "always": two decimals, for ledgers that line up ("$1,200.00").
 */
export type CurrencyCents = "auto" | "never" | "always";

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string, digits: number): Intl.NumberFormat {
  const key = `${currency}:${digits}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
    formatters.set(key, formatter);
  }
  return formatter;
}

export function formatCurrency(value: number, options: { cents?: CurrencyCents; currency?: string } = {}): string {
  const { cents = "auto", currency = "USD" } = options;
  const digits = cents === "never" ? 0 : cents === "always" ? 2 : Math.round(value * 100) % 100 !== 0 ? 2 : 0;
  return formatterFor(currency.toUpperCase(), digits).format(value);
}

/** Minor units (e.g. Stripe's integer cents) to the same display. */
export function formatMinorUnits(minorUnits: number, currency = "USD", cents: CurrencyCents = "auto"): string {
  return formatCurrency(minorUnits / 100, { currency, cents });
}
