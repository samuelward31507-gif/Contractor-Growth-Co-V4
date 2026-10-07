import Link from "next/link";
import { ChevronRight, Undo2, Wallet } from "lucide-react";
import { contactDisplayName, formatContactDate } from "@/lib/contacts/format";
import { formatInvoiceNumber, formatMoney, PAYMENT_METHODS } from "@/lib/invoices/domain";
import type { CustomerPayment, Invoice } from "@/lib/invoices/queries";
import { Badge } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { recordIdClass } from "@/lib/ui/typography";

const METHOD_LABELS = new Map(PAYMENT_METHODS.map((method) => [method.value, method.label]));

/**
 * Batch 2: Money's Payments view - the organization's existing
 * customer_payments ledger (the same rows each invoice's own Payment
 * history shows), newest first. Read-only by design: recording, reversing
 * and refunding stay on the invoice, where their guards live; each row links
 * there. Amounts are the stored amounts, formatted - nothing is summed or
 * recomputed here.
 */
export function PaymentsTable({ payments, invoices, timeZone }: { payments: CustomerPayment[]; invoices: Invoice[]; timeZone?: string | null }) {
  if (payments.length === 0) {
    return <EmptyState icon={Wallet} title="No payments recorded yet" description="Payments appear here as they are recorded against an invoice." />;
  }

  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const reversedIds = new Set(payments.map((payment) => payment.reverses_payment_id).filter((id): id is string => Boolean(id)));

  return (
    <ul className="divide-y divide-line">
      {payments.map((payment) => {
        const invoice = invoiceById.get(payment.invoice_id);
        const isReversal = payment.reverses_payment_id != null;
        return (
          <li key={payment.id}>
            <Link
              href={`/invoices/${payment.invoice_id}`}
              className="group flex min-h-14 items-center gap-4 rounded-md px-2 py-2.5 transition-colors hover:bg-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className={`text-sm font-semibold tabular-nums ${isReversal ? "text-danger" : "text-ink"}`}>{formatMoney(payment.amount)}</span>
                  <span className="text-sm text-ink-2">{METHOD_LABELS.get(payment.method) ?? payment.method}</span>
                  {isReversal ? <Badge tone="danger" icon={Undo2}>Reversal</Badge> : null}
                  {reversedIds.has(payment.id) ? <Badge tone="neutral">Reversed</Badge> : null}
                </span>
                <span className="mt-0.5 block truncate text-xs text-ink-3">
                  {invoice ? <span className={recordIdClass}>{formatInvoiceNumber(invoice.number)}</span> : "Invoice"}
                  {invoice?.contact ? ` · ${contactDisplayName(invoice.contact)}` : ""}
                  {` · Received ${formatContactDate(payment.received_at, timeZone)}`}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink-3" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
