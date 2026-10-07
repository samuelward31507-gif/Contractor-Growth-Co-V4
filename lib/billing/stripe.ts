import Stripe from "stripe";
import { assertStripeKeyAllowedForBilling } from "./billing-key-guard";

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
let stripeClient: { key: string; client: Stripe } | null = null;

/**
 * Final Batch 4: every call re-checks the environment/key-mode guard
 * (lib/billing/billing-key-guard.ts assertStripeKeyAllowedForBilling - a
 * live key outside Vercel Production, or a test key in it without the
 * explicit opt-in, is refused) and rebuilds the client if the key changed,
 * so a key or environment change is never masked by a cached client.
 */
export function getStripeClient(): Stripe {
  assertStripeKeyAllowedForBilling(process.env);
  const apiKey = process.env.STRIPE_SECRET_KEY as string;
  if (!stripeClient || stripeClient.key !== apiKey) {
    stripeClient = { key: apiKey, client: new Stripe(apiKey) };
  }
  return stripeClient.client;
}
