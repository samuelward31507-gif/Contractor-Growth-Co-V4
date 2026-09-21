/**
 * Unit tests for the checkout-session helper's defensive configuration
 * checks - no real Stripe network call is made in any of these (they all
 * throw/reject before one would happen). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/billing/checkout.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

const { createOrganizationCheckoutSession }: typeof import("./checkout") = require(path.join(REPO_ROOT, "lib/billing/checkout.ts"));

test("1. throws (never calls Stripe) when STRIPE_SETUP_PRICE_ID/STRIPE_SUBSCRIPTION_PRICE_ID are not configured", async () => {
  const previousSetup = process.env.STRIPE_SETUP_PRICE_ID;
  const previousSubscription = process.env.STRIPE_SUBSCRIPTION_PRICE_ID;
  const previousKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SETUP_PRICE_ID;
  delete process.env.STRIPE_SUBSCRIPTION_PRICE_ID;
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  try {
    await assert.rejects(createOrganizationCheckoutSession("11111111-1111-1111-1111-111111111111"));
  } finally {
    if (previousSetup === undefined) delete process.env.STRIPE_SETUP_PRICE_ID;
    else process.env.STRIPE_SETUP_PRICE_ID = previousSetup;
    if (previousSubscription === undefined) delete process.env.STRIPE_SUBSCRIPTION_PRICE_ID;
    else process.env.STRIPE_SUBSCRIPTION_PRICE_ID = previousSubscription;
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
  }
});

test("2. throws when STRIPE_SECRET_KEY is not configured", async () => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    await assert.rejects(createOrganizationCheckoutSession("11111111-1111-1111-1111-111111111111"));
  } finally {
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
  }
});
