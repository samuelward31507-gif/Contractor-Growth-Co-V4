import type { SupabaseClient } from "@supabase/supabase-js";
import { fromCents, isOverdue, toCents, type InvoiceStatus } from "@/lib/invoices/domain";
import type { ResolvedDateRange } from "./types";

/**
 * Phase 1B-4 (Close the Money Loop - Financial Visibility): the billing
 * metrics for the BI snapshot, computed from public.invoices and
 * public.customer_payments - the first and only tables in this schema that
 * record money asked for and money received. Everything else in lib/bi
 * (pipelineValue, estimateValue, contractedJobValue, ...) remains a quoted
 * or contracted figure and is still never called revenue.
 *
 *   Collected revenue = customer payments recorded in Trackpr, net of
 *   recorded reversals.
 *
 * That sentence (SANCTIONED_COLLECTED_REVENUE_DEFINITION) is the one
 * approved definition, reused verbatim by the Insights UI, the data-quality
 * note and the AI insights prompt/validator.
 *
 * The database is the authority for every invoice/payment fact read here:
 * `total`, `balance_due` (a generated column), `status`, `issued_at` and the
 * payment rows themselves. This module only sums, counts and scopes them to
 * a reporting period - it never recomputes a balance or a status.
 *
 * Period semantics (the existing half-open [from, to) convention from
 * resolveDateRange):
 *   invoicedValue / invoicesIssued   issued_at in range, status sent/
 *                                    partially_paid/paid (drafts and void
 *                                    excluded)
 *   collectedValue / paymentsReceived received_at in range - reversal rows
 *                                    are negative, so the sum is net
 *   reversedValue / reversalCount     the negative rows in range, shown
 *                                    separately so the net figure is
 *                                    transparent
 *   averageDaysToPayment              invoices whose COMPLETING payment's
 *                                    received_at is in range: mean of
 *                                    (completing received_at - issued_at)
 *                                    in days; never paid_at (set at record
 *                                    time, so a backdated payment would
 *                                    inflate it)
 *   outstandingValue / overdueValue   current state as of `today` (the
 *                                    organization's calendar date), never
 *                                    range-scoped - like pipeline and
 *                                    revenueOpportunity, "what is owed right
 *                                    now" is not a date-range question
 *
 * One unbounded, narrow-column read per table (capped at MAX_ROWS like every
 * other BI read) feeds both the current-state and the period-scoped figures,
 * and the previous-period comparison, so the ledger is read once per
 * snapshot rather than three times.
 */

export const SANCTIONED_COLLECTED_REVENUE_DEFINITION = "Collected revenue = customer payments recorded in Trackpr, net of recorded reversals.";

const MAX_ROWS = 10_000;
const MS_PER_DAY = 86_400_000;

const ISSUED: ReadonlySet<InvoiceStatus> = new Set(["sent", "partially_paid", "paid"]);
const OPEN: ReadonlySet<InvoiceStatus> = new Set(["sent", "partially_paid"]);

export type BillingInvoiceRow = {
  id: string;
  status: InvoiceStatus;
  total: number;
  balance_due: number;
  issued_at: string | null;
  due_date: string | null;
};

export type BillingPaymentRow = {
  invoice_id: string;
  amount: number;
  received_at: string;
  created_at: string;
};

export type BillingRows = { invoices: BillingInvoiceRow[]; payments: BillingPaymentRow[]; failed: boolean };

/** `failed` is true only on a real Postgrest error on either read, never on a genuinely empty ledger - the lib/bi/queries.ts discipline. */
export async function getBillingRowsResult(supabase: SupabaseClient, organizationId: string): Promise<BillingRows> {
  const [{ data: invoiceData, error: invoiceError }, { data: paymentData, error: paymentError }] = await Promise.all([
    supabase.from("invoices").select("id, status, total, balance_due, issued_at, due_date").eq("organization_id", organizationId).limit(MAX_ROWS),
    supabase.from("customer_payments").select("invoice_id, amount, received_at, created_at").eq("organization_id", organizationId).limit(MAX_ROWS),
  ]);

  return {
    invoices: (invoiceData ?? []) as BillingInvoiceRow[],
    payments: (paymentData ?? []) as BillingPaymentRow[],
    failed: invoiceError != null || paymentError != null,
  };
}

export type BiBillingMetrics = {
  /** SUM(invoices.total) over invoices issued in the period (status sent/partially_paid/paid) - money asked for, never revenue. */
  invoicedValue: number;
  invoicesIssued: number;
  /** SUM(customer_payments.amount) over rows received in the period, reversals included as negatives - the ONLY figure that is money received. */
  collectedValue: number;
  /** Positive payment rows received in the period. */
  paymentsReceived: number;
  /** The absolute value of the reversal rows received in the period - already subtracted from collectedValue, shown separately for transparency. */
  reversedValue: number;
  reversalCount: number;
  /** SUM(balance_due) over sent/partially_paid invoices as of today - current state, never period-scoped. */
  outstandingValue: number;
  outstandingInvoices: number;
  /** The subset of outstanding whose due_date is before today in the organization's timezone. */
  overdueValue: number;
  overdueInvoices: number;
  /** Invoices whose completing payment was received in the period - the population averageDaysToPayment is computed over. */
  invoicesPaid: number;
  /** Mean days from issued_at to the completing payment's received_at, over invoicesPaid. Null when invoicesPaid is 0 - never a fabricated 0. */
  averageDaysToPayment: number | null;
};

function inRange(instant: string, range: ResolvedDateRange): boolean {
  if (range.from && instant < range.from) return false;
  if (range.to && instant >= range.to) return false;
  return true;
}

function sumCents(values: number[]): number {
  return fromCents(values.reduce((sum, value) => sum + toCents(value), 0));
}

/**
 * The instant an invoice became fully paid: walking its ledger in received
 * order, the moment the running total last crossed from below the invoice
 * total to at or above it. A reversal that drops the balance open again and
 * a later payment that closes it moves the completion to that later
 * payment. Null when the ledger never reaches the total (the invoice is not
 * paid) or the invoice was never issued.
 */
export function findCompletionInstant(invoice: Pick<BillingInvoiceRow, "total" | "issued_at">, payments: Pick<BillingPaymentRow, "amount" | "received_at" | "created_at">[]): string | null {
  if (!invoice.issued_at) return null;
  const totalCents = toCents(invoice.total);
  if (totalCents <= 0) return null;

  const ordered = [...payments].sort((a, b) => a.received_at.localeCompare(b.received_at) || a.created_at.localeCompare(b.created_at));
  let running = 0;
  let completion: string | null = null;
  for (const payment of ordered) {
    const before = running;
    running += toCents(payment.amount);
    if (before < totalCents && running >= totalCents) completion = payment.received_at;
    else if (running < totalCents) completion = null;
  }
  return completion;
}

export function computeBillingMetrics(params: { invoices: BillingInvoiceRow[]; payments: BillingPaymentRow[]; range: ResolvedDateRange; today: string }): BiBillingMetrics {
  const { invoices, payments, range, today } = params;

  const issuedInRange = invoices.filter((invoice) => ISSUED.has(invoice.status) && invoice.issued_at != null && inRange(invoice.issued_at, range));
  const paymentsInRange = payments.filter((payment) => inRange(payment.received_at, range));
  const positive = paymentsInRange.filter((payment) => payment.amount > 0);
  const reversals = paymentsInRange.filter((payment) => payment.amount < 0);

  const open = invoices.filter((invoice) => OPEN.has(invoice.status));
  const overdue = open.filter((invoice) => isOverdue({ status: invoice.status, dueDate: invoice.due_date }, today));

  const paymentsByInvoice = new Map<string, BillingPaymentRow[]>();
  for (const payment of payments) {
    const bucket = paymentsByInvoice.get(payment.invoice_id);
    if (bucket) bucket.push(payment);
    else paymentsByInvoice.set(payment.invoice_id, [payment]);
  }

  const daysToPayment: number[] = [];
  for (const invoice of invoices) {
    if (invoice.status !== "paid" || !invoice.issued_at) continue;
    const completion = findCompletionInstant(invoice, paymentsByInvoice.get(invoice.id) ?? []);
    if (!completion || !inRange(completion, range)) continue;
    daysToPayment.push(Math.max(0, new Date(completion).getTime() - new Date(invoice.issued_at).getTime()) / MS_PER_DAY);
  }

  return {
    invoicedValue: sumCents(issuedInRange.map((invoice) => invoice.total)),
    invoicesIssued: issuedInRange.length,
    collectedValue: sumCents(paymentsInRange.map((payment) => payment.amount)),
    paymentsReceived: positive.length,
    reversedValue: sumCents(reversals.map((payment) => -payment.amount)),
    reversalCount: reversals.length,
    outstandingValue: sumCents(open.map((invoice) => invoice.balance_due)),
    outstandingInvoices: open.length,
    overdueValue: sumCents(overdue.map((invoice) => invoice.balance_due)),
    overdueInvoices: overdue.length,
    invoicesPaid: daysToPayment.length,
    averageDaysToPayment: daysToPayment.length === 0 ? null : daysToPayment.reduce((sum, days) => sum + days, 0) / daysToPayment.length,
  };
}
