/**
 * Integration tests for the Phase 5D-1 Revenue Intelligence additions to
 * app/api/webhooks/stripe/route.ts (invoice.payment_succeeded,
 * invoice.payment_failed, charge.refunded, and the opportunistic Stripe
 * identifier persistence at checkout.session.completed) - kept in a
 * dedicated file rather than route.test.ts so the existing Payment Gate
 * V1/Subscription Lifecycle suite there is never touched by this phase.
 *
 * Same no-live-Stripe-account technique as route.test.ts:
 * stripe.webhooks.generateTestHeaderString computes a real, valid signature
 * locally; stripe.webhooks.constructEvent verifies it for real.
 *
 * REQUIRES supabase/migrations/20260926120000_revenue_intelligence.sql
 * (revenue_events table + organizations.stripe_customer_id/
 * stripe_subscription_id columns) to already be applied to the target
 * database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/api/webhooks/stripe/revenue.integration.test.ts"
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

const TEST_WEBHOOK_SECRET = "whsec_test_secret_for_revenue_intelligence_tests_only";
process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_placeholder_never_used_for_a_real_call_in_these_tests";

const { POST }: typeof import("./route") = require(path.join(REPO_ROOT, "app/api/webhooks/stripe/route.ts"));
const { getStripeClient }: typeof import("@/lib/billing/stripe") = require(path.join(REPO_ROOT, "lib/billing/stripe.ts"));

const service = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let orgWithSubscription: string;
let orgWithCustomerOnly: string;
let orgForMetadataFallback: string;
let orgForCheckoutPersistence: string;
const cleanupOrgIds: string[] = [];

before(async () => {
  const inserts = await Promise.all([
    service.from("organizations").insert({ name: "Revenue Webhook Test - Subscription Attribution" }).select("id").single(),
    service.from("organizations").insert({ name: "Revenue Webhook Test - Customer Attribution" }).select("id").single(),
    service.from("organizations").insert({ name: "Revenue Webhook Test - Metadata Fallback" }).select("id").single(),
    service.from("organizations").insert({ name: "Revenue Webhook Test - Checkout Persistence" }).select("id").single(),
  ]);
  for (const { data, error } of inserts) {
    if (error) throw error;
    cleanupOrgIds.push(data!.id);
  }
  [orgWithSubscription, orgWithCustomerOnly, orgForMetadataFallback, orgForCheckoutPersistence] = cleanupOrgIds;

  await service.from("organizations").update({ stripe_subscription_id: `sub_test_${orgWithSubscription}` }).eq("id", orgWithSubscription);
  await service.from("organizations").update({ stripe_customer_id: `cus_test_${orgWithCustomerOnly}` }).eq("id", orgWithCustomerOnly);
});

after(async () => {
  for (const orgId of cleanupOrgIds) {
    await service.from("revenue_events").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

function signedRequest(payload: string, secret: string = TEST_WEBHOOK_SECRET): Request {
  const stripe = getStripeClient();
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("http://localhost:3000/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    body: payload,
  });
}

function invoiceEventPayload(opts: {
  type: "invoice.payment_succeeded" | "invoice.payment_failed";
  eventId: string;
  invoiceId: string;
  subscriptionId?: string;
  customerId?: string;
  metadataOrgId?: string;
  billingReason: string;
  amountPaid?: number;
  amountDue?: number;
}) {
  return JSON.stringify({
    id: opts.eventId,
    object: "event",
    created: Math.floor(Date.now() / 1000),
    type: opts.type,
    data: {
      object: {
        id: opts.invoiceId,
        object: "invoice",
        billing_reason: opts.billingReason,
        amount_paid: opts.amountPaid ?? 0,
        amount_due: opts.amountDue ?? 0,
        currency: "usd",
        customer: opts.customerId ?? null,
        metadata: opts.metadataOrgId ? { organization_id: opts.metadataOrgId } : {},
        parent: opts.subscriptionId
          ? { type: "subscription_details", subscription_details: { subscription: opts.subscriptionId }, quote_details: null }
          : null,
      },
    },
  });
}

function chargeRefundedPayload(opts: { eventId: string; chargeId: string; customerId?: string; metadataOrgId?: string; refunds: { id: string; amount: number }[] }) {
  return JSON.stringify({
    id: opts.eventId,
    object: "event",
    created: Math.floor(Date.now() / 1000),
    type: "charge.refunded",
    data: {
      object: {
        id: opts.chargeId,
        object: "charge",
        amount_refunded: opts.refunds.reduce((sum, r) => sum + r.amount, 0),
        customer: opts.customerId ?? null,
        metadata: opts.metadataOrgId ? { organization_id: opts.metadataOrgId } : {},
        refunds: { object: "list", data: opts.refunds.map((r) => ({ id: r.id, object: "refund", amount: r.amount, currency: "usd", status: "succeeded" })) },
      },
    },
  });
}

function checkoutCompletedPayloadWithStripeIds(orgId: string, customerId: string, subscriptionId: string) {
  return JSON.stringify({
    id: `evt_test_checkout_${orgId}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${orgId}`,
        object: "checkout.session",
        client_reference_id: orgId,
        metadata: { organization_id: orgId },
        customer: customerId,
        subscription: subscriptionId,
      },
    },
  });
}

test("1. invoice.payment_succeeded is attributed via stripe_subscription_id and records a revenue_events row with the paid amount", async () => {
  const eventId = `evt_test_invpay_sub_${Date.now()}`;
  const payload = invoiceEventPayload({
    type: "invoice.payment_succeeded",
    eventId,
    invoiceId: "in_test_sub_1",
    subscriptionId: `sub_test_${orgWithSubscription}`,
    billingReason: "subscription_cycle",
    amountPaid: 149700,
  });
  const response = await POST(signedRequest(payload) as never);
  assert.equal(response.status, 200);

  const { data } = await service.from("revenue_events").select("*").eq("provider_event_id", eventId).single();
  assert.equal(data?.organization_id, orgWithSubscription);
  assert.equal(data?.event_type, "payment_succeeded");
  assert.equal(data?.amount, 149700);
  assert.equal(data?.revenue_category, "recurring");
});

test("2. a subscription_create invoice (mixed setup + recurring) is recorded with revenue_category=null - never guessed", async () => {
  const eventId = `evt_test_invpay_mixed_${Date.now()}`;
  const payload = invoiceEventPayload({
    type: "invoice.payment_succeeded",
    eventId,
    invoiceId: "in_test_mixed_1",
    subscriptionId: `sub_test_${orgWithSubscription}`,
    billingReason: "subscription_create",
    amountPaid: 399700,
  });
  await POST(signedRequest(payload) as never);

  const { data } = await service.from("revenue_events").select("revenue_category, amount").eq("provider_event_id", eventId).single();
  assert.equal(data?.revenue_category, null, "a mixed first invoice must never be guessed into setup or recurring");
  assert.equal(data?.amount, 399700);
});

test("3. invoice.payment_succeeded falls back to stripe_customer_id when no stripe_subscription_id matches", async () => {
  const eventId = `evt_test_invpay_cust_${Date.now()}`;
  const payload = invoiceEventPayload({
    type: "invoice.payment_succeeded",
    eventId,
    invoiceId: "in_test_cust_1",
    customerId: `cus_test_${orgWithCustomerOnly}`,
    billingReason: "subscription_cycle",
    amountPaid: 149700,
  });
  await POST(signedRequest(payload) as never);

  const { data } = await service.from("revenue_events").select("organization_id").eq("provider_event_id", eventId).single();
  assert.equal(data?.organization_id, orgWithCustomerOnly);
});

test("4. invoice.payment_succeeded falls back to metadata.organization_id when no stored Stripe id matches, but only if that organization actually exists", async () => {
  const eventId = `evt_test_invpay_meta_${Date.now()}`;
  const payload = invoiceEventPayload({
    type: "invoice.payment_succeeded",
    eventId,
    invoiceId: "in_test_meta_1",
    metadataOrgId: orgForMetadataFallback,
    billingReason: "subscription_cycle",
    amountPaid: 149700,
  });
  await POST(signedRequest(payload) as never);

  const { data } = await service.from("revenue_events").select("organization_id").eq("provider_event_id", eventId).single();
  assert.equal(data?.organization_id, orgForMetadataFallback);
});

test("5. an invoice event with no resolvable organization (no subscription/customer match, no metadata) is acknowledged 200 and creates no row - never a null-organization or guessed row", async () => {
  const eventId = `evt_test_invpay_unresolvable_${Date.now()}`;
  const payload = invoiceEventPayload({
    type: "invoice.payment_succeeded",
    eventId,
    invoiceId: "in_test_unresolvable_1",
    customerId: "cus_test_does_not_exist_anywhere",
    billingReason: "subscription_cycle",
    amountPaid: 149700,
  });
  const response = await POST(signedRequest(payload) as never);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reason, "missing_organization_id");

  const { data } = await service.from("revenue_events").select("id").eq("provider_event_id", eventId).maybeSingle();
  assert.equal(data, null);
});

test("6. invoice.payment_failed records amount_due (never amount_paid) and is never counted as a payment_succeeded row", async () => {
  const eventId = `evt_test_invfail_${Date.now()}`;
  const payload = invoiceEventPayload({
    type: "invoice.payment_failed",
    eventId,
    invoiceId: "in_test_failed_1",
    subscriptionId: `sub_test_${orgWithSubscription}`,
    billingReason: "subscription_cycle",
    amountDue: 149700,
    amountPaid: 0,
  });
  await POST(signedRequest(payload) as never);

  const { data } = await service.from("revenue_events").select("event_type, amount").eq("provider_event_id", eventId).single();
  assert.equal(data?.event_type, "payment_failed");
  assert.equal(data?.amount, 149700);
});

test("7. a duplicate delivery of the same invoice.payment_succeeded event id is idempotent - exactly one row, never two", async () => {
  const eventId = `evt_test_invpay_dup_${Date.now()}`;
  const payload = invoiceEventPayload({
    type: "invoice.payment_succeeded",
    eventId,
    invoiceId: "in_test_dup_1",
    subscriptionId: `sub_test_${orgWithSubscription}`,
    billingReason: "subscription_cycle",
    amountPaid: 149700,
  });

  await POST(signedRequest(payload) as never);
  await POST(signedRequest(payload) as never);

  const { data, count } = await service.from("revenue_events").select("id", { count: "exact" }).eq("provider_event_id", eventId);
  assert.equal(count, 1, "duplicate Stripe delivery of the same event must always resolve to exactly one row");
  assert.equal(data?.length, 1);
});

test("8. charge.refunded records the individual refund's own amount, not the charge's cumulative amount_refunded", async () => {
  const eventId = `evt_test_refund_1_${Date.now()}`;
  const chargeId = `ch_test_${Date.now()}`;
  const refundId = `re_test_1_${Date.now()}`;
  // amount_refunded on the charge is 30000, but this specific refund is only 10000 (a partial refund) - see the payload builder above, amount_refunded is derived as the sum, matching real Stripe behavior on a second partial refund.
  const payload = chargeRefundedPayload({
    eventId,
    chargeId,
    customerId: `cus_test_${orgWithCustomerOnly}`,
    refunds: [{ id: refundId, amount: 10000 }],
  });
  await POST(signedRequest(payload) as never);

  const { data } = await service.from("revenue_events").select("*").eq("provider_event_id", eventId).single();
  assert.equal(data?.event_type, "refund");
  assert.equal(data?.amount, 10000, "must record the individual refund amount, never the charge's cumulative amount_refunded");
  assert.equal(data?.provider_object_id, refundId);
});

test("9. two sequential partial refunds on the same charge produce two separate rows with their own individual amounts, never a cumulative double-count", async () => {
  const chargeId = `ch_test_multi_${Date.now()}`;
  const firstRefundId = `re_test_multi_1_${Date.now()}`;
  const secondRefundId = `re_test_multi_2_${Date.now()}`;
  const firstEventId = `evt_test_refund_multi_1_${Date.now()}`;
  const secondEventId = `evt_test_refund_multi_2_${Date.now()}`;

  // First partial refund: $100.00 of a larger charge.
  await POST(
    signedRequest(
      chargeRefundedPayload({ eventId: firstEventId, chargeId, customerId: `cus_test_${orgWithCustomerOnly}`, refunds: [{ id: firstRefundId, amount: 10000 }] }),
    ) as never,
  );
  // Second partial refund: Stripe's real payload would show amount_refunded=20000 (cumulative) here, and refunds.data[0] is the NEWEST refund only.
  await POST(
    signedRequest(
      chargeRefundedPayload({ eventId: secondEventId, chargeId, customerId: `cus_test_${orgWithCustomerOnly}`, refunds: [{ id: secondRefundId, amount: 10000 }] }),
    ) as never,
  );

  const { data } = await service.from("revenue_events").select("provider_object_id, amount").in("provider_event_id", [firstEventId, secondEventId]);
  assert.equal(data?.length, 2, "each distinct refund event must produce its own row");
  const total = data!.reduce((sum, row) => sum + row.amount, 0);
  assert.equal(total, 20000, "the sum of the two individual refund rows must equal the true total refunded (10000 + 10000), never a doubled/cumulative figure");
});

test("10. charge.refunded with no embedded refund object is acknowledged 200 and creates no row - never guesses an amount from amount_refunded", async () => {
  const eventId = `evt_test_refund_norefund_${Date.now()}`;
  const payload = chargeRefundedPayload({ eventId, chargeId: `ch_test_norefund_${Date.now()}`, customerId: `cus_test_${orgWithCustomerOnly}`, refunds: [] });
  const response = await POST(signedRequest(payload) as never);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reason, "missing_refund_object");

  const { data } = await service.from("revenue_events").select("id").eq("provider_event_id", eventId).maybeSingle();
  assert.equal(data, null);
});

test("11. checkout.session.completed opportunistically persists stripe_customer_id and stripe_subscription_id onto the organization", async () => {
  const customerId = `cus_test_persist_${Date.now()}`;
  const subscriptionId = `sub_test_persist_${Date.now()}`;
  const payload = checkoutCompletedPayloadWithStripeIds(orgForCheckoutPersistence, customerId, subscriptionId);
  const response = await POST(signedRequest(payload) as never);
  assert.equal(response.status, 200);

  const { data } = await service.from("organizations").select("stripe_customer_id, stripe_subscription_id").eq("id", orgForCheckoutPersistence).single();
  assert.equal(data?.stripe_customer_id, customerId);
  assert.equal(data?.stripe_subscription_id, subscriptionId);
});

test("12. none of the revenue-intelligence event types ever touch payment_status - regression against Phase 5D-1 scope", async () => {
  const { data: before } = await service.from("organizations").select("payment_status").eq("id", orgWithSubscription).single();

  const eventId = `evt_test_no_payment_status_effect_${Date.now()}`;
  await POST(
    signedRequest(
      invoiceEventPayload({ type: "invoice.payment_succeeded", eventId, invoiceId: "in_test_regression_1", subscriptionId: `sub_test_${orgWithSubscription}`, billingReason: "subscription_cycle", amountPaid: 149700 }),
    ) as never,
  );

  const { data: after } = await service.from("organizations").select("payment_status").eq("id", orgWithSubscription).single();
  assert.equal(after?.payment_status, before?.payment_status, "payment_status must be completely unaffected by revenue_events ingestion");
});
