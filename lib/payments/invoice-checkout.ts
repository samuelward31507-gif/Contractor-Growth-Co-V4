import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toCents } from "@/lib/invoices/domain";
import { paymentsStripe, stripeErrorMessage, type PaymentsDeps } from "./connect";
import { loadPayableInvoiceByToken, onlinePaymentAvailability } from "./public-invoice";

/**
 * Phase 1C: the Stripe Checkout Session behind the public pay page's
 * "Pay now" button.
 *
 * Approved shape: a DIRECT charge on the contractor's connected account
 * (`stripeAccount` request option), card only, for the invoice's full current
 * balance due, with no application fee. The session and its PaymentIntent
 * both carry invoice_id and organization_id metadata (plus the expected
 * amount), which the Connect webhook verifies before it records anything
 * (lib/payments/online-payment.ts).
 *
 * Nothing here writes to the database or decides that an invoice is paid -
 * only the webhook records a payment, through the existing accounting
 * triggers. The amount comes from the database's own balance_due column at
 * the moment the session is created, never from the request.
 *
 * Idempotency: repeated clicks within one 30-minute window for the same
 * balance state resolve to the SAME session. The Stripe idempotency key is
 * invoice + amount paid + balance + window, and every parameter - including
 * expires_at, pinned to the window - is identical within it, as Stripe
 * requires for a replayed key. A new window, or any payment that changes the
 * balance, produces a new session. expires_at is always 30-60 minutes out
 * (Stripe's minimum is 30), so a stale session cannot be paid much later.
 */

export const INVOICE_PAYMENT_KIND = "invoice_payment";
export const CHECKOUT_WINDOW_MS = 30 * 60 * 1000;
const CHECKOUT_MIN_LIFETIME_SECONDS = 30 * 60;

export type InvoiceCheckoutFailure = "not_found" | "already_paid" | "not_accepting_online_payments" | "invalid_request" | "stripe_error";

export type InvoiceCheckoutOutcome =
  | { ok: true; url: string; sessionId: string; reason?: undefined; error?: undefined }
  | { ok: false; reason: InvoiceCheckoutFailure; error: string };

function normalizeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function checkoutWindow(now: Date): { bucket: number; expiresAt: number } {
  const bucket = Math.floor(now.getTime() / CHECKOUT_WINDOW_MS);
  const windowEndSeconds = ((bucket + 1) * CHECKOUT_WINDOW_MS) / 1000;
  return { bucket, expiresAt: windowEndSeconds + CHECKOUT_MIN_LIFETIME_SECONDS };
}

export async function createInvoiceCheckoutSession(
  service: SupabaseClient,
  input: { token: string; baseUrl: string; now?: Date },
  deps: PaymentsDeps = {},
): Promise<InvoiceCheckoutOutcome> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) return { ok: false, reason: "invalid_request", error: "Online payment is not configured correctly." };

  const invoice = await loadPayableInvoiceByToken(service, input.token);
  if (!invoice) return { ok: false, reason: "not_found", error: "This invoice link is not valid." };

  const availability = onlinePaymentAvailability(invoice);
  if (!availability.available) {
    return availability.reason === "paid"
      ? { ok: false, reason: "already_paid", error: "This invoice has already been paid." }
      : { ok: false, reason: "not_accepting_online_payments", error: "This business isn't accepting online payments right now. Please contact them to pay." };
  }

  let amountCents: number;
  let amountPaidCents: number;
  try {
    amountCents = toCents(invoice.balanceDue);
    amountPaidCents = toCents(invoice.amountPaid);
    // The generated column and its inputs must agree before money is asked for.
    if (toCents(invoice.total) - amountPaidCents !== amountCents) throw new Error("balance_due does not equal total - amount_paid");
  } catch (error) {
    console.error("[payments][checkout] invoice amounts are inconsistent", { invoiceId: invoice.invoiceId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, reason: "invalid_request", error: "This invoice can't be paid online right now. Please contact the business." };
  }
  if (amountCents <= 0) return { ok: false, reason: "already_paid", error: "This invoice has already been paid." };

  const accountId = invoice.connectAccountId as string;
  const { bucket, expiresAt } = checkoutWindow(input.now ?? new Date());
  const metadata = {
    trackpr_kind: INVOICE_PAYMENT_KIND,
    invoice_id: invoice.invoiceId,
    organization_id: invoice.organizationId,
    expected_amount_cents: String(amountCents),
  };
  const payUrl = `${baseUrl}/pay/${input.token}`;

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: { name: `Invoice ${invoice.label}`, description: invoice.title.slice(0, 500) || undefined },
        },
      },
    ],
    client_reference_id: invoice.invoiceId,
    metadata,
    payment_intent_data: { metadata },
    success_url: `${payUrl}?checkout=success`,
    cancel_url: `${payUrl}?checkout=cancelled`,
    expires_at: expiresAt,
  };

  try {
    const session = await paymentsStripe(deps).checkout.sessions.create(params, {
      stripeAccount: accountId,
      idempotencyKey: `trackpr-invoice-checkout-${invoice.invoiceId}-${amountPaidCents}-${amountCents}-${bucket}`,
    });
    if (!session.url || !session.id) {
      console.error("[payments][checkout] Stripe returned a session without a url", { invoiceId: invoice.invoiceId, sessionId: session.id });
      return { ok: false, reason: "stripe_error", error: "We couldn't start the payment. Please try again." };
    }
    return { ok: true, url: session.url, sessionId: session.id };
  } catch (error) {
    console.error("[payments][checkout] failed to create checkout session", { invoiceId: invoice.invoiceId, accountId, error: stripeErrorMessage(error) });
    return { ok: false, reason: "stripe_error", error: "We couldn't start the payment. Please try again." };
  }
}
