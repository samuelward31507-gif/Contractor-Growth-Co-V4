"use client";

import { useState } from "react";
import { ExternalLink, Undo2, Wallet } from "lucide-react";
import { Badge } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { SectionCard } from "@/lib/ui/section-card";
import { secondaryButtonSmallClass } from "@/lib/ui/form";
import { formatContactDate } from "@/lib/contacts/format";
import { formatMoney, PAYMENT_METHODS, type InvoiceStatus } from "@/lib/invoices/domain";
import type { CustomerPayment } from "@/lib/invoices/queries";
import { paymentRowAction, STRIPE_REFUND_URL } from "@/lib/invoices/payment-history-view";
import { ReversePaymentDialog } from "./reverse-payment-dialog";

const METHOD_LABELS = new Map(PAYMENT_METHODS.map((method) => [method.value, method.label]));

/**
 * Phase 1B-3: the append-only ledger. Every row stays visible forever; a
 * reversal is a separate negative row linked to its original. There are no
 * edit or delete controls here by design - the database has no policy or
 * grant that would allow either, and the UI never pretends otherwise.
 */
export function PaymentHistory({ payments, invoiceStatus }: { payments: CustomerPayment[]; invoiceStatus: InvoiceStatus }) {
  const [reversing, setReversing] = useState<CustomerPayment | null>(null);
  const reversedIds = new Set(payments.map((payment) => payment.reverses_payment_id).filter((id): id is string => Boolean(id)));

  return (
    <SectionCard title="Payments" description="Money received against this invoice. Entries are permanent; corrections are reversals.">
      {payments.length === 0 ? (
        <EmptyState icon={Wallet} title="No payments recorded" description={invoiceStatus === "draft" ? "Issue the invoice first, then record payments as they come in." : invoiceStatus === "void" ? "This invoice was voided before any payment." : "Record a payment when money arrives."} />
      ) : (
        <ul className="divide-y divide-line">
          {payments.map((payment) => {
            const isReversal = payment.reverses_payment_id != null;
            const isReversed = reversedIds.has(payment.id);
            const action = paymentRowAction({ method: payment.method, isReversal, isReversed, invoiceStatus });
            return (
              <li key={payment.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm font-semibold tabular-nums ${isReversal ? "text-danger" : "text-ink"}`}>{formatMoney(payment.amount)}</span>
                    <span className="text-sm text-ink-2">{METHOD_LABELS.get(payment.method) ?? payment.method}</span>
                    {isReversal ? <Badge tone="danger" icon={Undo2}>Reversal</Badge> : null}
                    {isReversed ? <Badge tone="neutral">Reversed</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-3">
                    Received {formatContactDate(payment.received_at)}
                    {payment.reference ? ` · Ref ${payment.reference}` : ""}
                  </p>
                  {payment.notes ? <p className="mt-1 text-xs text-ink-3">{payment.notes}</p> : null}
                </div>
                {action === "refund_in_stripe" ? (
                  <a href={STRIPE_REFUND_URL} target="_blank" rel="noopener noreferrer" className={`${secondaryButtonSmallClass} shrink-0 self-start`}>
                    Refund in Stripe
                    <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                  </a>
                ) : action === "reverse" ? (
                  <button type="button" onClick={() => setReversing(payment)} className={`${secondaryButtonSmallClass} shrink-0 self-start`}>
                    <Undo2 aria-hidden className="h-3.5 w-3.5" />
                    Reverse
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {reversing ? <ReversePaymentDialog payment={reversing} onClose={() => setReversing(null)} /> : null}
    </SectionCard>
  );
}
