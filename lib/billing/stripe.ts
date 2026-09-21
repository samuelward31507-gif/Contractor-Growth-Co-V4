import Stripe from "stripe";

/**
 * Payment Gate V1 - the one Stripe client for the whole app, created lazily
 * (not at module load) so a missing STRIPE_SECRET_KEY only fails the
 * specific request that needed Stripe, never the build or an unrelated
 * request. Mirrors lib/supabase/service.ts's own lazy-singleton shape for
 * its one trusted, server-only client. STRIPE_SECRET_KEY is never
 * NEXT_PUBLIC_-prefixed and this file is only ever imported from server
 * code (a server action and the webhook route handler), so the key can
 * never reach the browser bundle.
 */
let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }
  if (!stripeClient) {
    stripeClient = new Stripe(apiKey);
  }
  return stripeClient;
}
