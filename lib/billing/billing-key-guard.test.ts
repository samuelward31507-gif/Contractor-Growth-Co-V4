/**
 * Final Batch 4: Stripe live/test safety for the subscription-billing key and
 * webhook events. Placeholder strings only - no real key, and no Stripe call.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/billing/billing-key-guard.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertStripeKeyAllowedForBilling, stripeEventModeMatches } from "./billing-key-guard";
import { StripeKeyGuardError } from "./stripe-mode-guard";

const TEST_KEY = "sk_test_batch4_guard_placeholder";
const LIVE_KEY = "sk_live_batch4_guard_placeholder";
const PROD = { VERCEL: "1", VERCEL_ENV: "production" };
const env = (values: Record<string, string | undefined>) => values as unknown as NodeJS.ProcessEnv;
const refused = (fn: () => unknown, reason: string) =>
  assert.throws(fn, (error: unknown) => error instanceof StripeKeyGuardError && error.reason === reason && !error.message.includes("batch4_guard_placeholder"));

test("billing: live key only in Vercel Production", () => {
  assert.equal(assertStripeKeyAllowedForBilling(env({ STRIPE_SECRET_KEY: LIVE_KEY, ...PROD })), "live");
  refused(() => assertStripeKeyAllowedForBilling(env({ STRIPE_SECRET_KEY: LIVE_KEY })), "live_key_outside_vercel_production");
  refused(() => assertStripeKeyAllowedForBilling(env({ STRIPE_SECRET_KEY: LIVE_KEY, VERCEL: "1", VERCEL_ENV: "preview" })), "live_key_outside_vercel_production");
  refused(() => assertStripeKeyAllowedForBilling(env({ STRIPE_SECRET_KEY: "rk_live_batch4_guard_placeholder", NODE_ENV: "production" })), "live_key_outside_vercel_production");
});

test("billing: test key everywhere except Vercel Production, where it needs the explicit opt-in", () => {
  for (const extra of [{}, { VERCEL: "1", VERCEL_ENV: "preview" }, { NODE_ENV: "production" }, { VERCEL_ENV: "production" }]) {
    assert.equal(assertStripeKeyAllowedForBilling(env({ STRIPE_SECRET_KEY: TEST_KEY, ...extra })), "test");
  }
  refused(() => assertStripeKeyAllowedForBilling(env({ STRIPE_SECRET_KEY: TEST_KEY, ...PROD })), "test_key_in_vercel_production");
  refused(() => assertStripeKeyAllowedForBilling(env({ STRIPE_SECRET_KEY: TEST_KEY, ...PROD, STRIPE_ALLOW_TEST_MODE_IN_PRODUCTION: "yes" })), "test_key_in_vercel_production");
  assert.equal(assertStripeKeyAllowedForBilling(env({ STRIPE_SECRET_KEY: TEST_KEY, ...PROD, STRIPE_ALLOW_TEST_MODE_IN_PRODUCTION: "true" })), "test");
});

test("billing: missing or unrecognized keys are refused everywhere", () => {
  for (const extra of [{}, PROD]) {
    refused(() => assertStripeKeyAllowedForBilling(env({ ...extra })), "missing");
    refused(() => assertStripeKeyAllowedForBilling(env({ STRIPE_SECRET_KEY: "pk_live_batch4_guard_placeholder", ...extra })), "unrecognized");
    refused(() => assertStripeKeyAllowedForBilling(env({ STRIPE_SECRET_KEY: "whsec_batch4_guard_placeholder", ...extra })), "unrecognized");
  }
});

test("webhook events only act in the key's own mode", () => {
  assert.equal(stripeEventModeMatches(false, "test"), true);
  assert.equal(stripeEventModeMatches(true, "live"), true);
  assert.equal(stripeEventModeMatches(true, "test"), false, "a live event on a test deployment");
  assert.equal(stripeEventModeMatches(false, "live"), false, "a test event on a live deployment");
  assert.equal(stripeEventModeMatches(undefined, "test"), false, "no livemode is never assumed");
  assert.equal(stripeEventModeMatches(null, "live"), false);
});

test("wiring: the billing client and both v1 webhooks are guarded", () => {
  assert.match(readFileSync("lib/billing/stripe.ts", "utf8"), /assertStripeKeyAllowedForBilling\(process\.env\);\n\s+const apiKey = process\.env\.STRIPE_SECRET_KEY as string;/);
  const billingWebhook = readFileSync("app/api/webhooks/stripe/route.ts", "utf8");
  assert.match(billingWebhook, /if \(!stripeEventModeMatches\(event\.livemode, keyMode\)\) \{/);
  assert.match(billingWebhook, /"Stripe mode mismatch\." \}, \{ status: 400 \}/);
  assert.match(readFileSync("lib/payments/connect-webhook.ts", "utf8"), /if \(keyMode && !stripeEventModeMatches\(event\.livemode, keyMode\)\) \{/);
});
