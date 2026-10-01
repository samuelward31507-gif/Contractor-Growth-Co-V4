import type { SupabaseClient } from "@supabase/supabase-js";
import { fromCents, toCents } from "@/lib/invoices/domain";
import { inRange as inBillingRange } from "./billing";
import { NO_LEAD_LABEL, UNKNOWN_SOURCE_LABEL, readAllPages, type RevenueAttribution, type RevenueSourceRow } from "./revenue-attribution";
import type { ResolvedDateRange } from "./types";

/**
 * Phase 2E (Analytics only): collected cash by lead source - the Collected
 * column of Revenue by source. Not part of BusinessMetricsSnapshot, so
 * Agency, Today and the AI observations never see it.
 *
 * Chain: customer_payments.job_id (required, denormalized from the invoice)
 * → jobs.lead_id → leads.source. Grouped exactly like Revenue by source
 * (trimmed, case kept): a blank source is "Unknown source", a job with no
 * lead is "No lead linked". A payment counts toward its job's source
 * whatever period the job or lead was from.
 *
 * Period: received_at, using the billing ledger's own inclusion test
 * (lib/bi/billing.ts inRange) so the column always totals to the
 * Revenue & payments Collected figure for the same organization-calendar
 * range. The read takes [from, to] inclusive and that test then decides
 * each boundary row exactly as billing does. Reversal rows are negative,
 * so every figure is net. All sums are cent-exact.
 *
 * Paged by 1000 through readAllPages (Phase 2C). Past MAX_ATTRIBUTION_ROWS,
 * or on any read error, it returns failed with nothing collected - never a
 * partial total.
 */

type Embed<T> = T | T[] | null;
export type CashPaymentRow = { amount: number | string; received_at: string; job: Embed<{ lead: Embed<{ source: string | null }> }> };

export type CashBySource = {
  /** Net collected per Revenue by source row key (`source:<name>`, `unknown`, `unlinked`). */
  collectedByKey: Map<string, number>;
  /** Net collected across every payment in the period - equals billingMetrics.collectedValue. */
  total: number;
};

export type CashAttribution = CashBySource & { failed: boolean };

export type RevenueSourceRowWithCollected = RevenueSourceRow & { collected: number };
export type RevenueBySourceWithCollected = {
  rows: RevenueSourceRowWithCollected[];
  totals: RevenueAttribution["totals"] & { collected: number };
};

const one = <T>(embed: Embed<T>): T | null => (Array.isArray(embed) ? (embed[0] ?? null) : embed);

/** The Revenue by source row a payment belongs to - the same keys summarizeRevenueAttribution builds. */
function rowKeyFor(payment: CashPaymentRow): string {
  const lead = one(one(payment.job)?.lead ?? null);
  if (!lead) return "unlinked";
  const source = lead.source?.trim();
  return source ? `source:${source}` : "unknown";
}

/** Pure: net collected per source over the payments received in `range` (billing's inclusion test). */
export function summarizeCashBySource(payments: CashPaymentRow[], range: ResolvedDateRange): CashBySource {
  const cents = new Map<string, number>();
  let totalCents = 0;
  for (const payment of payments) {
    if (!inBillingRange(payment.received_at, range)) continue;
    const amount = toCents(Number(payment.amount));
    const key = rowKeyFor(payment);
    cents.set(key, (cents.get(key) ?? 0) + amount);
    totalCents += amount;
  }
  return { collectedByKey: new Map([...cents].map(([key, value]) => [key, fromCents(value)])), total: fromCents(totalCents) };
}

/**
 * Pure: Revenue by source with a Collected column. A source with payments
 * but no leads or jobs in the period gets its own row (zero leads, jobs and
 * completed), so the column always adds up to the overall Collected. Order
 * is Revenue by source's own: named sources alphabetically, then Unknown
 * source, then No lead linked.
 */
export function withCollected(attribution: RevenueAttribution, cash: CashBySource): RevenueBySourceWithCollected {
  const rows = new Map<string, RevenueSourceRowWithCollected>(attribution.rows.map((row) => [row.key, { ...row, collected: 0 }]));
  for (const [key, collected] of cash.collectedByKey) {
    let row = rows.get(key);
    if (!row) {
      const kind: RevenueSourceRow["kind"] = key === "unlinked" ? "unlinked" : key === "unknown" ? "unknown" : "source";
      const label = kind === "source" ? key.slice("source:".length) : kind === "unknown" ? UNKNOWN_SOURCE_LABEL : NO_LEAD_LABEL;
      row = { key, label, kind, leads: kind === "unlinked" ? null : 0, jobs: 0, completedJobs: 0, completedValue: 0, collected: 0 };
      rows.set(key, row);
    }
    row.collected = collected;
  }
  const order = { source: 0, unknown: 1, unlinked: 2 } as const;
  return {
    rows: [...rows.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label)),
    totals: { ...attribution.totals, collected: cash.total },
  };
}

const JOB_SOURCE = "job:jobs!customer_payments_job_id_fkey(lead:leads!jobs_lead_id_fkey(source))";

export async function getCashAttribution(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<CashAttribution> {
  const read = await readAllPages<CashPaymentRow>(() => {
    let query = supabase.from("customer_payments").select(`amount, received_at, ${JOB_SOURCE}`).eq("organization_id", organizationId);
    if (range.from) query = query.gte("received_at", range.from);
    if (range.to) query = query.lte("received_at", range.to);
    return query.order("id");
  });
  if (read.failed) return { collectedByKey: new Map(), total: 0, failed: true };
  return { ...summarizeCashBySource(read.rows, range), failed: false };
}
