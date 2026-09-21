import { headers } from "next/headers";
import { getStripeClient } from "./stripe";
import { resolveAppBaseUrl } from "@/lib/automation/sms";

/**
 * Payment Gate V1 - resolves an absolute base URL for Stripe's
 * success_url/cancel_url. Prefers the already-established
 * resolveAppBaseUrl() (APP_BASE_URL, falling back to Vercel's own
 * production-URL env var) so this doesn't introduce a second "what's our
 * own URL" convention; only falls back to the incoming request's own
 * Host header when neither is set (e.g. local development), which never
 * happens in the real Vercel deployment this app actually runs in.
 */
async function resolveCheckoutBaseUrl(): Promise<string> {
  const configured = resolveAppBaseUrl();
  if (configured) return configured;

  const headerList = await headers();
  const host = headerList.get("host") ?? "localhost:3000";
  const proto = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Creates a Stripe Checkout Session for exactly one organization, billing
 * both the one-time setup fee and the recurring management subscription in
 * a single session (Stripe's subscription-mode Checkout natively supports
 * mixing a recurring price with a one-time price as separate line items -
 * no second charge/flow needed). `organizationId` must already be
 * server-verified by the caller (never accepted from the browser here) -
 * see app/onboarding/actions.ts's startCheckout, which resolves it from the
 * caller's own session via getUserOrganization, exactly like every other
 * organization-scoped action in this codebase. Stamping it into both
 * `client_reference_id` and `metadata.organization_id` gives the webhook
 * two independent, non-client-controlled ways to recover which
 * organization to activate - see app/api/webhooks/stripe/route.ts.
 *
 * Pricing itself is never hardcoded here - both Price IDs come from env
 * vars configured against whatever Products/Prices actually exist in the
 * Stripe account, so the $2,500 setup / $1,497/month figures live in
 * Stripe, not in this code.
 */
export async function createOrganizationCheckoutSession(organizationId: string) {
  const stripe = getStripeClient();
  const setupPriceId = process.env.STRIPE_SETUP_PRICE_ID;
  const subscriptionPriceId = process.env.STRIPE_SUBSCRIPTION_PRICE_ID;

  if (!setupPriceId || !subscriptionPriceId) {
    throw new Error("STRIPE_SETUP_PRICE_ID and STRIPE_SUBSCRIPTION_PRICE_ID must both be configured.");
  }

  const baseUrl = await resolveCheckoutBaseUrl();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [
      { price: subscriptionPriceId, quantity: 1 },
      { price: setupPriceId, quantity: 1 },
    ],
    client_reference_id: organizationId,
    metadata: { organization_id: organizationId },
    subscription_data: { metadata: { organization_id: organizationId } },
    success_url: `${baseUrl}/onboarding?checkout=success`,
    cancel_url: `${baseUrl}/onboarding?checkout=cancelled`,
  });

  return session;
}
