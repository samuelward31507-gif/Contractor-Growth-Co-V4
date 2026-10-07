import Stripe from "stripe";

/**
 * Phase 1C live-key safety check.
 *
 * Every Phase 1C code path that talks to Stripe on a contractor's behalf
 * (Connect onboarding and status sync, invoice Checkout Sessions, the
 * Connect webhook) must obtain its client from getPaymentsStripeClient()
 * below, never from lib/billing/stripe.ts's getStripeClient() and never via
 * `new Stripe(...)`. A structural test enforces that for the Phase 1C
 * directories.
 *
 * Two Stripe accounts: Trackpr's own subscription billing stays on the
 * existing account (STRIPE_SECRET_KEY, read only by lib/billing/stripe.ts).
 * Connect and online invoice payments run on a separate Connect platform
 * account, whose key is STRIPE_CONNECT_SECRET_KEY. There is no fallback from
 * one to the other: without STRIPE_CONNECT_SECRET_KEY, payments are refused,
 * and a Connect key identical to the billing key is refused too - that is
 * almost certainly the billing key pasted into the wrong variable, which
 * would route payments through the billing account.
 *
 * The rule: a live Stripe secret key (sk_live_ / rk_live_) is refused unless
 * the process is explicitly running as a Vercel Production deployment
 * (VERCEL === "1" and VERCEL_ENV === "production", both set by Vercel
 * itself). Anywhere else - a developer machine, a test run, a Vercel
 * Preview deployment - only a test-mode key (sk_test_ / rk_test_) is
 * accepted. A missing or unrecognized key is refused everywhere, so a typo
 * can never silently fall through to either mode.
 *
 * The check runs on every call, not once at module load, so a key or
 * environment change is never masked by a cached client.
 *
 * Final Batch 4 (production operations hardening):
 *   - the reverse mix is refused too: a TEST key in Vercel Production would
 *     silently take fake payments (and, for billing, activate organizations
 *     that never paid). It is allowed only with the explicit opt-in
 *     STRIPE_ALLOW_TEST_MODE_IN_PRODUCTION=true (e.g. a deliberate
 *     pre-launch production rehearsal);
 *   - the subscription-billing key (STRIPE_SECRET_KEY) gets the same rules
 *     in its own module (lib/billing/billing-key-guard.ts), so this payments
 *     guard still never reads the billing key except to compare;
 *   - a webhook event whose livemode differs from the key's mode is refused
 *     (stripeEventModeMatches) - a webhook endpoint registered in the wrong
 *     Stripe mode can never move real state. Webhook signing secrets carry
 *     no mode of their own, so the event's livemode is the only signal.
 */

export type StripeKeyMode = "test" | "live";

export class StripeKeyGuardError extends Error {
  readonly reason: "missing" | "unrecognized" | "same_as_billing_key" | "live_key_outside_vercel_production" | "test_key_in_vercel_production";

  constructor(reason: StripeKeyGuardError["reason"], message: string) {
    super(message);
    this.name = "StripeKeyGuardError";
    this.reason = reason;
  }
}

export function classifyStripeSecretKey(key: string | undefined | null): StripeKeyMode | null {
  if (!key) return null;
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  return null;
}

export function isVercelProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL === "1" && env.VERCEL_ENV === "production";
}

/** The explicit, documented opt-in for test-mode Stripe keys in Vercel Production. */
export function allowsTestModeInProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STRIPE_ALLOW_TEST_MODE_IN_PRODUCTION === "true";
}

export function refuseTestKeyInProduction(variable: string, mode: StripeKeyMode, env: NodeJS.ProcessEnv): void {
  if (mode === "test" && isVercelProduction(env) && !allowsTestModeInProduction(env)) {
    throw new StripeKeyGuardError(
      "test_key_in_vercel_production",
      `Refusing to use a test-mode ${variable} in Vercel Production. Configure the live key, or set STRIPE_ALLOW_TEST_MODE_IN_PRODUCTION=true for a deliberate test-mode rehearsal.`,
    );
  }
}

/**
 * Returns the mode of STRIPE_CONNECT_SECRET_KEY when it may be used for
 * Phase 1C payments, and throws StripeKeyGuardError otherwise. The error
 * message never includes either key.
 */
export function assertStripeKeyAllowedForPayments(env: NodeJS.ProcessEnv = process.env): StripeKeyMode {
  const key = env.STRIPE_CONNECT_SECRET_KEY;
  if (!key) {
    throw new StripeKeyGuardError("missing", "STRIPE_CONNECT_SECRET_KEY is not configured.");
  }

  const mode = classifyStripeSecretKey(key);
  if (!mode) {
    throw new StripeKeyGuardError("unrecognized", "STRIPE_CONNECT_SECRET_KEY is not a recognized Stripe secret or restricted key.");
  }

  // The billing key is read here only to compare - it is never used.
  if (key === env.STRIPE_SECRET_KEY) {
    throw new StripeKeyGuardError(
      "same_as_billing_key",
      "STRIPE_CONNECT_SECRET_KEY must be the Connect platform account's key, separate from the subscription-billing STRIPE_SECRET_KEY.",
    );
  }

  if (mode === "live" && !isVercelProduction(env)) {
    throw new StripeKeyGuardError(
      "live_key_outside_vercel_production",
      "Refusing to use a live Stripe key outside Vercel Production. Use a test-mode key (sk_test_) for local development, tests and previews.",
    );
  }

  refuseTestKeyInProduction("STRIPE_CONNECT_SECRET_KEY", mode, env);
  return mode;
}

/** Final Batch 4: a webhook event may only act when its livemode matches the mode of the key that verifies it. */
export function stripeEventModeMatches(eventLivemode: boolean | null | undefined, keyMode: StripeKeyMode): boolean {
  return typeof eventLivemode === "boolean" && eventLivemode === (keyMode === "live");
}

let paymentsClient: { key: string; client: Stripe } | null = null;

/**
 * The only sanctioned Stripe client for Phase 1C Connect/Checkout code, on
 * the Connect platform account (STRIPE_CONNECT_SECRET_KEY).
 * Re-checks the guard on every call; rebuilds the client if the key changed.
 */
export function getPaymentsStripeClient(env: NodeJS.ProcessEnv = process.env): Stripe {
  assertStripeKeyAllowedForPayments(env);
  const key = env.STRIPE_CONNECT_SECRET_KEY as string;
  if (!paymentsClient || paymentsClient.key !== key) {
    paymentsClient = { key, client: new Stripe(key) };
  }
  return paymentsClient.client;
}
