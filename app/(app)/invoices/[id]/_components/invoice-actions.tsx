"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Send, Wallet } from "lucide-react";
import { destructiveButtonAutoClass, destructiveGhostButtonAutoClass, errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { canIssue, canVoid, formatInvoiceNumber, formatMoney, type InvoiceStatus } from "@/lib/invoices/domain";
import { issueInvoice, voidInvoice } from "../../actions";
import { RecordPaymentDialog } from "./record-payment-dialog";

export type InvoiceActionsInvoice = {
  id: string;
  number: number;
  status: InvoiceStatus;
  total: number;
  amountPaid: number;
  dueDate: string | null;
};

/**
 * Phase 1B-3: which controls to offer is derived from status alone; the
 * server actions and the database triggers remain the sole authority on
 * whether a transition succeeds. Mirrors estimate-actions.tsx's shape.
 *
 *   draft            Issue, Void
 *   sent             Record payment, Void
 *   partially_paid   Record payment (void is blocked while money is recorded)
 *   paid / void      nothing here (history and state are shown on the page)
 */
export function InvoiceActions({ invoice }: { invoice: InvoiceActionsInvoice }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"issue" | "void" | "payment" | null>(null);
  const [issueDueDate, setIssueDueDate] = useState(invoice.dueDate ?? "");
  const [voidReason, setVoidReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      setDialog(null);
      router.refresh();
    });
  }

  const showIssue = canIssue(invoice);
  const showVoid = canVoid(invoice);
  const showPayment = invoice.status === "sent" || invoice.status === "partially_paid";

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {showPayment ? (
          <button type="button" disabled={isPending} onClick={() => setDialog("payment")} className={primaryButtonAutoClass}>
            <Wallet aria-hidden className="h-4 w-4" />
            Record payment
          </button>
        ) : null}
        {showIssue ? (
          <button type="button" disabled={isPending} onClick={() => setDialog("issue")} className={primaryButtonAutoClass}>
            <Send aria-hidden className="h-4 w-4" />
            Issue invoice
          </button>
        ) : null}
        {showVoid ? (
          <button type="button" disabled={isPending} onClick={() => setDialog("void")} className={showIssue || showPayment ? destructiveGhostButtonAutoClass : secondaryButtonAutoClass}>
            Void
          </button>
        ) : null}
      </div>

      {error && dialog === null ? (
        <p className={errorBannerClass} role="alert">
          {error}
        </p>
      ) : null}

      {dialog === "issue" ? (
        <Dialog onClose={() => setDialog(null)} className="max-w-md" labelledBy="issue-invoice-title">
          <DialogTitle id="issue-invoice-title">Issue {formatInvoiceNumber(invoice.number)}?</DialogTitle>
          <DialogDescription>
            The total of {formatMoney(invoice.total)} becomes fixed and payments can be recorded. Nothing is sent to the customer from here yet.
          </DialogDescription>
          <div className="mt-4 space-y-1.5">
            <label htmlFor="issue-due-date" className={labelClass}>
              Due date
            </label>
            <input id="issue-due-date" type="date" value={issueDueDate} onChange={(e) => setIssueDueDate(e.target.value)} className={inputClass} />
            <p className="text-xs text-ink-3">Leave blank for 14 days from today.</p>
          </div>
          {error ? (
            <p className={`mt-4 ${errorBannerClass}`} role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <button type="button" onClick={() => setDialog(null)} className={ghostButtonClass} disabled={isPending}>
              Not yet
            </button>
            <button type="button" disabled={isPending} onClick={() => run(() => issueInvoice(invoice.id, { dueDate: issueDueDate || null }))} className={primaryButtonAutoClass}>
              {isPending ? "Issuing…" : "Issue invoice"}
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}

      {dialog === "void" ? (
        <Dialog onClose={() => setDialog(null)} className="max-w-md" labelledBy="void-invoice-title">
          <DialogTitle id="void-invoice-title">Void {formatInvoiceNumber(invoice.number)}?</DialogTitle>
          <DialogDescription>
            The invoice stays on record as void and its number is never reused. The job can be invoiced again afterwards. This cannot be undone.
          </DialogDescription>
          <div className="mt-4 space-y-1.5">
            <label htmlFor="void-reason" className={labelClass}>
              Reason <span className="font-normal text-ink-3">(optional)</span>
            </label>
            <input id="void-reason" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} className={inputClass} placeholder="Wrong amount, duplicate, work cancelled…" />
          </div>
          {error ? (
            <p className={`mt-4 ${errorBannerClass}`} role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <button type="button" onClick={() => setDialog(null)} className={ghostButtonClass} disabled={isPending}>
              Keep invoice
            </button>
            <button type="button" disabled={isPending} onClick={() => run(() => voidInvoice(invoice.id, voidReason))} className={destructiveButtonAutoClass}>
              {isPending ? "Voiding…" : "Void invoice"}
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}

      {dialog === "payment" ? <RecordPaymentDialog invoice={{ id: invoice.id, number: invoice.number, status: invoice.status, total: invoice.total, amountPaid: invoice.amountPaid, dueDate: invoice.dueDate }} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
