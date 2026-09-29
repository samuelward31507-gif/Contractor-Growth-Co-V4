/**
 * Phase 1C: unit tests for lib/payments/invoice-checkout.ts - the direct-charge
 * Checkout Session for an invoice's balance. Fake Supabase and fake Stripe
 * only. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/invoice-checkout.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type Stripe from "stripe";
import { makeFakeStripe, makeFakeSupabase, stripeApiError, withStripeKey, type Row } from "./test-fakes";

const require = createRequire(import.meta.url);
const { createInvoiceCheckoutSession, checkoutWindow, CHECKOUT_WINDOW_MS, INVOICE_PAYMENT_KIND }: typeof import("./invoice-checkout") = require("./invoice-checkout.ts");

const TOKEN = "c3".repeat(24);
const ORG = "11111111-1111-4111-8111-111111111111";
const INVOICE = "33333333-3333-4333-8333-333333333333";
const ACCT = "acct_1TestConnect000001";
const BASE = "http://localhost:3000";
const NOW = new Date("2026-10-05T12:10:00Z");

function invoiceRow(overrides: Partial<Row> = {}, organization: Partial<Row> = {}): Row {
  return {
    id: INVOICE,
    organization_id: ORG,
    job_id: "44444444-4444-4444-8444-444444444444",
    number: 42,
    status: "sent",
    title: "Roof repair",
    total: 500,
    amount_paid: 0,
    balance_due: 500,
    issued_at: "2026-10-01T15:00:00.000Z",
    due_date: "2026-10-15",
    paid_at: null,
    payment_token: TOKEN,
    organization: { name: "Acme Roofing", sms_phone_number: null, timezone: "America/Denver", payment_status: "active", stripe_connect_account_id: ACCT, stripe_connect_charges_enabled: true, ...organization },
    ...overrides,
  };
}

const okSession = () => ({ id: "cs_test_a1b2c3", url: "https://checkout.stripe.com/c/pay/cs_test_a1b2c3" });

test("creates a card-only, full-balance DIRECT charge on the contractor's connected account, with invoice and organization metadata on the session AND the PaymentIntent, and no platform fee", async () => {
  const db = makeFakeSupabase({ invoices: [invoiceRow({ status: "partially_paid", amount_paid: 125.5, balance_due: 374.5 })] });
  const fake = makeFakeStripe({ sessionsCreate: okSession });
  const result = await createInvoiceCheckoutSession(db.client, { token: TOKEN, baseUrl: `${BASE}/some/path?x=1`, now: NOW }, { stripe: fake.stripe });
  assert.deepEqual(result, { ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_a1b2c3", sessionId: "cs_test_a1b2c3" });

  assert.equal(fake.calls.length, 1);
  const [params, options] = fake.calls[0].args as [Stripe.Checkout.SessionCreateParams, Stripe.RequestOptions];
  assert.equal(options.stripeAccount, ACCT, "direct charge on the connected account");
  assert.equal(params.mode, "payment");
  assert.deepEqual(params.payment_method_types, ["card"]);
  assert.equal(params.line_items?.length, 1);
  assert.equal(params.line_items?.[0].quantity, 1);
  assert.equal(params.line_items?.[0].price_data?.currency, "usd");
  assert.equal(params.line_items?.[0].price_data?.unit_amount, 37450, "the full current balance, in cents");
  assert.equal(params.line_items?.[0].price_data?.product_data?.name, "Invoice INV-000042");
  const expectedMetadata = { trackpr_kind: INVOICE_PAYMENT_KIND, invoice_id: INVOICE, organization_id: ORG, expected_amount_cents: "37450" };
  assert.deepEqual(params.metadata, expectedMetadata);
  assert.deepEqual(params.payment_intent_data?.metadata, expectedMetadata);
  assert.equal(params.payment_intent_data?.application_fee_amount, undefined, "no platform fee");
  assert.equal("application_fee_amount" in (params.payment_intent_data ?? {}), false);
  assert.equal(params.client_reference_id, INVOICE);
  assert.equal(params.success_url, `${BASE}/pay/${TOKEN}?checkout=success`, "base URL reduced to its origin");
  assert.equal(params.cancel_url, `${BASE}/pay/${TOKEN}?checkout=cancelled`);
  const lifetime = (params.expires_at as number) - NOW.getTime() / 1000;
  assert.ok(lifetime >= 30 * 60 && lifetime <= 60 * 60, `expires in ${lifetime}s`);
  assert.equal(db.writes().length, 0, "creating a session never writes to the database");
});

test("idempotency: same window + same balance reuse one key (with identical params); a new window or a changed balance does not", async () => {
  const keyFor = async (rowOverrides: Partial<Row>, now: Date) => {
    const fake = makeFakeStripe({ sessionsCreate: okSession });
    await createInvoiceCheckoutSession(makeFakeSupabase({ invoices: [invoiceRow(rowOverrides)] }).client, { token: TOKEN, baseUrl: BASE, now }, { stripe: fake.stripe });
    const [params, options] = fake.calls[0].args as [Stripe.Checkout.SessionCreateParams, Stripe.RequestOptions];
    return { key: options.idempotencyKey, params: JSON.stringify(params) };
  };
  const first = await keyFor({}, NOW);
  const sameWindow = await keyFor({}, new Date(NOW.getTime() + 5 * 60 * 1000));
  assert.equal(sameWindow.key, first.key);
  assert.equal(sameWindow.params, first.params, "Stripe requires identical parameters for a replayed key");
  assert.match(first.key ?? "", new RegExp(`^trackpr-invoice-checkout-${INVOICE}-0-50000-\\d+$`));
  const nextWindow = await keyFor({}, new Date(NOW.getTime() + CHECKOUT_WINDOW_MS));
  assert.notEqual(nextWindow.key, first.key);
  const afterPartialPayment = await keyFor({ status: "partially_paid", amount_paid: 100, balance_due: 400 }, NOW);
  assert.notEqual(afterPartialPayment.key, first.key);
});

test("checkoutWindow always leaves Stripe's 30-minute minimum and never more than an hour", () => {
  for (let offset = 0; offset < CHECKOUT_WINDOW_MS; offset += 97_000) {
    const now = new Date(Math.floor(NOW.getTime() / CHECKOUT_WINDOW_MS) * CHECKOUT_WINDOW_MS + offset);
    const lifetime = checkoutWindow(now).expiresAt - now.getTime() / 1000;
    assert.ok(lifetime > 30 * 60 && lifetime <= 60 * 60, `offset ${offset}: ${lifetime}`);
  }
});

test("refusals happen before any Stripe call: unknown token, paid, not accepting online payments, bad base URL", async () => {
  const cases: [string, Row[], string, string][] = [
    ["unknown token", [invoiceRow()], "d4".repeat(24), "not_found"],
    ["draft", [invoiceRow({ status: "draft" })], TOKEN, "not_found"],
    ["void", [invoiceRow({ status: "void" })], TOKEN, "not_found"],
    ["paid", [invoiceRow({ status: "paid", amount_paid: 500, balance_due: 0 })], TOKEN, "already_paid"],
    ["suspended subscription", [invoiceRow({}, { payment_status: "suspended" })], TOKEN, "not_accepting_online_payments"],
    ["charges disabled", [invoiceRow({}, { stripe_connect_charges_enabled: false })], TOKEN, "not_accepting_online_payments"],
    ["no connected account", [invoiceRow({}, { stripe_connect_account_id: null })], TOKEN, "not_accepting_online_payments"],
  ];
  for (const [label, rows, token, reason] of cases) {
    const fake = makeFakeStripe();
    const result = await createInvoiceCheckoutSession(makeFakeSupabase({ invoices: rows }).client, { token, baseUrl: BASE, now: NOW }, { stripe: fake.stripe });
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.reason, reason, label);
    assert.equal(fake.calls.length, 0, `${label}: no Stripe call`);
  }
  const fake = makeFakeStripe();
  const badBase = await createInvoiceCheckoutSession(makeFakeSupabase({ invoices: [invoiceRow()] }).client, { token: TOKEN, baseUrl: "ftp://example.com", now: NOW }, { stripe: fake.stripe });
  assert.equal(badBase.ok, false);
  if (!badBase.ok) assert.equal(badBase.reason, "invalid_request");
  assert.equal(fake.calls.length, 0);
});

test("inconsistent money (balance_due != total - amount_paid, or sub-cent values) is refused, never charged", async () => {
  for (const overrides of [{ balance_due: 450 }, { balance_due: 500.001, total: 500.001 }]) {
    const fake = makeFakeStripe();
    const result = await createInvoiceCheckoutSession(makeFakeSupabase({ invoices: [invoiceRow(overrides)] }).client, { token: TOKEN, baseUrl: BASE, now: NOW }, { stripe: fake.stripe });
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(fake.calls.length, 0);
  }
});

test("a Stripe error, or a session without a URL, is reported as stripe_error", async () => {
  for (const behavior of [() => { throw stripeApiError("card declined setup"); }, () => ({ id: "cs_test_nourl", url: null })]) {
    const fake = makeFakeStripe({ sessionsCreate: behavior });
    const result = await createInvoiceCheckoutSession(makeFakeSupabase({ invoices: [invoiceRow()] }).client, { token: TOKEN, baseUrl: BASE, now: NOW }, { stripe: fake.stripe });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "stripe_error");
  }
});

test("the default client is the guarded one: with a live key outside Vercel Production no session is created", async () => {
  const result = await withStripeKey("sk_live_guard_unit_test_only", () => createInvoiceCheckoutSession(makeFakeSupabase({ invoices: [invoiceRow()] }).client, { token: TOKEN, baseUrl: BASE, now: NOW }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "stripe_error");
});
