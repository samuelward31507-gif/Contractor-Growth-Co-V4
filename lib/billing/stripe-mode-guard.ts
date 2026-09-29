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
 */

export type StripeKeyMode = "test" | "live";

export class StripeKeyGuardError extends Error {
  readonly reason: "missing" | "unrecognized" | "live_key_outside_vercel_production";

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

/**
 * Returns the mode of STRIPE_SECRET_KEY when it may be used for Phase 1C
 * payments, and throws StripeKeyGuardError otherwise. The error message
 * never includes the key itself.
 */
export function assertStripeKeyAllowedForPayments(env: NodeJS.ProcessEnv = process.env): StripeKeyMode {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new StripeKeyGuardError("missing", "STRIPE_SECRET_KEY is not configured.");
  }

  const mode = classifyStripeSecretKey(key);
  if (!mode) {
    throw new StripeKeyGuardError("unrecognized", "STRIPE_SECRET_KEY is not a recognized Stripe secret or restricted key.");
  }

  if (mode === "live" && !isVercelProduction(env)) {
    throw new StripeKeyGuardError(
      "live_key_outside_vercel_production",
      "Refusing to use a live Stripe key outside Vercel Production. Use a test-mode key (sk_test_) for local development, tests and previews.",
    );
  }

  return mode;
}

let paymentsClient: { key: string; client: Stripe } | null = null;

/**
 * The only sanctioned Stripe client for Phase 1C Connect/Checkout code.
 * Re-checks the guard on every call; rebuilds the client if the key changed.
 */
export function getPaymentsStripeClient(env: NodeJS.ProcessEnv = process.env): Stripe {
  assertStripeKeyAllowedForPayments(env);
  const key = env.STRIPE_SECRET_KEY as string;
  if (!paymentsClient || paymentsClient.key !== key) {
    paymentsClient = { key, client: new Stripe(key) };
  }
  return paymentsClient.client;
}
