import { formatMoney } from "@/lib/invoices/domain";
import type { PublicInvoice } from "./public-invoice";

/**
 * Phase 1C, Step 5: what the public app/pay/[token] page shows, as a pure
 * function of the public invoice projection (lib/payments/public-invoice.ts,
 * which has already stripped every internal field) and the page's own
 * `?checkout=` code. Unit-tested in pay-page-view.test.ts; the page only
 * renders this.
 *
 * The page never claims an invoice is paid until the database says so:
 * returning from Stripe with ?checkout=success shows "confirming" until the
 * Connect webhook has recorded the payment and the invoice reads as paid.
 */

export type PayPageState = "unavailable" | "paid" | "payable" | "offline";

export type PayPageNotice = { tone: "success" | "info" | "error"; message: string };

export type PayPageView = {
  state: PayPageState;
  notice: PayPageNotice | null;
  /** Present for every state except "unavailable". */
  invoice: {
    organizationName: string;
    organizationPhoneDisplay: string | null;
    organizationPhoneHref: string | null;
    label: string;
    title: string;
    balanceDueLabel: string;
    totalLabel: string;
    amountPaidLabel: string | null;
    dueDateLabel: string | null;
    paidDateLabel: string | null;
    overdue: boolean;
  } | null;
};

/** (206) 555-0142 from an E.164 US number; anything else renders as stored (the quote page's rule). */
export function formatPhone(value: string): string {
  const match = value.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : value;
}

/** A calendar date (YYYY-MM-DD) rendered without any timezone shift. */
export function formatCalendarDate(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function formatInstantDate(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function describePayPage(invoice: PublicInvoice | null, params: Record<string, string | string[] | undefined>): PayPageView {
  if (!invoice) return { state: "unavailable", notice: null, invoice: null };

  const phone = invoice.organizationPhone;
  const details = {
    organizationName: invoice.organizationName,
    organizationPhoneDisplay: phone ? formatPhone(phone) : null,
    organizationPhoneHref: phone && /^\+?[0-9]{7,15}$/.test(phone) ? `tel:${phone}` : null,
    label: invoice.label,
    title: invoice.title,
    balanceDueLabel: formatMoney(invoice.balanceDue),
    totalLabel: formatMoney(invoice.total),
    amountPaidLabel: invoice.amountPaid > 0 ? formatMoney(invoice.amountPaid) : null,
    dueDateLabel: invoice.dueDate ? formatCalendarDate(invoice.dueDate) : null,
    paidDateLabel: invoice.paidAt ? formatInstantDate(invoice.paidAt) : null,
    overdue: invoice.overdue,
  };

  const paid = invoice.status === "paid" || invoice.onlinePayment.reason === "paid";
  const state: PayPageState = paid ? "paid" : invoice.onlinePayment.available ? "payable" : "offline";
  const contact = details.organizationPhoneDisplay ? `${invoice.organizationName} at ${details.organizationPhoneDisplay}` : invoice.organizationName;

  const code = typeof params.checkout === "string" ? params.checkout : null;
  let notice: PayPageNotice | null = null;
  if (code === "success") {
    notice = paid
      ? { tone: "success", message: "Payment received. Thank you!" }
      : { tone: "info", message: "Thanks - Stripe is confirming your payment. This page will show it as paid in a moment." };
  } else if (code === "cancelled") {
    notice = paid ? null : { tone: "info", message: "Payment cancelled - you haven't been charged." };
  } else if (code === "paid") {
    notice = { tone: "info", message: "This invoice has already been paid." };
  } else if (code === "unavailable") {
    notice = paid ? null : { tone: "error", message: `Online payment isn't available right now. Please contact ${contact} to pay.` };
  } else if (code === "error") {
    notice = paid ? null : { tone: "error", message: "We couldn't start the payment. Please try again." };
  }

  return { state, notice, invoice: details };
}
