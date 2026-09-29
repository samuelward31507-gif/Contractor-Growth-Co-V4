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

test("a test-mode key is allowed everywhere", () => {
  for (const extra of [{}, { VERCEL: "1", VERCEL_ENV: "preview" }, { VERCEL: "1", VERCEL_ENV: "production" }, { NODE_ENV: "production" }]) {
    assert.equal(assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: TEST_KEY, ...extra })), "test");
  }
});

test("a live key is refused locally, in tests, and in Vercel Preview", () => {
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: LIVE_KEY })), "live_key_outside_vercel_production");
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: LIVE_KEY, NODE_ENV: "production" })), "live_key_outside_vercel_production");
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: LIVE_KEY, VERCEL: "1", VERCEL_ENV: "preview" })), "live_key_outside_vercel_production");
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: LIVE_KEY, VERCEL_ENV: "production" })), "live_key_outside_vercel_production");
  expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: "rk_live_guard_unit_test_placeholder" })), "live_key_outside_vercel_production");
});

test("a live key is allowed only in Vercel Production", () => {
  assert.equal(assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: LIVE_KEY, VERCEL: "1", VERCEL_ENV: "production" })), "live");
});

test("a missing or unrecognized key is refused everywhere, including Vercel Production", () => {
  for (const extra of [{}, { VERCEL: "1", VERCEL_ENV: "production" }]) {
    expectRefusal(() => assertStripeKeyAllowedForPayments(env({ ...extra })), "missing");
    expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: "", ...extra })), "missing");
    expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: "pk_live_guard_unit_test_placeholder", ...extra })), "unrecognized");
    expectRefusal(() => assertStripeKeyAllowedForPayments(env({ STRIPE_SECRET_KEY: "not_a_key_guard_unit_test_placeholder", ...extra })), "unrecognized");
  }
});

test("getPaymentsStripeClient applies the guard on every call and never builds a client for a refused key", () => {
  expectRefusal(() => getPaymentsStripeClient(env({ STRIPE_SECRET_KEY: LIVE_KEY })), "live_key_outside_vercel_production");
  const first = getPaymentsStripeClient(env({ STRIPE_SECRET_KEY: TEST_KEY }));
  assert.equal(getPaymentsStripeClient(env({ STRIPE_SECRET_KEY: TEST_KEY })), first, "same key reuses the client");
  // A later refused key is still refused even though a client is cached.
  expectRefusal(() => getPaymentsStripeClient(env({ STRIPE_SECRET_KEY: LIVE_KEY })), "live_key_outside_vercel_production");
  const second = getPaymentsStripeClient(env({ STRIPE_SECRET_KEY: "sk_test_guard_unit_test_other" }));
  assert.notEqual(second, first, "a changed key builds a new client");
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
