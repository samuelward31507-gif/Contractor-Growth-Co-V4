"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { MessageSquare, Send, Wallet } from "lucide-react";
import { destructiveButtonAutoClass, destructiveGhostButtonAutoClass, errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { canIssue, canVoid, formatInvoiceNumber, formatMoney, type InvoiceStatus } from "@/lib/invoices/domain";
import { issueInvoice, sendInvoiceToCustomer, voidInvoice } from "../../actions";
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
 * Phase 3G-2a: what the page resolved for "Send to customer" (see
 * lib/invoices/delivery.ts getInvoiceDeliveryState). Null blockedMessage
 * means sending is allowed now; the server re-checks everything on click.
 */
export type InvoiceDeliveryView = {
  blockedMessage: string | null;
  maskedPhone: string | null;
  lastDeliveredLabel: string | null;
  /** The text links to online card payment when it is available; otherwise to the invoice to view only. */
  cardPayment: boolean;
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
 *
 * Phase 3G-2a: sent and partially paid invoices also get "Send to customer"
 * ("Send again" after a successful send), always behind a confirmation. When
 * sending isn't possible the button is disabled and the reason is shown.
 */
export function InvoiceActions({ invoice, delivery }: { invoice: InvoiceActionsInvoice; delivery?: InvoiceDeliveryView }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"issue" | "void" | "payment" | "send" | null>(null);
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
  const showSend = showPayment && delivery !== undefined;
  const sendBlocked = delivery?.blockedMessage ?? null;
  const isResend = Boolean(delivery?.lastDeliveredLabel);

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {showSend ? (
          <button type="button" disabled={isPending || sendBlocked !== null} onClick={() => setDialog("send")} className={secondaryButtonAutoClass}>
            <MessageSquare aria-hidden className="h-4 w-4" />
            {isResend ? "Send again" : "Send to customer"}
          </button>
        ) : null}
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

      {showSend && sendBlocked ? <p className="text-xs text-ink-3">{sendBlocked}</p> : null}
      {showSend && delivery?.lastDeliveredLabel ? <p className="text-xs text-ink-3">Last sent to customer {delivery.lastDeliveredLabel}</p> : null}

      {error && dialog === null ? (
        <p className={errorBannerClass} role="alert">
          {error}
        </p>
      ) : null}

      {dialog === "issue" ? (
        <Dialog onClose={() => setDialog(null)} className="max-w-md" labelledBy="issue-invoice-title">
          <DialogTitle id="issue-invoice-title">Issue {formatInvoiceNumber(invoice.number)}?</DialogTitle>
          <DialogDescription>
            The total of {formatMoney(invoice.total)} becomes fixed and payments can be recorded. Issuing doesn&apos;t text the customer - use Send to customer afterwards.
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

      {dialog === "send" && delivery ? (
        <Dialog onClose={() => setDialog(null)} className="max-w-md" labelledBy="send-invoice-title">
          <DialogTitle id="send-invoice-title">
            Send {formatInvoiceNumber(invoice.number)} {isResend ? "again?" : "to the customer?"}
          </DialogTitle>
          <DialogDescription>
            We&apos;ll text {delivery.maskedPhone ?? "the customer"} the invoice number, balance due, due date and {delivery.cardPayment ? "a secure payment link" : "a link to view the invoice (online card payment isn't set up, so it asks them to contact you to pay)"}.
            {isResend ? ` It was last sent ${delivery.lastDeliveredLabel}, so the customer will get another text.` : ""}
          </DialogDescription>
          {error ? (
            <p className={`mt-4 ${errorBannerClass}`} role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <button type="button" onClick={() => setDialog(null)} className={ghostButtonClass} disabled={isPending}>
              Cancel
            </button>
            <button type="button" disabled={isPending} onClick={() => run(() => sendInvoiceToCustomer(invoice.id))} className={primaryButtonAutoClass}>
              {isPending ? "Sending…" : "Send text"}
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
