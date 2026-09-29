/**
 * Phase 1C, Step 1 (subscription webhook guard): decides whether a
 * checkout.session.completed event delivered to /api/webhooks/stripe is a
 * Trackpr SUBSCRIPTION checkout - the only kind that may ever activate an
 * organization's payment_status.
 *
 * Before this guard the webhook activated whatever organization a
 * Checkout Session named in client_reference_id or metadata.organization_id,
 * for ANY session. Phase 1C adds a second, unrelated kind of Checkout: a
 * contractor's customer paying an invoice. Those are payment-mode sessions
 * created on the contractor's connected Stripe account (direct charges), so
 * their events carry `account`. Neither may ever flip a contractor's Trackpr
 * subscription status - a customer paying an invoice must never reactivate
 * a suspended organization.
 *
 * Both conditions are required:
 *   - session.mode === "subscription" (createOrganizationCheckoutSession in
 *     lib/billing/checkout.ts is the only session Trackpr creates in this
 *     mode), and
 *   - no connected-account context (the event has no `account`; Trackpr's
 *     own subscription checkout always runs on the platform account).
 * Anything else - payment mode, setup mode, a missing mode, any connected
 * account - is not a subscription checkout.
 */
export type CheckoutCompletedContext = {
  /** Stripe sets this only on events that happened on a connected account. */
  account?: string | null;
  session: { mode?: string | null };
};

export function isTrackprSubscriptionCheckout(context: CheckoutCompletedContext): boolean {
  if (context.account) return false;
  return context.session.mode === "subscription";
}
