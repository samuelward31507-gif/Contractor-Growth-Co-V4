/**
 * Integration tests for the Payment Gate V1 Stripe webhook
 * (app/api/webhooks/stripe/route.ts) and the database-level protection it
 * relies on (20260921120000_organization_payment_status.sql's guard
 * trigger). Unlike a Server Action, this route handler takes a plain
 * NextRequest and never calls next/headers's cookies() (it uses
 * createServiceRoleClient, not the session-cookie client), so - unlike
 * signup()/startCheckout() elsewhere in this codebase - it CAN be invoked
 * directly from a bare node:test script, exactly like a real request.
 *
 * No live Stripe account or network call is needed: Stripe's own
 * `stripe.webhooks.generateTestHeaderString` computes a real, valid
 * signature locally against a test STRIPE_WEBHOOK_SECRET, and
 * `stripe.webhooks.constructEvent` verifies it the same way it would verify
 * a real webhook delivery - this tests the actual verification code, not a
 * mock of it.
 *
 * REQUIRES the payment_status column/trigger from
 * 20260921120000_organization_payment_status.sql to already be applied to
 * the target database - these tests will fail with a clear Postgres error
 * ("column organizations.payment_status does not exist") until that
 * migration has been run.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/api/webhooks/stripe/route.test.ts"
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Test-only values - never a real Stripe account. constructEvent only does
// local HMAC verification against this secret; no network call is made.
const TEST_WEBHOOK_SECRET = "whsec_test_secret_for_payment_gate_tests_only";
process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_placeholder_never_used_for_a_real_call_in_these_tests";

const { POST }: typeof import("./route") = require(path.join(REPO_ROOT, "app/api/webhooks/stripe/route.ts"));
const { getStripeClient }: typeof import("@/lib/billing/stripe") = require(path.join(REPO_ROOT, "lib/billing/stripe.ts"));
const { activateOrganizationPayment }: typeof import("@/lib/billing/activation") = require(
  path.join(REPO_ROOT, "lib/billing/activation.ts"),
);

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let organizationId: string;
let secondOrganizationId: string;
let subscriptionOrgId: string;

before(async () => {
  const { data: org, error } = await service.from("organizations").insert({ name: "Payment Gate Webhook Test Org" }).select("id, payment_status").single();
  if (error) throw error;
  organizationId = org!.id;

  const { data: org2, error: error2 } = await service.from("organizations").insert({ name: "Payment Gate Webhook Test Org (Isolation)" }).select("id").single();
  if (error2) throw error2;
  secondOrganizationId = org2!.id;

  // Dedicated org for subscription-lifecycle tests below, kept separate from
  // organizationId/secondOrganizationId so those tests' assertions never
  // depend on what earlier checkout.session.completed tests already did to
  // shared state.
  const { data: org3, error: error3 } = await service.from("organizations").insert({ name: "Payment Gate Webhook Test Org (Subscription Lifecycle)" }).select("id").single();
  if (error3) throw error3;
  subscriptionOrgId = org3!.id;
  const { error: activateErr } = await service.from("organizations").update({ payment_status: "active" }).eq("id", subscriptionOrgId);
  if (activateErr) throw activateErr;
});

after(async () => {
  await service.from("organizations").delete().eq("id", organizationId);
  await service.from("organizations").delete().eq("id", secondOrganizationId);
  await service.from("organizations").delete().eq("id", subscriptionOrgId);
});

function checkoutCompletedPayload(orgId: string) {
  return JSON.stringify({
    id: `evt_test_${orgId}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${orgId}`,
        object: "checkout.session",
        client_reference_id: orgId,
        metadata: { organization_id: orgId },
      },
    },
  });
}

/**
 * Matches the exact shape a real customer.subscription.updated/deleted
 * event delivers - data.object IS the Subscription itself, carrying
 * organization_id in its own metadata (see lib/billing/checkout.ts's
 * subscription_data.metadata), never a client_reference_id (Subscriptions
 * don't have one - that's a Checkout Session-only field).
 */
function subscriptionEventPayload(type: "customer.subscription.updated" | "customer.subscription.deleted", orgId: string | null, status: string = "active") {
  return JSON.stringify({
    id: `evt_test_${type}_${orgId}_${status}_${Math.random()}`,
    object: "event",
    type,
    data: {
      object: {
        id: `sub_test_${orgId}`,
        object: "subscription",
        status,
        metadata: orgId ? { organization_id: orgId } : {},
      },
    },
  });
}

function signedRequest(payload: string, secret: string = TEST_WEBHOOK_SECRET): Request {
  const stripe = getStripeClient();
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("http://localhost:3000/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    body: payload,
  });
}

test("1. a fresh organization defaults to payment_status = 'payment_required'", async () => {
  const { data } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();
  assert.equal(data?.payment_status, "payment_required");
});

test("2. an authenticated org admin cannot self-activate payment_status via a plain update (the security-critical property)", async () => {
  // Real end-to-end proof, not just code review: create a real user, make
  // them this org's owner exactly like bootstrap_organization would, sign
  // in as them, and attempt the exact write path an attacker (or a curious
  // legitimate customer) could try directly against PostgREST.
  const email = `payment-gate-admin-${Date.now()}@example.com`;
  const password = "a-real-test-password-123";
  const { data: userData, error: userError } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(userError, null);
  const userId = userData.user!.id;

  try {
    const { error: memberError } = await service.from("organization_members").insert({ organization_id: organizationId, user_id: userId, role: "owner" });
    assert.equal(memberError, null);

    const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({ email, password });
    assert.equal(signInError, null);

    const sessionClient = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${signIn.session!.access_token}` } },
    });

    const { error: selfActivateError } = await sessionClient.from("organizations").update({ payment_status: "active" }).eq("id", organizationId);
    assert.ok(selfActivateError, "a session-authenticated org admin must be rejected when attempting to change payment_status directly");

    const { data: afterAttempt } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();
    assert.equal(afterAttempt?.payment_status, "payment_required", "payment_status must be unchanged after the rejected client-side attempt");
  } finally {
    await service.from("organization_members").delete().eq("organization_id", organizationId).eq("user_id", userId);
    await service.auth.admin.deleteUser(userId);
  }
});

test("3. the same org admin CAN still update an ordinary column on their own organization (the guard is scoped to payment_status only)", async () => {
  const email = `payment-gate-admin2-${Date.now()}@example.com`;
  const password = "a-real-test-password-123";
  const { data: userData } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  const userId = userData.user!.id;

  try {
    await service.from("organization_members").insert({ organization_id: organizationId, user_id: userId, role: "owner" });
    const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
    const sessionClient = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${signIn.session!.access_token}` } },
    });

    const { error } = await sessionClient.from("organizations").update({ phone: "+15555550123" }).eq("id", organizationId);
    assert.equal(error, null, "unrelated columns must remain self-service, exactly as before this migration");
  } finally {
    await service.from("organization_members").delete().eq("organization_id", organizationId).eq("user_id", userId);
    await service.auth.admin.deleteUser(userId);
  }
});

test("4. a missing stripe-signature header is rejected with 401 and never activates the organization", async () => {
  const payload = checkoutCompletedPayload(organizationId);
  const request = new Request("http://localhost:3000/api/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  const response = await POST(request as never);
  assert.equal(response.status, 401);

  const { data } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();
  assert.equal(data?.payment_status, "payment_required");
});

test("5. an invalid signature is rejected with 401 and never activates the organization", async () => {
  const payload = checkoutCompletedPayload(organizationId);
  const request = new Request("http://localhost:3000/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=not-a-real-signature", "content-type": "application/json" },
    body: payload,
  });
  const response = await POST(request as never);
  assert.equal(response.status, 401);

  const { data } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();
  assert.equal(data?.payment_status, "payment_required");
});

test("6. a validly-signed checkout.session.completed activates exactly the referenced organization, and only that one", async () => {
  const request = signedRequest(checkoutCompletedPayload(organizationId));
  const response = await POST(request as never);
  assert.equal(response.status, 200);

  const { data: activated } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();
  assert.equal(activated?.payment_status, "active");

  const { data: untouched } = await service.from("organizations").select("payment_status").eq("id", secondOrganizationId).single();
  assert.equal(untouched?.payment_status, "payment_required", "a webhook for one organization must never activate a different organization");
});

test("7. a duplicate delivery of the same event is idempotent - no error, organization remains active, no duplicate side effect", async () => {
  const request = signedRequest(checkoutCompletedPayload(organizationId));
  const response = await POST(request as never);
  assert.equal(response.status, 200);

  const { data } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();
  assert.equal(data?.payment_status, "active");
});

test("8. activateOrganizationPayment itself is safely idempotent when called twice in a row", async () => {
  const first = await activateOrganizationPayment(service, secondOrganizationId);
  const second = await activateOrganizationPayment(service, secondOrganizationId);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const { data } = await service.from("organizations").select("payment_status").eq("id", secondOrganizationId).single();
  assert.equal(data?.payment_status, "active");
});

test("9. an unrelated event type (customer.updated) is acknowledged (200) but never touches payment_status", async () => {
  const payload = JSON.stringify({
    id: "evt_test_ignored",
    object: "event",
    type: "customer.updated",
    data: { object: { id: "cus_test", object: "customer" } },
  });
  const request = signedRequest(payload);
  const response = await POST(request as never);
  assert.equal(response.status, 200);

  // organizationId was activated to 'active' by test 6 - confirms an
  // unrelated event genuinely leaves it exactly where it was, not merely
  // that the route returns 200.
  const { data } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();
  assert.equal(data?.payment_status, "active");
});

// ===========================================================================
// SUBSCRIPTION LIFECYCLE HARDENING
// ===========================================================================

test("10. customer.subscription.updated with status 'past_due' suspends a previously-active organization", async () => {
  const request = signedRequest(subscriptionEventPayload("customer.subscription.updated", subscriptionOrgId, "past_due"));
  const response = await POST(request as never);
  assert.equal(response.status, 200);

  const { data } = await service.from("organizations").select("payment_status").eq("id", subscriptionOrgId).single();
  assert.equal(data?.payment_status, "suspended");
});

test("11. customer.subscription.updated with status 'unpaid' also suspends (retries exhausted, still not cancelled)", async () => {
  await service.from("organizations").update({ payment_status: "active" }).eq("id", subscriptionOrgId);
  const request = signedRequest(subscriptionEventPayload("customer.subscription.updated", subscriptionOrgId, "unpaid"));
  const response = await POST(request as never);
  assert.equal(response.status, 200);

  const { data } = await service.from("organizations").select("payment_status").eq("id", subscriptionOrgId).single();
  assert.equal(data?.payment_status, "suspended");
});

test("12. customer.subscription.updated with status 'active' recovers a suspended organization back to active", async () => {
  await service.from("organizations").update({ payment_status: "suspended" }).eq("id", subscriptionOrgId);
  const request = signedRequest(subscriptionEventPayload("customer.subscription.updated", subscriptionOrgId, "active"));
  const response = await POST(request as never);
  assert.equal(response.status, 200);

  const { data } = await service.from("organizations").select("payment_status").eq("id", subscriptionOrgId).single();
  assert.equal(data?.payment_status, "active");
});

test("13. customer.subscription.updated with status 'canceled' cancels the organization", async () => {
  await service.from("organizations").update({ payment_status: "active" }).eq("id", subscriptionOrgId);
  const request = signedRequest(subscriptionEventPayload("customer.subscription.updated", subscriptionOrgId, "canceled"));
  const response = await POST(request as never);
  assert.equal(response.status, 200);

  const { data } = await service.from("organizations").select("payment_status").eq("id", subscriptionOrgId).single();
  assert.equal(data?.payment_status, "cancelled");
});

test("14. customer.subscription.deleted cancels the organization regardless of prior state", async () => {
  await service.from("organizations").update({ payment_status: "active" }).eq("id", subscriptionOrgId);
  const request = signedRequest(subscriptionEventPayload("customer.subscription.deleted", subscriptionOrgId));
  const response = await POST(request as never);
  assert.equal(response.status, 200);

  const { data } = await service.from("organizations").select("payment_status").eq("id", subscriptionOrgId).single();
  assert.equal(data?.payment_status, "cancelled");
});

test("15. customer.subscription.updated with status 'incomplete' is acknowledged but never mutates payment_status - a transitional/ambiguous status is never guessed at", async () => {
  await service.from("organizations").update({ payment_status: "active" }).eq("id", subscriptionOrgId);
  const request = signedRequest(subscriptionEventPayload("customer.subscription.updated", subscriptionOrgId, "incomplete"));
  const response = await POST(request as never);
  assert.equal(response.status, 200);

  const { data } = await service.from("organizations").select("payment_status").eq("id", subscriptionOrgId).single();
  assert.equal(data?.payment_status, "active", "an ambiguous/transitional status must never change payment_status either direction");
});

test("16. a subscription event with no resolvable organization id is acknowledged (200) but changes nothing", async () => {
  const request = signedRequest(subscriptionEventPayload("customer.subscription.updated", null, "past_due"));
  const response = await POST(request as never);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reason, "missing_organization_id");
});

test("17. a duplicate delivery of the same subscription-cancellation event is idempotent - no error, still cancelled, no double side effect", async () => {
  await service.from("organizations").update({ payment_status: "active" }).eq("id", subscriptionOrgId);
  const payload = subscriptionEventPayload("customer.subscription.deleted", subscriptionOrgId);

  const first = await POST(signedRequest(payload) as never);
  assert.equal(first.status, 200);
  const second = await POST(signedRequest(payload) as never);
  assert.equal(second.status, 200);

  const { data } = await service.from("organizations").select("payment_status").eq("id", subscriptionOrgId).single();
  assert.equal(data?.payment_status, "cancelled");
});

test("18. a subscription event for one organization never changes a different organization's payment_status", async () => {
  await service.from("organizations").update({ payment_status: "active" }).eq("id", subscriptionOrgId);
  const { data: before } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();

  const request = signedRequest(subscriptionEventPayload("customer.subscription.deleted", subscriptionOrgId));
  const response = await POST(request as never);
  assert.equal(response.status, 200);

  const { data: after } = await service.from("organizations").select("payment_status").eq("id", organizationId).single();
  assert.equal(after?.payment_status, before?.payment_status, "an unrelated organization must be completely untouched");
});
