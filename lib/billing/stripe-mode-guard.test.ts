/**
 * Phase 1C live-key safety check - lib/billing/stripe-mode-guard.ts.
 *
 * Pure unit tests: every case passes an explicit env object, nothing reads
 * .env.local, and no Stripe API call is ever made (constructing a Stripe
 * client performs no network request). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/billing/stripe-mode-guard.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  StripeKeyGuardError,
  assertStripeKeyAllowedForPayments,
  classifyStripeSecretKey,
  getPaymentsStripeClient,
  isVercelProduction,
} from "./stripe-mode-guard";

const TEST_KEY = "sk_test_guard_unit_test_placeholder";
const LIVE_KEY = "sk_live_guard_unit_test_placeholder";

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function expectRefusal(fn: () => unknown, reason: StripeKeyGuardError["reason"]) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof StripeKeyGuardError, "throws StripeKeyGuardError");
    assert.equal(error.reason, reason);
    assert.ok(!error.message.includes("guard_unit_test_placeholder"), "the key never appears in the message");
    return true;
  });
}

test("classifies secret and restricted keys by mode, and nothing else", () => {
  assert.equal(classifyStripeSecretKey("sk_test_abc"), "test");
  assert.equal(classifyStripeSecretKey("rk_test_abc"), "test");
  assert.equal(classifyStripeSecretKey("sk_live_abc"), "live");
  assert.equal(classifyStripeSecretKey("rk_live_abc"), "live");
  for (const other of [undefined, null, "", "pk_test_abc", "pk_live_abc", "whsec_abc", "sk_abc", "SK_LIVE_abc", " sk_live_abc"]) {
    assert.equal(classifyStripeSecretKey(other), null, String(other));
  }
});

test("Vercel Production requires both VERCEL=1 and VERCEL_ENV=production", () => {
  assert.equal(isVercelProduction(env({ VERCEL: "1", VERCEL_ENV: "production" })), true);
  assert.equal(isVercelProduction(env({ VERCEL: "1", VERCEL_ENV: "preview" })), false);
  assert.equal(isVercelProduction(env({ VERCEL: "1", VERCEL_ENV: "development" })), false);
  assert.equal(isVercelProduction(env({ VERCEL_ENV: "production" })), false, "VERCEL_ENV alone is not enough");
  assert.equal(isVercelProduction(env({ VERCEL: "1" })), false);
  assert.equal(isVercelProduction(env({})), false);
});

// Final Batch 4: a test key is allowed everywhere EXCEPT Vercel Production,
// where it needs the explicit STRIPE_ALLOW_TEST_MODE_IN_PRODUCTION=true opt-in.
test("a test-mode key is allowed everywhere outside Vercel Production", () => {
  for (const extra of [{}, { VERCEL: "1", VERCEL_ENV: "preview" }, { VERCEL_ENV: "production" }, { NODE_ENV: "production" }]) {
    assert.equal(assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: TEST_KEY, ...extra })), "test");
  }
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: TEST_KEY, VERCEL: "1", VERCEL_ENV: "production" })), "test_key_in_vercel_production");
  assert.equal(assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: TEST_KEY, VERCEL: "1", VERCEL_ENV: "production", STRIPE_ALLOW_TEST_MODE_IN_PRODUCTION: "true" })), "test");
});

test("a live key is refused locally, in tests, and in Vercel Preview", () => {
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: LIVE_KEY })), "live_key_outside_vercel_production");
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: LIVE_KEY, NODE_ENV: "production" })), "live_key_outside_vercel_production");
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: LIVE_KEY, VERCEL: "1", VERCEL_ENV: "preview" })), "live_key_outside_vercel_production");
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: LIVE_KEY, VERCEL_ENV: "production" })), "live_key_outside_vercel_production");
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: "rk_live_guard_unit_test_placeholder" })), "live_key_outside_vercel_production");
});

test("a live key is allowed only in Vercel Production", () => {
  assert.equal(assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: LIVE_KEY, VERCEL: "1", VERCEL_ENV: "production" })), "live");
});

test("a missing or unrecognized key is refused everywhere, including Vercel Production", () => {
  for (const extra of [{}, { VERCEL: "1", VERCEL_ENV: "production" }]) {
    expectRefusal(() => assertStripeKeyAllowedForPayments(env({ ...extra })), "missing");
    expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: "", ...extra })), "missing");
    expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: "pk_live_guard_unit_test_placeholder", ...extra })), "unrecognized");
    expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: "not_a_key_guard_unit_test_placeholder", ...extra })), "unrecognized");
  }
});

test("getPaymentsStripeClient applies the guard on every call and never builds a client for a refused key", () => {
  expectRefusal(() => getPaymentsStripeClient(env({ STRIPE_CONNECT_SECRET_KEY: LIVE_KEY })), "live_key_outside_vercel_production");
  const first = getPaymentsStripeClient(env({ STRIPE_CONNECT_SECRET_KEY: TEST_KEY }));
  assert.equal(getPaymentsStripeClient(env({ STRIPE_CONNECT_SECRET_KEY: TEST_KEY })), first, "same key reuses the client");
  // A later refused key is still refused even though a client is cached.
  expectRefusal(() => getPaymentsStripeClient(env({ STRIPE_CONNECT_SECRET_KEY: LIVE_KEY })), "live_key_outside_vercel_production");
  const second = getPaymentsStripeClient(env({ STRIPE_CONNECT_SECRET_KEY: "sk_test_guard_unit_test_other" }));
  assert.notEqual(second, first, "a changed key builds a new client");
});

// ---------------------------------------------------------------------------
// Two Stripe accounts: subscription billing (STRIPE_SECRET_KEY) and the
// Connect platform (STRIPE_CONNECT_SECRET_KEY). Payments use only the Connect
// key, with no fallback to the billing key, and refuse a Connect key that is
// the billing key.
// ---------------------------------------------------------------------------

const BILLING_TEST_KEY = "sk_test_guard_unit_test_placeholder_billing";
const BILLING_LIVE_KEY = "sk_live_guard_unit_test_placeholder_billing";

test("payments are refused when only the billing STRIPE_SECRET_KEY is configured - no fallback", () => {
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: BILLING_TEST_KEY })), "missing");
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: BILLING_LIVE_KEY, VERCEL: "1", VERCEL_ENV: "production" })), "missing");
  expectRefusal(() => getPaymentsStripeClient(env({ STRIPE_SECRET_KEY: BILLING_TEST_KEY })), "missing");
  assert.throws(
    () => getPaymentsStripeClient(env({ STRIPE_SECRET_KEY: BILLING_TEST_KEY })),
    (error: unknown) => error instanceof StripeKeyGuardError && error.message.includes("STRIPE_CONNECT_SECRET_KEY") && !error.message.includes("guard_unit_test_placeholder"),
  );
});

test("payments classify and build from STRIPE_CONNECT_SECRET_KEY, never from the billing key", () => {
  // The Connect key decides the mode: a live billing key next to a test
  // Connect key is fine anywhere, and a test billing key does not rescue a
  // live Connect key outside Vercel Production.
  assert.equal(assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: TEST_KEY, STRIPE_SECRET_KEY: BILLING_LIVE_KEY })), "test");
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: LIVE_KEY, STRIPE_SECRET_KEY: BILLING_TEST_KEY })), "live_key_outside_vercel_production");
  assert.equal(assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: LIVE_KEY, STRIPE_SECRET_KEY: BILLING_LIVE_KEY, VERCEL: "1", VERCEL_ENV: "production" })), "live");

  // The client follows the Connect key only: changing the billing key keeps
  // the cached client, changing the Connect key builds a new one.
  const connectA = "sk_test_guard_unit_test_placeholder_connect_a";
  const connectB = "sk_test_guard_unit_test_placeholder_connect_b";
  const first = getPaymentsStripeClient(env({ STRIPE_CONNECT_SECRET_KEY: connectA, STRIPE_SECRET_KEY: BILLING_TEST_KEY }));
  assert.equal(getPaymentsStripeClient(env({ STRIPE_CONNECT_SECRET_KEY: connectA, STRIPE_SECRET_KEY: "sk_test_guard_unit_test_placeholder_billing_other" })), first, "a billing-key change does not affect the payments client");
  assert.notEqual(getPaymentsStripeClient(env({ STRIPE_CONNECT_SECRET_KEY: connectB, STRIPE_SECRET_KEY: BILLING_TEST_KEY })), first, "a Connect-key change builds a new payments client");
});

test("a Connect key identical to the billing key is refused, in every environment, without revealing it", () => {
  for (const extra of [{}, { VERCEL: "1", VERCEL_ENV: "preview" }, { VERCEL: "1", VERCEL_ENV: "production" }]) {
    expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: TEST_KEY, STRIPE_SECRET_KEY: TEST_KEY, ...extra })), "same_as_billing_key");
    expectRefusal(() => getPaymentsStripeClient(env({ STRIPE_CONNECT_SECRET_KEY: TEST_KEY, STRIPE_SECRET_KEY: TEST_KEY, ...extra })), "same_as_billing_key");
  }
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: LIVE_KEY, STRIPE_SECRET_KEY: LIVE_KEY, VERCEL: "1", VERCEL_ENV: "production" })), "same_as_billing_key");
  assert.throws(
    () => assertStripeKeyAllowedForPayments(env({ STRIPE_CONNECT_SECRET_KEY: TEST_KEY, STRIPE_SECRET_KEY: TEST_KEY })),
    (error: unknown) => error instanceof StripeKeyGuardError && /separate from the subscription-billing STRIPE_SECRET_KEY/.test(error.message),
  );
});

test("subscription billing still uses STRIPE_SECRET_KEY only - the Connect key never stands in for it", async () => {
  const saved = { billing: process.env.STRIPE_SECRET_KEY, connect: process.env.STRIPE_CONNECT_SECRET_KEY };
  delete process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_CONNECT_SECRET_KEY = "sk_test_guard_unit_test_placeholder_connect_only";
  try {
    const { getStripeClient } = await import("./stripe");
    assert.throws(() => getStripeClient(), /STRIPE_SECRET_KEY is not configured/);
  } finally {
    for (const [name, value] of [["STRIPE_SECRET_KEY", saved.billing], ["STRIPE_CONNECT_SECRET_KEY", saved.connect]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// Structural: Phase 1C Connect/Checkout code may only reach Stripe through the
// guarded client. These directories hold Phase 1C code as it is added; the
// check applies to every file in them.
// ---------------------------------------------------------------------------

const PHASE_1C_DIRS = ["lib/payments", "app/pay", "app/api/webhooks/stripe-connect", "app/api/payments"];

function listSourceFiles(dir: string): string[] {
  const root = path.join(process.cwd(), dir);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(path.relative(process.cwd(), full)));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("structural: Phase 1C code never uses the unguarded Stripe client or constructs its own", () => {
  const offenders: string[] = [];
  for (const dir of PHASE_1C_DIRS) {
    for (const file of listSourceFiles(dir)) {
      const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (/\bgetStripeClient\b/.test(source) || /new\s+Stripe\s*\(/.test(source) || /from\s+["']@\/lib\/billing\/stripe["']/.test(source)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
  }
  assert.deepEqual(offenders, [], "use getPaymentsStripeClient() from lib/billing/stripe-mode-guard");
});

// Comments stripped, so documentation may name either variable freely.
function codeOf(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("structural: Phase 1C code never reads the billing STRIPE_SECRET_KEY", () => {
  const offenders: string[] = [];
  for (const dir of PHASE_1C_DIRS) {
    for (const file of listSourceFiles(dir)) {
      if (/\bSTRIPE_SECRET_KEY\b/.test(codeOf(path.relative(process.cwd(), file)))) offenders.push(path.relative(process.cwd(), file));
    }
  }
  assert.deepEqual(offenders, [], "Phase 1C payments use STRIPE_CONNECT_SECRET_KEY via getPaymentsStripeClient()");
});

test("structural: the payments guard builds from STRIPE_CONNECT_SECRET_KEY and reads the billing key only to compare", () => {
  const code = codeOf("lib/billing/stripe-mode-guard.ts");
  // Environment reads only - the refusal message may name the variable.
  const billingReads = code.match(/\benv\.STRIPE_SECRET_KEY\b|\[\s*["']STRIPE_SECRET_KEY["']\s*\]/g) ?? [];
  assert.equal(billingReads.length, 1, "exactly one read of STRIPE_SECRET_KEY");
  assert.match(code, /key === env\.STRIPE_SECRET_KEY/, "that one reference is the identical-key comparison");
  assert.match(code, /const key = env\.STRIPE_CONNECT_SECRET_KEY;/, "the guard classifies the Connect key");
  assert.match(code, /const key = env\.STRIPE_CONNECT_SECRET_KEY as string;\s*\n\s*if \(!paymentsClient/, "the client is built from the Connect key");
});

test("structural: subscription billing never reads STRIPE_CONNECT_SECRET_KEY or the payments client", () => {
  for (const file of ["lib/billing/stripe.ts", "lib/billing/checkout.ts", "app/api/webhooks/stripe/route.ts"]) {
    const code = codeOf(file);
    assert.doesNotMatch(code, /STRIPE_CONNECT_SECRET_KEY/, `${file} must not read the Connect key`);
    assert.doesNotMatch(code, /getPaymentsStripeClient|stripe-mode-guard/, `${file} must not use the payments client`);
  }
  assert.match(codeOf("lib/billing/stripe.ts"), /process\.env\.STRIPE_SECRET_KEY/, "getStripeClient reads the billing key");
  assert.match(codeOf("lib/billing/checkout.ts"), /getStripeClient\(\)/, "subscription checkout uses the billing client");
  assert.match(codeOf("app/api/webhooks/stripe/route.ts"), /getStripeClient\(\)/, "the signup webhook uses the billing client");
});

test("structural: the guard module itself is the only Phase 1C construction site", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/billing/stripe-mode-guard.ts"), "utf8");
  const getter = source.slice(source.indexOf("export function getPaymentsStripeClient"));
  assert.ok(getter.indexOf("assertStripeKeyAllowedForPayments(env)") >= 0, "the getter calls the guard");
  assert.ok(getter.indexOf("assertStripeKeyAllowedForPayments(env)") < getter.indexOf("new Stripe("), "the guard runs before any client is built");
});

// ---------------------------------------------------------------------------
// Structural: Phase 1C manages connected accounts with Accounts v2 only.
// Stripe no longer supports Accounts v1 creation for new Connect
// integrations; the v1 account resources (accounts.create/retrieve/update,
// accountLinks.create) must not appear in Phase 1C code - only
// `.v2.core.accounts.*` and `.v2.core.accountLinks.*`.
// ---------------------------------------------------------------------------

test("structural: Phase 1C code never calls the Accounts v1 account or account-link APIs", () => {
  const offenders: string[] = [];
  for (const dir of PHASE_1C_DIRS) {
    for (const file of listSourceFiles(dir)) {
      const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // Any `.accounts.` / `.accountLinks.` call that is not under `.v2.core`.
      if (/(?<!\.v2\.core)\.accounts\.(create|retrieve|update|del|list)\s*\(|(?<!\.v2\.core)\.accountLinks\.create\s*\(/.test(source)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
  }
  assert.deepEqual(offenders, [], "use stripe.v2.core.accounts / stripe.v2.core.accountLinks");
});

test("structural: the v1-API detector itself flags v1 calls and passes v2 calls", () => {
  const detector = /(?<!\.v2\.core)\.accounts\.(create|retrieve|update|del|list)\s*\(|(?<!\.v2\.core)\.accountLinks\.create\s*\(/;
  assert.equal(detector.test("paymentsStripe(deps).accounts.create({})"), true);
  assert.equal(detector.test("stripe.accountLinks.create({})"), true);
  assert.equal(detector.test("stripe.accounts.retrieve(id)"), true);
  assert.equal(detector.test("paymentsStripe(deps).v2.core.accounts.create({})"), false);
  assert.equal(detector.test("stripe.v2.core.accounts.retrieve(id, { include })"), false);
  assert.equal(detector.test("stripe.v2.core.accountLinks.create({})"), false);
});
