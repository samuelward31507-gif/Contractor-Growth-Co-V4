"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { formatMoney, PAYMENT_METHODS, type InvoiceMoney } from "@/lib/invoices/domain";
import { buildRecordPaymentInput, defaultRecordPaymentForm } from "@/lib/invoices/forms";
import { recordCustomerPayment } from "../../actions";

export type RecordPaymentInvoice = InvoiceMoney & { id: string; number: number };

/**
 * Phase 1B-3: record money received outside Trackpr (cash, check, a card
 * run on the contractor's own terminal, a bank transfer, other). Client
 * validation mirrors the service and trigger wording; the database is the
 * authority on overpayment and the resulting status. The submit button is
 * disabled the moment a request starts and re-enabled only on failure, so a
 * double tap cannot record the same payment twice.
 */
export function RecordPaymentDialog({ invoice, onClose }: { invoice: RecordPaymentInvoice; onClose: () => void }) {
  const router = useRouter();
  const [values, setValues] = useState(() => defaultRecordPaymentForm(invoice));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();
  const balance = Math.round((invoice.total - invoice.amountPaid) * 100) / 100;
  const locked = submitting || isPending;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    setError(null);
    const built = buildRecordPaymentInput(values, invoice);
    if (built.error !== undefined) {
      setError(built.error);
      return;
    }
    setSubmitting(true);
    startTransition(async () => {
      const result = await recordCustomerPayment(built.input);
      if (!result.ok) {
        setError(result.error);
        setSubmitting(false);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog onClose={onClose} className="max-h-[90vh] max-w-md overflow-y-auto" labelledBy="record-payment-title">
      <DialogTitle id="record-payment-title">Record payment</DialogTitle>
      <DialogDescription>
        Balance due is <span className="font-medium text-slate-700">{formatMoney(balance)}</span>. Payments are permanent; a mistake is corrected with a reversal, not an edit.
      </DialogDescription>

      <form onSubmit={submit} className="mt-4 space-y-4" noValidate>
        {error ? (
          <p className={`flex items-start gap-2 ${errorBannerClass}`} role="alert">
            <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="payment-amount" className={labelClass}>
              Amount
            </label>
            <input id="payment-amount" type="number" inputMode="decimal" min="0.01" step="0.01" max={balance} value={values.amountRaw} onChange={(e) => setValues({ ...values, amountRaw: e.target.value })} className={inputClass} placeholder="0.00" required />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="payment-method" className={labelClass}>
              Method
            </label>
            <select id="payment-method" value={values.method} onChange={(e) => setValues({ ...values, method: e.target.value })} className={inputClass} required>
              <option value="">Choose…</option>
              {PAYMENT_METHODS.map((method) => (
                <option key={method.value} value={method.value}>
                  {method.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="payment-reference" className={labelClass}>
              Reference <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="payment-reference" value={values.reference} onChange={(e) => setValues({ ...values, reference: e.target.value })} className={inputClass} placeholder="Check no., last four, transfer id" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="payment-received" className={labelClass}>
              Received
            </label>
            <input id="payment-received" type="datetime-local" value={values.receivedAtLocal} onChange={(e) => setValues({ ...values, receivedAtLocal: e.target.value })} className={inputClass} required />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="payment-notes" className={labelClass}>
            Notes <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea id="payment-notes" rows={2} value={values.notes} onChange={(e) => setValues({ ...values, notes: e.target.value })} className={inputClass} placeholder="Only your team sees these" />
        </div>

        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass} disabled={locked}>
            Cancel
          </button>
          <button type="submit" disabled={locked} className={primaryButtonAutoClass}>
            {locked ? "Recording…" : "Record payment"}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
