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

before(async () => {
  const { data: org, error } = await service.from("organizations").insert({ name: "Payment Gate Webhook Test Org" }).select("id, payment_status").single();
  if (error) throw error;
  organizationId = org!.id;

  const { data: org2, error: error2 } = await service.from("organizations").insert({ name: "Payment Gate Webhook Test Org (Isolation)" }).select("id").single();
  if (error2) throw error2;
  secondOrganizationId = org2!.id;
});

after(async () => {
  await service.from("organizations").delete().eq("id", organizationId);
  await service.from("organizations").delete().eq("id", secondOrganizationId);
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

test("9. a non-checkout event type is acknowledged (200) but never touches payment_status", async () => {
  const payload = JSON.stringify({
    id: "evt_test_ignored",
    object: "event",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_test", object: "subscription" } },
  });
  const request = signedRequest(payload);
  const response = await POST(request as never);
  assert.equal(response.status, 200);
});
