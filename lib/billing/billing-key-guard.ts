import { StripeKeyGuardError, classifyStripeSecretKey, isVercelProduction, refuseTestKeyInProduction, stripeEventModeMatches, type StripeKeyMode } from "./stripe-mode-guard";

export { stripeEventModeMatches };

/**
 * Final Batch 4: the environment/key-mode guard for Trackpr's own
 * subscription-billing Stripe key (STRIPE_SECRET_KEY) - the same rules the
 * Connect payments key already had (lib/billing/stripe-mode-guard.ts), kept
 * in its own module so billing and payments stay separate:
 *   - missing or unrecognized key: refused everywhere;
 *   - live key (sk_live_/rk_live_): only in Vercel Production;
 *   - test key in Vercel Production: refused unless
 *     STRIPE_ALLOW_TEST_MODE_IN_PRODUCTION=true (a test key there would let
 *     a fake checkout activate an organization that never paid).
 * Never includes the key in an error.
 */
export function assertStripeKeyAllowedForBilling(env: NodeJS.ProcessEnv = process.env): StripeKeyMode {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeKeyGuardError("missing", "STRIPE_SECRET_KEY is not configured.");
  const mode = classifyStripeSecretKey(key);
  if (!mode) throw new StripeKeyGuardError("unrecognized", "STRIPE_SECRET_KEY is not a recognized Stripe secret or restricted key.");
  if (mode === "live" && !isVercelProduction(env)) {
    throw new StripeKeyGuardError(
      "live_key_outside_vercel_production",
      "Refusing to use a live STRIPE_SECRET_KEY outside Vercel Production. Use a test-mode key (sk_test_) for local development, tests and previews.",
    );
  }
  refuseTestKeyInProduction("STRIPE_SECRET_KEY", mode, env);
  return mode;
}
