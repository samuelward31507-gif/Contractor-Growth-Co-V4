import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgencyOrganizations } from "./queries";
import { resolveDateRange } from "@/lib/bi/queries";
import { readAllPages } from "@/lib/bi/revenue-attribution";
import type { DateRangeInput, ResolvedDateRange } from "@/lib/bi/types";
import type { AgencyAuthFailure } from "./queries";

/**
 * Trackpr Phase 5D-1 - Revenue Intelligence read layer. This is the ONLY
 * place agency revenue is ever aggregated - it reads exclusively from
 * revenue_events (populated by app/api/webhooks/stripe/route.ts's
 * invoice.payment_succeeded/invoice.payment_failed/charge.refunded
 * handlers), never from Stripe live, and never recomputes anything from
 * current env vars, Price IDs, or subscription/client configuration.
 * `occurred_at` is always the field used for range filtering and reporting -
 * never `recorded_at`, which is operational-only.
 *
 * Calls resolveAgencyOrganizations() directly, exactly once, and never
 * trusts a caller-supplied organization id - mirrors every other
 * lib/agency/*.ts module's own authorization discipline.
 *
 * Multi-currency safety: every total below is a CurrencyAmount[], one entry
 * per currency actually observed - amounts across different currencies are
 * NEVER summed together into one combined number. An agency operating in a
 * single currency will simply see an array with one entry.
 */

const MAX_RECENT_EVENTS = 100;

export type RevenueEventType = "payment_succeeded" | "payment_failed" | "refund";
export type RevenueCategory = "setup" | "recurring" | null;

export type CurrencyAmount = { currency: string; amount: number };

export type RevenueTotals = {
  /** Sum of every payment_succeeded event's amount, per currency - the headline "collected revenue" figure. */
  collected: CurrencyAmount[];
  /** The subset of `collected` classified as a one-time setup fee (see classifyInvoiceRevenueCategory in the webhook route). */
  setupCollected: CurrencyAmount[];
  /** The subset of `collected` classified as a recurring subscription renewal. */
  recurringCollected: CurrencyAmount[];
  /** The subset of `collected` whose category could not be confidently determined (e.g. a mixed first invoice) - preserved as its own bucket rather than guessed into setup or recurring. */
  uncategorizedCollected: CurrencyAmount[];
  /** Sum of every refund event's amount, per currency. Always a positive figure - its negative effect on net is applied only here in netCollected, never by mutating the original payment_succeeded row. */
  refunded: CurrencyAmount[];
  /** collected - refunded, per currency (a currency present in only one side is treated as 0 on the other). */
  netCollected: CurrencyAmount[];
  /** Sum of every payment_failed event's amount, per currency. NEVER combined into `collected` or `netCollected` - a failed payment is not collected money. */
  failedAttempted: CurrencyAmount[];
};

export type ClientRevenueSummary = {
  organizationId: string;
  organizationName: string;
  totals: RevenueTotals;
  eventCount: number;
};

export type RevenueEventRecord = {
  id: string;
  organizationId: string;
  organizationName: string;
  eventType: RevenueEventType;
  revenueCategory: RevenueCategory;
  amount: number;
  currency: string;
  occurredAt: string;
};

export type AgencyRevenueResult =
  | {
      ok: true;
      range: ResolvedDateRange;
      totals: RevenueTotals;
      clients: ClientRevenueSummary[];
      /** Most recent events first, capped at MAX_RECENT_EVENTS - a display list, not the basis for any total above (totals are computed from the full, uncapped query result). */
      recentEvents: RevenueEventRecord[];
      partialData: boolean;
      generatedAt: string;
    }
  | AgencyAuthFailure;

export type MutableCurrencyTotals = {
  collected: Map<string, number>;
  setupCollected: Map<string, number>;
  recurringCollected: Map<string, number>;
  uncategorizedCollected: Map<string, number>;
  refunded: Map<string, number>;
  failedAttempted: Map<string, number>;
};

export function emptyMutableTotals(): MutableCurrencyTotals {
  return {
    collected: new Map(),
    setupCollected: new Map(),
    recurringCollected: new Map(),
    uncategorizedCollected: new Map(),
    refunded: new Map(),
    failedAttempted: new Map(),
  };
}

function addAmount(map: Map<string, number>, currency: string, amount: number): void {
  map.set(currency, (map.get(currency) ?? 0) + amount);
}

export function toCurrencyAmounts(map: Map<string, number>): CurrencyAmount[] {
  return Array.from(map.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export function netCollected(collected: Map<string, number>, refunded: Map<string, number>): CurrencyAmount[] {
  const currencies = new Set<string>([...collected.keys(), ...refunded.keys()]);
  return Array.from(currencies)
    .map((currency) => ({ currency, amount: (collected.get(currency) ?? 0) - (refunded.get(currency) ?? 0) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export function finalizeTotals(mutable: MutableCurrencyTotals): RevenueTotals {
  return {
    collected: toCurrencyAmounts(mutable.collected),
    setupCollected: toCurrencyAmounts(mutable.setupCollected),
    recurringCollected: toCurrencyAmounts(mutable.recurringCollected),
    uncategorizedCollected: toCurrencyAmounts(mutable.uncategorizedCollected),
    refunded: toCurrencyAmounts(mutable.refunded),
    netCollected: netCollected(mutable.collected, mutable.refunded),
    failedAttempted: toCurrencyAmounts(mutable.failedAttempted),
  };
}

export function applyRow(mutable: MutableCurrencyTotals, eventType: RevenueEventType, revenueCategory: RevenueCategory, currency: string, amount: number): void {
  if (eventType === "payment_succeeded") {
    addAmount(mutable.collected, currency, amount);
    if (revenueCategory === "setup") addAmount(mutable.setupCollected, currency, amount);
    else if (revenueCategory === "recurring") addAmount(mutable.recurringCollected, currency, amount);
    else addAmount(mutable.uncategorizedCollected, currency, amount);
  } else if (eventType === "refund") {
    addAmount(mutable.refunded, currency, amount);
  } else if (eventType === "payment_failed") {
    addAmount(mutable.failedAttempted, currency, amount);
  }
}

export type RevenueEventRow = {
  id: string;
  organization_id: string;
  event_type: RevenueEventType;
  revenue_category: RevenueCategory;
  amount: number;
  currency: string;
  occurred_at: string;
};

/**
 * The one query this module ever issues, batched across the full authorized
 * organization id list (never one query per org). `failed` is true only on
 * a real Postgrest error - a genuinely empty result (no revenue events yet -
 * the honest current state of this product per the Phase 5D audit) is a
 * valid, non-failed result, correctly producing all-zero totals rather than
 * "unavailable".
 */
export async function loadRevenueEvents(
  serviceSupabase: SupabaseClient,
  organizationIds: string[],
  range: ResolvedDateRange,
): Promise<{ rows: RevenueEventRow[]; failed: boolean }> {
  if (organizationIds.length === 0) return { rows: [], failed: false };

  // Phase 3A-3a: paged (readAllPages) - the API caps a response at 1000 rows,
  // which silently cut the revenue totals short. Newest first with id as the
  // tie-break, so pages are stable and getAgencyRevenue's recent-events
  // slice stays the newest events. A failed page or the row limit returns
  // failed with no rows - never partial totals.
  const read = await readAllPages<RevenueEventRow>(() => {
    let query = serviceSupabase
      .from("revenue_events")
      .select("id, organization_id, event_type, revenue_category, amount, currency, occurred_at")
      .in("organization_id", organizationIds);
    if (range.from) query = query.gte("occurred_at", range.from);
    if (range.to) query = query.lt("occurred_at", range.to);
    return query.order("occurred_at", { ascending: false }).order("id");
  });
  return read.failed ? { rows: [], failed: true } : { rows: read.rows, failed: false };
}

/**
 * The primary Phase 5D-1 read. Defaults to lifetime ("allTime") rather than
 * this codebase's usual last-30-days activity default - this is a financial
 * ledger, not a usage-activity view, and "how much has this client ever
 * paid" is the more natural default question for revenue. Callers (the
 * /agency/revenue page) may pass any DateRangeInput to answer
 * today/this-month/last-month/an arbitrary custom range instead.
 */
export async function getAgencyRevenue(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
  rangeInput: DateRangeInput = "allTime",
): Promise<AgencyRevenueResult> {
  const resolved = await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);
  if (!resolved.ok) return resolved;

  const range = resolveDateRange(rangeInput);
  const organizationIds = resolved.organizations.map((org) => org.organizationId);
  const { rows, failed } = await loadRevenueEvents(serviceSupabase, organizationIds, range);

  const organizationNameById = new Map(resolved.organizations.map((org) => [org.organizationId, org.organizationName]));
  const agencyTotals = emptyMutableTotals();
  const perOrgTotals = new Map<string, MutableCurrencyTotals>();
  const perOrgEventCount = new Map<string, number>();

  for (const org of resolved.organizations) {
    perOrgTotals.set(org.organizationId, emptyMutableTotals());
    perOrgEventCount.set(org.organizationId, 0);
  }

  for (const row of rows) {
    applyRow(agencyTotals, row.event_type, row.revenue_category, row.currency, row.amount);

    const orgMutable = perOrgTotals.get(row.organization_id);
    if (orgMutable) {
      applyRow(orgMutable, row.event_type, row.revenue_category, row.currency, row.amount);
      perOrgEventCount.set(row.organization_id, (perOrgEventCount.get(row.organization_id) ?? 0) + 1);
    }
    // A row whose organization_id is not in perOrgTotals would mean
    // revenue_events referenced an organization outside the authorized set -
    // impossible given the .in(organizationIds) query scope above, but
    // guarded rather than assumed.
  }

  const clients: ClientRevenueSummary[] = resolved.organizations.map((org) => ({
    organizationId: org.organizationId,
    organizationName: org.organizationName,
    totals: finalizeTotals(perOrgTotals.get(org.organizationId) ?? emptyMutableTotals()),
    eventCount: perOrgEventCount.get(org.organizationId) ?? 0,
  }));

  const recentEvents: RevenueEventRecord[] = rows.slice(0, MAX_RECENT_EVENTS).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    organizationName: organizationNameById.get(row.organization_id) ?? "Unknown organization",
    eventType: row.event_type,
    revenueCategory: row.revenue_category,
    amount: row.amount,
    currency: row.currency,
    occurredAt: row.occurred_at,
  }));

  return {
    ok: true,
    range,
    totals: finalizeTotals(agencyTotals),
    clients,
    recentEvents,
    partialData: failed,
    generatedAt: new Date().toISOString(),
  };
}
