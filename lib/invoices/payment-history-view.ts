import type { InvoiceStatus } from "./domain";

/**
 * Phase 1C cleanup: which action a payment-history row offers - a pure
 * function unit-tested in payment-history-view.test.ts; the component only
 * renders it.
 *
 * An online card payment (card_online) never offers Reverse: the invoice
 * service refuses that reversal (refunds are made in the contractor's own
 * Stripe dashboard, and Trackpr reconciles them through an incident), so the
 * row points to Stripe instead of presenting an action that would be
 * rejected. The reversal rules themselves are unchanged and live in
 * lib/invoices/service.ts and the database.
 */

export type PaymentRowAction = "reverse" | "refund_in_stripe" | null;

/** The same dashboard Settings' "Online payments" section links to (lib/payments/online-payments-view.ts). */
export const STRIPE_REFUND_URL = "https://dashboard.stripe.com";

const REVERSIBLE_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set(["sent", "partially_paid", "paid"]);

export function paymentRowAction(input: { method: string; isReversal: boolean; isReversed: boolean; invoiceStatus: InvoiceStatus }): PaymentRowAction {
  if (input.isReversal || input.isReversed || !REVERSIBLE_INVOICE_STATUSES.has(input.invoiceStatus)) return null;
  return input.method === "card_online" ? "refund_in_stripe" : "reverse";
}
