/**
 * Phase 1C, Step 5: unit tests for the public checkout endpoint -
 * lib/payments/pay-routes.ts (all the logic) plus structural checks of the
 * route file, the pay page, the pay panel and the middleware allowlist.
 * Fake Supabase and fake Stripe only: no network, no .env.local, no real
 * key. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/pay-routes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type Stripe from "stripe";
import { makeFakeStripe, makeFakeSupabase, stripeApiError, withStripeKey, type Row } from "./test-fakes";

const require = createRequire(import.meta.url);
const { handleInvoiceCheckout }: typeof import("./pay-routes") = require("./pay-routes.ts");

const ORIGIN = "http://localhost:3000";
const TOKEN = "e5".repeat(24);
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const INVOICE = "33333333-3333-4333-8333-333333333333";
const ACCT = "acct_1TestConnect000001";
const OTHER_ACCT = "acct_1OtherOrg0000000001";
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_a1b2c3";
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
    organization: { name: "Acme Roofing", sms_phone_number: "+15551230000", timezone: "America/Denver", payment_status: "active", stripe_connect_account_id: ACCT, stripe_connect_charges_enabled: true, ...organization },
    ...overrides,
  };
}

function checkoutRequest(init: { method?: string; origin?: string | null; fetchSite?: string | null; body?: string; contentType?: string; query?: string } = {}): Request {
  const headers = new Headers({ host: "localhost:3000", "content-type": init.contentType ?? "application/x-www-form-urlencoded" });
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  if (init.fetchSite !== null) headers.set("sec-fetch-site", init.fetchSite ?? "same-origin");
  const method = init.method ?? "POST";
  return new Request(`${ORIGIN}/api/payments/${TOKEN}/checkout${init.query ?? ""}`, { method, headers, body: method === "POST" || method === "PUT" ? (init.body ?? "") : undefined });
}

function setup(rows: Row[] = [invoiceRow()], behavior: Parameters<typeof makeFakeStripe>[0] = { sessionsCreate: () => ({ id: "cs_test_a1b2c3", url: CHECKOUT_URL }) }) {
  const db = makeFakeSupabase({ invoices: rows });
  const stripe = makeFakeStripe(behavior);
  let serviceCreated = 0;
  const deps = { createService: () => ((serviceCreated += 1), db.client), stripe: stripe.stripe, now: () => NOW };
  return { db, stripe, deps, serviceCreated: () => serviceCreated };
}

function assertPayPageNotice(response: Response, notice: string) {
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get("location") ?? "");
  assert.equal(target.origin + target.pathname, `${ORIGIN}/pay/${TOKEN}`);
  assert.deepEqual([...target.searchParams.entries()], [["checkout", notice]], "exactly one fixed-vocabulary parameter");
}

function sessionParams(ctx: ReturnType<typeof setup>): [Stripe.Checkout.SessionCreateParams, Stripe.RequestOptions] {
  return ctx.stripe.calls[0].args as [Stripe.Checkout.SessionCreateParams, Stripe.RequestOptions];
}

// ---------------------------------------------------------------------------
// Successful checkout
// ---------------------------------------------------------------------------

test("a payable invoice gets a 303 to Stripe Checkout - a card-only, full-balance direct charge on the organization's connected account", async () => {
  const ctx = setup([invoiceRow({ status: "partially_paid", amount_paid: 125.5, balance_due: 374.5 })]);
  const response = await handleInvoiceCheckout(checkoutRequest(), TOKEN, ctx.deps);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), CHECKOUT_URL);

  assert.equal(ctx.stripe.calls.length, 1);
  const [params, options] = sessionParams(ctx);
  assert.equal(options.stripeAccount, ACCT);
  assert.deepEqual(params.payment_method_types, ["card"]);
  assert.equal(params.mode, "payment");
  assert.equal(params.line_items?.[0].price_data?.unit_amount, 37450);
  assert.deepEqual(params.metadata, { trackpr_kind: "invoice_payment", invoice_id: INVOICE, organization_id: ORG, expected_amount_cents: "37450" });
  assert.deepEqual(params.payment_intent_data?.metadata, params.metadata);
  assert.equal(params.success_url, `${ORIGIN}/pay/${TOKEN}?checkout=success`);
  assert.equal(params.cancel_url, `${ORIGIN}/pay/${TOKEN}?checkout=cancelled`);
  assert.match(options.idempotencyKey ?? "", /^trackpr-invoice-checkout-/);
  assert.equal(ctx.db.writes().length, 0, "starting a checkout never writes to the database");
});

// ---------------------------------------------------------------------------
// Client input cannot choose amount, organization or account
// ---------------------------------------------------------------------------

test("the amount cannot be client-controlled: amount/price/currency fields in the body or query are ignored - the charge is the database balance", async () => {
  const bodies = [
    "amount=1&unit_amount=1&amount_cents=1&currency=eur&price=price_123&expected_amount_cents=1",
    JSON.stringify({ amount: 1, unit_amount: 1, currency: "eur", price: "price_123", line_items: [{ price: "price_123", quantity: 100 }] }),
  ];
  for (const [i, body] of bodies.entries()) {
    const ctx = setup();
    await handleInvoiceCheckout(checkoutRequest({ body, contentType: i === 0 ? "application/x-www-form-urlencoded" : "application/json", query: "?amount=1&currency=eur" }), TOKEN, ctx.deps);
    const [params] = sessionParams(ctx);
    assert.equal(params.line_items?.length, 1);
    assert.equal(params.line_items?.[0].quantity, 1);
    assert.equal(params.line_items?.[0].price_data?.unit_amount, 50000);
    assert.equal(params.line_items?.[0].price_data?.currency, "usd");
    assert.equal(params.line_items?.[0].price, undefined);
    assert.equal(params.metadata?.expected_amount_cents, "50000");
  }
});

test("the organization and Stripe account cannot be client-controlled: ids in the body or query are ignored - the token's invoice decides both", async () => {
  const ctx = setup();
  const body = `organization_id=${OTHER_ORG}&stripe_account=${OTHER_ACCT}&account=${OTHER_ACCT}&invoice_id=66666666-6666-4666-8666-666666666666`;
  await handleInvoiceCheckout(checkoutRequest({ body, query: `?organization_id=${OTHER_ORG}&stripeAccount=${OTHER_ACCT}` }), TOKEN, ctx.deps);
  const [params, options] = sessionParams(ctx);
  assert.equal(options.stripeAccount, ACCT);
  assert.equal(params.metadata?.organization_id, ORG);
  assert.equal(params.metadata?.invoice_id, INVOICE);
  assert.deepEqual(ctx.db.calls.map((call) => call.filters), [[["eq", "payment_token", TOKEN]]], "the only lookup is by token");
});

// ---------------------------------------------------------------------------
// Not payable
// ---------------------------------------------------------------------------

test("invalid, draft and void tokens get the SAME response as each other and as 'not accepting online payments' - nothing leaks which case it was, and Stripe is never called", async () => {
  const responses: string[] = [];
  const cases: [string, Row[], string][] = [
    ["unknown token", [invoiceRow({ payment_token: "f6".repeat(24) })], TOKEN],
    ["draft", [invoiceRow({ status: "draft" })], TOKEN],
    ["void", [invoiceRow({ status: "void" })], TOKEN],
    ["Connect not configured", [invoiceRow({}, { stripe_connect_account_id: null, stripe_connect_charges_enabled: false })], TOKEN],
    ["charges not enabled", [invoiceRow({}, { stripe_connect_charges_enabled: false })], TOKEN],
    ["subscription inactive", [invoiceRow({}, { payment_status: "suspended" })], TOKEN],
  ];
  for (const [label, rows, token] of cases) {
    const ctx = setup(rows);
    const response = await handleInvoiceCheckout(checkoutRequest(), token, ctx.deps);
    assertPayPageNotice(response, "unavailable");
    assert.equal(ctx.stripe.calls.length, 0, label);
    responses.push(`${response.status} ${response.headers.get("location")}`);
  }
  assert.equal(new Set(responses).size, 1, "every unavailable case is byte-identical");
});

test("a paid invoice never produces a checkout session", async () => {
  const ctx = setup([invoiceRow({ status: "paid", amount_paid: 500, balance_due: 0, paid_at: "2026-10-03T00:00:00.000Z" })]);
  assertPayPageNotice(await handleInvoiceCheckout(checkoutRequest(), TOKEN, ctx.deps), "paid");
  assert.equal(ctx.stripe.calls.length, 0);
});

test("a malformed token is a plain 404 before any database or Stripe work", async () => {
  for (const token of ["", "demo", "abc", TOKEN.toUpperCase(), `${TOKEN}0`, "../../etc/passwd", `${"e5".repeat(23)}%2F`]) {
    const ctx = setup();
    const response = await handleInvoiceCheckout(checkoutRequest(), token, ctx.deps);
    assert.equal(response.status, 404, token);
    assert.equal(response.headers.get("location"), null);
    assert.equal(ctx.serviceCreated(), 0);
    assert.equal(ctx.stripe.calls.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Method and origin
// ---------------------------------------------------------------------------

test("wrong method or a cross-site request is refused before any database or Stripe work", async () => {
  const cases: [string, Request][] = [
    ["GET", checkoutRequest({ method: "GET" })],
    ["PUT", checkoutRequest({ method: "PUT" })],
    ["cross-site Origin", checkoutRequest({ origin: "https://evil.example" })],
    ["cross-site Sec-Fetch-Site", checkoutRequest({ fetchSite: "cross-site" })],
    ["no Origin", checkoutRequest({ origin: null })],
  ];
  for (const [label, request] of cases) {
    const ctx = setup();
    assertPayPageNotice(await handleInvoiceCheckout(request, TOKEN, ctx.deps), "error");
    assert.equal(ctx.serviceCreated(), 0, label);
    assert.equal(ctx.stripe.calls.length, 0, label);
  }
});

test("regression: Origin: null (what browsers send under a no-referrer policy) is refused, even with Sec-Fetch-Site: same-origin - the CSRF gate is not relaxed", async () => {
  for (const fetchSite of ["same-origin", null]) {
    const ctx = setup();
    assertPayPageNotice(await handleInvoiceCheckout(checkoutRequest({ origin: "null", fetchSite }), TOKEN, ctx.deps), "error");
    assert.equal(ctx.serviceCreated(), 0, `Sec-Fetch-Site ${fetchSite}`);
    assert.equal(ctx.stripe.calls.length, 0, `Sec-Fetch-Site ${fetchSite}`);
  }
});

test("a valid same-origin browser POST (Origin = this app, Sec-Fetch-Site: same-origin) passes the CSRF gate and reaches checkout", async () => {
  for (const fetchSite of ["same-origin", null]) {
    const ctx = setup();
    const response = await handleInvoiceCheckout(checkoutRequest({ origin: ORIGIN, fetchSite }), TOKEN, ctx.deps);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), CHECKOUT_URL, `Sec-Fetch-Site ${fetchSite}`);
    assert.equal(ctx.serviceCreated(), 1, "the service client is created only after the gate");
    assert.equal(ctx.stripe.calls.length, 1);
  }
});

// ---------------------------------------------------------------------------
// Stripe failures and redirect safety
// ---------------------------------------------------------------------------

test("a Stripe error returns to the pay page with a generic error - no Stripe message, account or organization in the URL", async () => {
  const ctx = setup([invoiceRow()], { sessionsCreate: () => { throw stripeApiError(`No such account: ${ACCT}`); } });
  const response = await handleInvoiceCheckout(checkoutRequest(), TOKEN, ctx.deps);
  assertPayPageNotice(response, "error");
  const location = response.headers.get("location") ?? "";
  for (const secret of [ACCT, ORG, INVOICE, "No such account"]) assert.equal(location.includes(secret), false, secret);
});

test("only an https *.stripe.com checkout URL is ever followed", async () => {
  for (const url of ["https://evil.example/pay", "http://checkout.stripe.com/c/pay/x", "https://checkout.stripe.com.evil.example/x", "javascript:alert(1)"]) {
    const ctx = setup([invoiceRow()], { sessionsCreate: () => ({ id: "cs_test_a1b2c3", url }) });
    assertPayPageNotice(await handleInvoiceCheckout(checkoutRequest(), TOKEN, ctx.deps), "error");
  }
});

test("with the real (guarded) client and a live key outside Vercel Production, no session is created", async () => {
  const db = makeFakeSupabase({ invoices: [invoiceRow()] });
  const response = await withStripeKey("sk_live_guard_unit_test_only", () => handleInvoiceCheckout(checkoutRequest(), TOKEN, { createService: () => db.client, now: () => NOW }));
  assertPayPageNotice(response, "error");
  assert.equal(db.writes().length, 0);
});

// ---------------------------------------------------------------------------
// Structural
// ---------------------------------------------------------------------------

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("structural: the checkout route exports POST only and just wires handleInvoiceCheckout with the service client - no Stripe, no body or query handling", () => {
  const route = read("app/api/payments/[token]/checkout/route.ts");
  assert.match(route, /export async function POST\(/);
  assert.doesNotMatch(route, /export (async )?function (GET|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/);
  assert.match(route, /handleInvoiceCheckout\(request, token, \{ createService: createServiceRoleClient \}\)/);
  assert.doesNotMatch(route, /from "stripe"|getStripeClient|getPaymentsStripeClient|new\s+Stripe\s*\(|searchParams|formData|\.json\(|\.text\(/);
  const handler = read("lib/payments/pay-routes.ts");
  assert.doesNotMatch(handler, /request\.(json|formData|text|arrayBuffer|body)\b|searchParams\.get/, "the handler never reads the request body or query");
});

test("structural: the pay page renders only the public projection - no internal loader, ids, account, subscription status or notes", () => {
  const page = read("app/pay/[token]/page.tsx");
  assert.match(page, /getPublicInvoiceByPaymentToken\(createServiceRoleClient\(\), token\)/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  // Pinned: "same-origin" keeps the token out of every cross-origin Referer
  // (Stripe included) while the browser still sends the real Origin on the
  // same-origin Pay now POST. "no-referrer" makes browsers send Origin: null,
  // which the checkout route refuses - the sandbox E2E defect this pins.
  const policies = [...page.matchAll(/referrer:\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(policies, ["same-origin"], "exactly one referrer policy, and it is same-origin");
  for (const forbidden of ["loadPayableInvoiceByToken", "invoiceId", "organizationId", "connectAccount", "stripe_connect", "payment_status", "paymentStatus", "notes", "void_reason", "created_by"]) {
    assert.equal(page.includes(forbidden), false, forbidden);
  }
});

test("structural: the pay panel posts a field-less form to the checkout route - no amount, organization or account inputs", () => {
  const panel = read("app/pay/[token]/_components/pay-panel.tsx");
  assert.match(panel, /<form method="post" action=\{`\/api\/payments\/\$\{encodeURIComponent\(token\)\}\/checkout`\}/);
  // `\sname=` so className= does not count; any real field would need a name attribute.
  assert.doesNotMatch(panel, /<input|<select|<textarea|\sname=|fetch\(|organization|account/i);
});

test("structural: the middleware exempts exactly the /pay/ prefix (with the slash), alongside /quote", () => {
  const middleware = read("lib/supabase/middleware.ts");
  assert.match(middleware, /pathname\.startsWith\("\/quote"\) \|\| pathname\.startsWith\("\/pay\/"\)\)/);
  assert.doesNotMatch(middleware, /startsWith\("\/pay"\)/, "never the slash-less prefix");
});
