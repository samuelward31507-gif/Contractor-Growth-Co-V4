"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { destructiveButtonAutoClass, errorBannerClass, ghostButtonClass, inputClass, labelClass } from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { formatMoney } from "@/lib/invoices/domain";
import { describeReversal } from "@/lib/invoices/forms";
import { detailLabelClass, detailValueClass } from "@/lib/ui/typography";
import { formatContactDate } from "@/lib/contacts/format";
import type { CustomerPayment } from "@/lib/invoices/queries";
import { reverseCustomerPayment } from "../../actions";

/**
 * Phase 1B-3: explicit confirmation before a reversal. States exactly what
 * will happen: a new negative row that offsets the original, which stays in
 * the ledger unchanged. Submits through the existing server action only.
 */
export function ReversePaymentDialog({ payment, onClose }: { payment: CustomerPayment; onClose: () => void }) {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();
  const locked = submitting || isPending;
  const { reversalAmount, methodLabel } = describeReversal(payment);

  function confirm() {
    if (locked) return;
    setError(null);
    setSubmitting(true);
    startTransition(async () => {
      const result = await reverseCustomerPayment(payment.id, notes);
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
    <Dialog onClose={onClose} className="max-w-md" labelledBy="reverse-payment-title">
      <DialogTitle id="reverse-payment-title">Reverse this payment?</DialogTitle>
      <DialogDescription>
        A reversal adds a new entry of {formatMoney(reversalAmount)} to the ledger. The original payment is not deleted or changed, so the history stays complete.
      </DialogDescription>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <div>
          <dt className={detailLabelClass}>Original payment</dt>
          <dd className={`${detailValueClass} font-semibold tabular-nums`}>{formatMoney(payment.amount)}</dd>
        </div>
        <div>
          <dt className={detailLabelClass}>Method</dt>
          <dd className={detailValueClass}>{methodLabel}</dd>
        </div>
        <div>
          <dt className={detailLabelClass}>Received</dt>
          <dd className={detailValueClass}>{formatContactDate(payment.received_at)}</dd>
        </div>
        <div>
          <dt className={detailLabelClass}>Reversal amount</dt>
          <dd className={`${detailValueClass} font-semibold tabular-nums text-danger`}>{formatMoney(reversalAmount)}</dd>
        </div>
      </dl>

      {error ? (
        <p className={`mt-4 flex items-start gap-2 ${errorBannerClass}`} role="alert">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      <div className="mt-4 space-y-1.5">
        <label htmlFor="reversal-notes" className={labelClass}>
          Reason <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <input id="reversal-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} placeholder="Check bounced, entered twice, wrong invoice…" />
      </div>

      <DialogFooter>
        <button type="button" onClick={onClose} className={ghostButtonClass} disabled={locked}>
          Keep payment
        </button>
        <button type="button" onClick={confirm} disabled={locked} className={destructiveButtonAutoClass}>
          {locked ? "Reversing…" : "Reverse payment"}
        </button>
      </DialogFooter>
    </Dialog>
  );
}
