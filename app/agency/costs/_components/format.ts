import type { CostCurrencyAmount } from "@/lib/agency/costs";

/**
 * Trackpr Phase 5D-2 - money formatting for ai_cost_events.total_cost, which
 * is a real fractional-currency numeric (dollars, not Stripe-style integer
 * minor units - AI token pricing is sub-cent per token, so this is
 * deliberately NOT the same convention as app/agency/revenue/_components/
 * format.ts's formatMoney, which divides an integer minor-unit amount by
 * 100). Mirrors that file's zero-decimal-currency awareness and
 * never-combine-currencies discipline exactly, adapted for this module's own
 * already-fractional amount shape.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

export function formatCost(amount: number, currency: string): string {
  const lower = currency.toLowerCase();
  const upper = currency.toUpperCase();
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(lower);

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: upper,
      minimumFractionDigits: isZeroDecimal ? 0 : 2,
      maximumFractionDigits: isZeroDecimal ? 0 : 4,
    }).format(amount);
  } catch {
    return `${amount.toFixed(isZeroDecimal ? 0 : 4)} ${upper}`;
  }
}

/**
 * An empty array is a genuine, confirmed zero (a real query succeeded and
 * found no ai_cost_events rows in range) - renders as a real $0.00, never
 * "unavailable". Callers must never reach for this to render an
 * unpriced/unknown count - those are never dollar figures at all (see
 * ai-cost-summary.tsx).
 */
export function formatCostAmounts(amounts: CostCurrencyAmount[]): string {
  if (amounts.length === 0) return formatCost(0, "usd");
  return amounts.map((entry) => formatCost(entry.amount, entry.currency)).join(" + ");
}
