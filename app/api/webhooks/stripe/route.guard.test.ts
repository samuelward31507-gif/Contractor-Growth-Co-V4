/**
 * Phase 1C, Step 1: the subscription webhook guard on
 * app/api/webhooks/stripe/route.ts.
 *
 * Environment safety (deliberate): this file never reads .env.local, never
 * uses a real Stripe key, and never reaches a real database. The route's
 * service-role Supabase client is pointed at a fake PostgREST server on
 * 127.0.0.1 that records every request, so "did the route try to write?" is
 * observed directly. Stripe signatures are real (generateTestHeaderString +
 * constructEvent are local HMAC - no network call). The test aborts before
 * importing the route if the Supabase URL is anything but the local fake.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/api/webhooks/stripe/route.guard.test.ts"
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

type RecordedRequest = { method: string; path: string; body: Record<string, unknown> | null };
const requests: RecordedRequest[] = [];

const fakeSupabase = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    requests.push({ method: req.method ?? "", path: req.url ?? "", body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
    // Every write this route makes is a bare PATCH with no returned rows.
    res.writeHead(204).end();
  });
});

const TEST_WEBHOOK_SECRET = "whsec_phase1c_guard_tests_only";
const ORG = "11111111-1111-4111-8111-111111111111";

let POST: typeof import("./route").POST;
let getStripeClient: typeof import("@/lib/billing/stripe").getStripeClient;
let isTrackprSubscriptionCheckout: typeof import("@/lib/billing/subscription-checkout").isTrackprSubscriptionCheckout;

before(async () => {
  await new Promise<void>((resolve) => fakeSupabase.listen(0, "127.0.0.1", resolve));
  const { port } = fakeSupabase.address() as AddressInfo;

  // Set BEFORE the route (and its lazily-created clients) are loaded.
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key-for-local-fake-only";
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder_phase1c_guard_never_calls_stripe";

  assert.match(process.env.NEXT_PUBLIC_SUPABASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/, "refusing to run against anything but the local fake");
  assert.ok(process.env.STRIPE_SECRET_KEY.startsWith("sk_test_"), "refusing to run with a non-test Stripe key");

  ({ POST } = require(path.join(REPO_ROOT, "app/api/webhooks/stripe/route.ts")));
  ({ getStripeClient } = require(path.join(REPO_ROOT, "lib/billing/stripe.ts")));
  ({ isTrackprSubscriptionCheckout } = require(path.join(REPO_ROOT, "lib/billing/subscription-checkout.ts")));
});

after(() => {
  fakeSupabase.close();
});

beforeEach(() => {
  requests.length = 0;
});

function checkoutCompleted(options: { mode?: string | null; account?: string | null; customer?: string; subscription?: string }) {
  const session: Record<string, unknown> = {
    id: "cs_test_guard",
    object: "checkout.session",
    client_reference_id: ORG,
    metadata: { organization_id: ORG },
    customer: options.customer ?? null,
    subscription: options.subscription ?? null,
  };
  if (options.mode !== undefined) session.mode = options.mode;
  const event: Record<string, unknown> = { id: `evt_guard_${Math.random()}`, object: "event", livemode: false, type: "checkout.session.completed", data: { object: session } };
  if (options.account) event.account = options.account;
  return JSON.stringify(event);
}

function signed(payload: string): Request {
  const signature = getStripeClient().webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET });
  return new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body: payload });
}

const organizationWrites = () => requests.filter((r) => r.path.startsWith("/rest/v1/organizations") && r.method !== "GET");

// ---------------------------------------------------------------------------
// The pure guard
// ---------------------------------------------------------------------------

test("guard: only a subscription-mode session with no connected account is a Trackpr subscription checkout", () => {
  assert.equal(isTrackprSubscriptionCheckout({ session: { mode: "subscription" } }), true);
  assert.equal(isTrackprSubscriptionCheckout({ account: null, session: { mode: "subscription" } }), true);
  assert.equal(isTrackprSubscriptionCheckout({ session: { mode: "payment" } }), false);
  assert.equal(isTrackprSubscriptionCheckout({ session: { mode: "setup" } }), false);
  assert.equal(isTrackprSubscriptionCheckout({ session: { mode: null } }), false);
  assert.equal(isTrackprSubscriptionCheckout({ session: {} }), false, "a missing mode is never assumed to be subscription");
  assert.equal(isTrackprSubscriptionCheckout({ account: "acct_contractor", session: { mode: "subscription" } }), false, "any connected-account context disqualifies, even in subscription mode");
  assert.equal(isTrackprSubscriptionCheckout({ account: "acct_contractor", session: { mode: "payment" } }), false);
});

// ---------------------------------------------------------------------------
// The route, end to end against the local fake
// ---------------------------------------------------------------------------

test("a normal Trackpr subscription checkout still activates exactly the referenced organization and persists its Stripe identifiers", async () => {
  const response = await POST(signed(checkoutCompleted({ mode: "subscription", customer: "cus_guard", subscription: "sub_guard" })) as never);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  const writes = organizationWrites();
  assert.equal(writes.length, 2);
  assert.equal(writes[0].method, "PATCH");
  assert.equal(writes[0].path, `/rest/v1/organizations?id=eq.${ORG}`);
  assert.deepEqual(writes[0].body, { payment_status: "active" });
  assert.deepEqual(writes[1].body, { stripe_customer_id: "cus_guard", stripe_subscription_id: "sub_guard" });
});

test("a payment-mode Checkout Session (e.g. a customer paying an invoice) cannot activate an organization or touch its Stripe identifiers", async () => {
  const response = await POST(signed(checkoutCompleted({ mode: "payment", customer: "cus_x", subscription: undefined })) as never);
  assert.equal(response.status, 200, "acknowledged, so Stripe does not retry forever");
  assert.deepEqual(await response.json(), { ok: true, ignored: "not_trackpr_subscription_checkout" });
  assert.equal(requests.length, 0, "no database request of any kind");
});

test("setup-mode and mode-less sessions cannot activate an organization", async () => {
  for (const mode of ["setup", null]) {
    const response = await POST(signed(checkoutCompleted({ mode })) as never);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ignored, "not_trackpr_subscription_checkout");
  }
  assert.equal(requests.length, 0);
});

test("a connected-account event cannot activate an organization - not even a subscription-mode one naming a real organization", async () => {
  for (const mode of ["payment", "subscription"]) {
    const response = await POST(signed(checkoutCompleted({ mode, account: "acct_contractor_123" })) as never);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ignored: "not_trackpr_subscription_checkout" });
  }
  assert.equal(requests.length, 0);
});

test("unchanged: a bad signature is still rejected with 401 before anything else", async () => {
  const request = new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": "t=1,v1=bad" }, body: checkoutCompleted({ mode: "subscription" }) });
  const response = await POST(request as never);
  assert.equal(response.status, 401);
  assert.equal(requests.length, 0);
});

test("unchanged: subscription lifecycle events still move payment_status exactly as before", async () => {
  const payload = JSON.stringify({ id: "evt_guard_sub", object: "event", livemode: false, type: "customer.subscription.updated", data: { object: { id: "sub_guard", object: "subscription", status: "past_due", metadata: { organization_id: ORG } } } });
  const response = await POST(signed(payload) as never);
  assert.equal(response.status, 200);
  const writes = organizationWrites();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { payment_status: "suspended" });

  requests.length = 0;
  const deleted = JSON.stringify({ id: "evt_guard_del", object: "event", livemode: false, type: "customer.subscription.deleted", data: { object: { id: "sub_guard", object: "subscription", status: "canceled", metadata: { organization_id: ORG } } } });
  assert.equal((await POST(signed(deleted) as never)).status, 200);
  assert.deepEqual(organizationWrites()[0].body, { payment_status: "cancelled" });
});

test("unchanged: a subscription checkout with no resolvable organization is acknowledged and changes nothing", async () => {
  const payload = JSON.stringify({ id: "evt_guard_noorg", object: "event", livemode: false, type: "checkout.session.completed", data: { object: { id: "cs_noorg", object: "checkout.session", mode: "subscription", client_reference_id: null, metadata: {} } } });
  const response = await POST(signed(payload) as never);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: false, reason: "missing_organization_id" });
  assert.equal(requests.length, 0);
});

test("unchanged: unrelated event types are acknowledged and ignored", async () => {
  const payload = JSON.stringify({ id: "evt_guard_other", object: "event", livemode: false, type: "customer.updated", data: { object: { id: "cus_guard", object: "customer" } } });
  const response = await POST(signed(payload) as never);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ignored: "customer.updated" });
  assert.equal(requests.length, 0);
});

test("structural: the guard runs before any organization is resolved or activated in the checkout branch", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "app/api/webhooks/stripe/route.ts"), "utf8");
  const branch = source.slice(source.indexOf('event.type === "checkout.session.completed"'));
  const guardAt = branch.indexOf("isTrackprSubscriptionCheckout({ account: event.account, session })");
  assert.ok(guardAt > 0, "guard present in the checkout branch");
  assert.ok(guardAt < branch.indexOf("client_reference_id"), "guard precedes organization resolution");
  assert.ok(guardAt < branch.indexOf("activateOrganizationPayment("), "guard precedes activation");
});

// Final Batch 4: an event from the other Stripe mode never moves real state.
test("a LIVE-mode event on this TEST-key deployment is refused (400) and writes nothing", async () => {
  const payload = JSON.stringify({ id: "evt_guard_live", object: "event", livemode: true, type: "checkout.session.completed", data: { object: { id: "cs_live", object: "checkout.session", mode: "subscription", client_reference_id: ORG, metadata: { organization_id: ORG } } } });
  const response = await POST(signed(payload) as never);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error: "Stripe mode mismatch." });
  assert.equal(organizationWrites().length, 0);
});
