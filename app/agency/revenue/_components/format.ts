import type { CurrencyAmount } from "@/lib/agency/revenue";

/**
 * Trackpr Phase 5D-1 - money formatting for revenue_events amounts, which
 * are always Stripe's own minor-unit integer (e.g. cents for USD). A small,
 * explicit zero-decimal-currency list (Stripe's own documented set) so a
 * JPY/KRW/etc amount is never divided by 100 when Stripe never multiplied it
 * by 100 in the first place - everything else defaults to the standard
 * 2-decimal minor-unit convention, which is what every currency actually
 * configured in this Stripe account (USD) uses.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

export function formatMoney(amountMinorUnits: number, currency: string): string {
  const lower = currency.toLowerCase();
  const upper = currency.toUpperCase();
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(lower);
  const majorUnits = isZeroDecimal ? amountMinorUnits : amountMinorUnits / 100;

  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: upper, maximumFractionDigits: isZeroDecimal ? 0 : 2 }).format(majorUnits);
  } catch {
    // An unrecognized/malformed currency code from Stripe should never crash
    // the page - fall back to a plain labeled number rather than throwing.
    return `${majorUnits.toFixed(isZeroDecimal ? 0 : 2)} ${upper}`;
  }
}

/**
 * Renders every currency actually present, one figure per currency, joined -
 * NEVER summed into one combined number (see lib/agency/revenue.ts's own
 * module comment on multi-currency safety). An empty array is a genuine,
 * confirmed zero (the underlying query succeeded and found no matching
 * revenue_events rows in range) - not "unavailable" - so it renders as a
 * real $0.00, matching this Stripe account's one configured currency (USD).
 */
export function formatCurrencyAmounts(amounts: CurrencyAmount[]): string {
  if (amounts.length === 0) return formatMoney(0, "usd");
  return amounts.map((entry) => formatMoney(entry.amount, entry.currency)).join(" + ");
}
