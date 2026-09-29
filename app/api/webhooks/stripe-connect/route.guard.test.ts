/**
 * Phase 1C, Step 6: route-level guard tests for app/api/webhooks/stripe-connect.
 *
 * Environment safety (deliberate, the app/api/webhooks/stripe/route.guard.test.ts
 * pattern): this file never reads .env.local, never uses a real Stripe key and
 * never reaches a real database. The route's service-role Supabase client is
 * pointed at a fake PostgREST server on 127.0.0.1 that serves in-memory rows
 * and records every request, so "did the route read or write?" is observed
 * directly. Signatures are real (the guarded payments client's
 * generateTestHeaderString + constructEvent are local HMAC - no network).
 * Only paths that never call the Stripe API are driven here; every other
 * branch is covered with injected fakes in lib/payments/connect-webhook.test.ts.
 * The test aborts before importing the route if the Supabase URL is anything
 * but the local fake or the Stripe key is not a test key.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/api/webhooks/stripe-connect/route.guard.test.ts"
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

type RecordedRequest = { method: string; table: string; query: string; body: string };
const requests: RecordedRequest[] = [];
let rows: Record<string, Record<string, unknown>[]> = {};

/** Serves GETs from `rows`, filtering on `column=eq.value`; records everything; answers any write with 500 so an unexpected write fails loudly. */
const fakePostgrest = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    requests.push({ method: req.method ?? "", table, query: url.search, body: raw });
    if (req.method !== "GET") {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "unexpected write in guard test" }));
      return;
    }
    const filters = [...url.searchParams.entries()].filter(([, value]) => value.startsWith("eq.")).map(([column, value]) => [column, value.slice(3)] as const);
    const matched = (rows[table] ?? []).filter((row) => filters.every(([column, value]) => String(row[column]) === value));
    if ((req.headers.accept ?? "").includes("application/vnd.pgrst.object+json")) {
      if (matched.length !== 1) {
        res.writeHead(406, { "content-type": "application/json" }).end(JSON.stringify({ code: "PGRST116", details: `The result contains ${matched.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/vnd.pgrst.object+json" }).end(JSON.stringify(matched[0]));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(matched));
  });
});

const CONNECT_SECRET = "whsec_phase1c_connect_guard_tests_only";
const ORG = "11111111-1111-4111-8111-111111111111";
const INVOICE = "33333333-3333-4333-8333-333333333333";
const ACCT = "acct_1TestConnect000001";
const SESSION = "cs_test_a1B2c3D4e5";
const INTENT = "pi_3TestIntent0001";

let POST: typeof import("./route").POST;
let signer: { webhooks: { generateTestHeaderString: (options: { payload: string; secret: string }) => string } };

before(async () => {
  await new Promise<void>((resolve) => fakePostgrest.listen(0, "127.0.0.1", resolve));
  const { port } = fakePostgrest.address() as AddressInfo;

  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key-for-local-fake-only";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder_phase1c_connect_guard_never_calls_stripe";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;

  assert.match(process.env.NEXT_PUBLIC_SUPABASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/, "refusing to run against anything but the local fake");
  assert.ok(process.env.STRIPE_SECRET_KEY.startsWith("sk_test_"), "refusing to run with a non-test Stripe key");

  ({ POST } = require(path.join(REPO_ROOT, "app/api/webhooks/stripe-connect/route.ts")));
  const { getPaymentsStripeClient } = require(path.join(REPO_ROOT, "lib/billing/stripe-mode-guard.ts")) as typeof import("@/lib/billing/stripe-mode-guard");
  signer = getPaymentsStripeClient();
});

after(() => {
  fakePostgrest.close();
});

beforeEach(() => {
  requests.length = 0;
  rows = { organizations: [{ id: ORG, stripe_connect_account_id: ACCT }], customer_payments: [] };
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder_phase1c_connect_guard_never_calls_stripe";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
});

function payload(type: string, object: Record<string, unknown>, account: string | null = ACCT): string {
  const event: Record<string, unknown> = { id: `evt_guard_${Math.random().toString(36).slice(2)}`, object: "event", type, created: 1791000000, livemode: false, data: { object } };
  if (account) event.account = account;
  return JSON.stringify(event);
}

function invoiceSession(overrides: Record<string, unknown> = {}) {
  return { id: SESSION, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: 50000, currency: "usd", payment_intent: INTENT, metadata: { trackpr_kind: "invoice_payment", invoice_id: INVOICE, organization_id: ORG, expected_amount_cents: "50000" }, ...overrides };
}

function request(body: string, signature: string | null = signer.webhooks.generateTestHeaderString({ payload: body, secret: CONNECT_SECRET })): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("stripe-signature", signature);
  return new Request("http://localhost/api/webhooks/stripe-connect", { method: "POST", headers, body });
}

async function call(req: Request) {
  const response = await POST(req as never);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const writes = () => requests.filter((r) => r.method !== "GET");

test("route: an invalid or missing signature is 400 and the database is never contacted", async () => {
  const body = payload("checkout.session.completed", invoiceSession());
  for (const signature of [signer.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_wrong" }), "t=1,v1=00", null]) {
    const result = await call(request(body, signature));
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { ok: false, outcome: "invalid_signature" });
  }
  assert.equal(requests.length, 0);
});

test("route: an unset STRIPE_CONNECT_WEBHOOK_SECRET is 500; a live key is refused (500) - neither contacts the database", async () => {
  const body = payload("account.updated", { id: ACCT });
  const signature = signer.webhooks.generateTestHeaderString({ payload: body, secret: CONNECT_SECRET });
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  assert.equal((await call(request(body, signature))).status, 500);
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_live_guard_unit_test_only";
  const refused = await call(request(body, signature));
  assert.equal(refused.status, 500);
  assert.deepEqual(refused.body, { ok: false, outcome: "not_configured" });
  assert.equal(requests.length, 0);
});

test("route: a validly signed event without event.account, or of an unrelated type, is 200 ignored with no database access", async () => {
  assert.deepEqual((await call(request(payload("checkout.session.completed", invoiceSession(), null)))).body, { ok: true, outcome: "ignored", reason: "no_connected_account" });
  assert.deepEqual((await call(request(payload("payment_intent.created", { id: "pi_x" })))).body, { ok: true, outcome: "ignored", reason: "unhandled_event_type" });
  assert.equal(requests.length, 0);
});

test("route: a subscription-mode or non-invoice session is 200 ignored with no database access", async () => {
  assert.deepEqual((await call(request(payload("checkout.session.completed", invoiceSession({ mode: "subscription" }))))).body, { ok: true, outcome: "ignored", reason: "not_payment_mode" });
  assert.deepEqual((await call(request(payload("checkout.session.completed", invoiceSession({ metadata: { trackpr_kind: "other" } }))))).body, { ok: true, outcome: "ignored", reason: "not_invoice_payment" });
  assert.equal(requests.length, 0);
});

test("route: the organization is looked up by the signed event.account; an account no organization owns is 200 unattributable, with no write", async () => {
  const result = await call(request(payload("checkout.session.completed", invoiceSession(), "acct_1NobodyOwnsThis0000")));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: false, outcome: "unattributable" });
  assert.deepEqual(requests.map((r) => [r.method, r.table]), [["GET", "organizations"]]);
  assert.match(requests[0].query, /stripe_connect_account_id=eq\.acct_1NobodyOwnsThis0000/);
  assert.equal(writes().length, 0);
});

test("route: a replayed checkout for an already-recorded session is 200 duplicate - no Stripe call, no write", async () => {
  rows.customer_payments = [{ id: "pay-existing", organization_id: ORG, invoice_id: INVOICE, stripe_checkout_session_id: SESSION, stripe_payment_intent_id: INTENT }];
  const body = payload("checkout.session.completed", invoiceSession());
  for (let i = 0; i < 2; i += 1) {
    const result = await call(request(body));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, outcome: "duplicate" });
  }
  assert.deepEqual([...new Set(requests.map((r) => `${r.method} ${r.table}`))], ["GET organizations", "GET customer_payments"]);
  assert.equal(writes().length, 0);
});

test("route: account.updated for an account no organization owns is 200 ignored, before any Stripe call", async () => {
  const result = await call(request(payload("account.updated", { id: "acct_1NobodyOwnsThis0000" }, "acct_1NobodyOwnsThis0000")));
  assert.deepEqual(result.body, { ok: true, outcome: "ignored", reason: "unknown_account" });
  assert.deepEqual(requests.map((r) => [r.method, r.table]), [["GET", "organizations"]]);
});

test("route: a refund on a charge Trackpr never recorded is 200 ignored, with no write", async () => {
  const result = await call(request(payload("charge.refunded", { id: "ch_x", object: "charge", payment_intent: "pi_3NotTrackpr0001", amount_refunded: 100, currency: "usd", refunds: { data: [] } })));
  assert.deepEqual(result.body, { ok: true, outcome: "ignored", reason: "not_trackpr_payment" });
  assert.equal(writes().length, 0);
});
