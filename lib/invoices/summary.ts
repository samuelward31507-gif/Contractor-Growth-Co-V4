import { fromCents, isOverdue, toCents, type InvoiceStatus } from "./domain";

/**
 * Phase 1B-3: the Money page's invoice/payment figures, computed in memory
 * from already-fetched, org-scoped rows the same way computeMoneySnapshot
 * and summarizeJobs work. Every number here keeps the terminology
 * discipline:
 *
 *   invoiced      SUM(invoices.total) over issued, non-void invoices - money
 *                 asked for, not money received
 *   collected     SUM(customer_payments.amount) including reversals - the
 *                 ONLY figure that is real money received
 *   outstanding   SUM(balance_due) over sent + partially_paid invoices
 *   overdue       the subset of outstanding whose due_date is before today
 *                 (in the organization's timezone), derived, never stored
 *   notYetInvoiced completed jobs with no live invoice - contracted work
 *                 that has not been billed
 *
 * All arithmetic is cent-exact through lib/invoices/domain.ts.
 */

export type SummaryInvoice = {
  id: string;
  job_id: string;
  status: InvoiceStatus;
  total: number;
  amount_paid: number;
  balance_due: number;
  due_date: string | null;
};

export type SummaryPayment = { amount: number };

export type SummaryJob = { id: string; status: string; amount: number | null };

export type InvoiceMoneySummary = {
  invoiced: number;
  invoicedCount: number;
  collected: number;
  paymentCount: number;
  outstanding: number;
  outstandingCount: number;
  overdue: number;
  overdueCount: number;
  draftCount: number;
  notYetInvoicedCount: number;
  /** SUM(jobs.amount) over not-yet-invoiced completed jobs that have an amount; unknown amounts are excluded, never coerced to 0. */
  notYetInvoicedKnownValue: number;
  notYetInvoicedUnknownCount: number;
};

const ISSUED: ReadonlySet<InvoiceStatus> = new Set(["sent", "partially_paid", "paid"]);
const OPEN: ReadonlySet<InvoiceStatus> = new Set(["sent", "partially_paid"]);

function sumCents(values: number[]): number {
  return fromCents(values.reduce((sum, value) => sum + toCents(value), 0));
}

export function summarizeInvoiceMoney(params: { invoices: SummaryInvoice[]; payments: SummaryPayment[]; jobs: SummaryJob[]; today: string }): InvoiceMoneySummary {
  const { invoices, payments, jobs, today } = params;

  const issued = invoices.filter((invoice) => ISSUED.has(invoice.status));
  const open = invoices.filter((invoice) => OPEN.has(invoice.status));
  const overdue = open.filter((invoice) => isOverdue({ status: invoice.status, dueDate: invoice.due_date }, today));

  const liveJobIds = new Set(invoices.filter((invoice) => invoice.status !== "void").map((invoice) => invoice.job_id));
  const notYetInvoiced = jobs.filter((job) => job.status === "completed" && !liveJobIds.has(job.id));
  const knownValues = notYetInvoiced.map((job) => job.amount).filter((amount): amount is number => amount != null);

  return {
    invoiced: sumCents(issued.map((invoice) => invoice.total)),
    invoicedCount: issued.length,
    collected: sumCents(payments.map((payment) => payment.amount)),
    paymentCount: payments.filter((payment) => payment.amount > 0).length,
    outstanding: sumCents(open.map((invoice) => invoice.balance_due)),
    outstandingCount: open.length,
    overdue: sumCents(overdue.map((invoice) => invoice.balance_due)),
    overdueCount: overdue.length,
    draftCount: invoices.filter((invoice) => invoice.status === "draft").length,
    notYetInvoicedCount: notYetInvoiced.length,
    notYetInvoicedKnownValue: sumCents(knownValues),
    notYetInvoicedUnknownCount: notYetInvoiced.length - knownValues.length,
  };
}

export type InvoiceFilters = {
  query?: string;
  status?: InvoiceStatus | "all" | "overdue";
};

export type FilterableInvoice = SummaryInvoice & {
  number: number;
  title: string;
  contact: { first_name: string | null; last_name: string | null; company_name: string | null; phone: string | null; email: string | null } | null;
};

/** In-memory filter over an org-scoped list, the filterEstimates/filterJobs approach. "overdue" is a derived pseudo-status. */
export function filterInvoices<T extends FilterableInvoice>(invoices: T[], filters: InvoiceFilters, today: string): T[] {
  const term = filters.query?.trim().toLowerCase() ?? "";

  return invoices.filter((invoice) => {
    if (filters.status === "overdue") {
      if (!isOverdue({ status: invoice.status, dueDate: invoice.due_date }, today)) return false;
    } else if (filters.status && filters.status !== "all" && invoice.status !== filters.status) {
      return false;
    }

    if (!term) return true;

    const contact = invoice.contact;
    const fullName = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ").toLowerCase() : "";
    const haystacks = [
      invoice.title.toLowerCase(),
      `inv-${String(invoice.number).padStart(6, "0")}`,
      String(invoice.number),
      fullName,
      contact?.company_name?.toLowerCase(),
      contact?.phone?.toLowerCase(),
      contact?.email?.toLowerCase(),
    ];
    return haystacks.some((value) => value?.includes(term));
  });
}
