/**
 * Phase 1C, Step 6: unit tests for lib/payments/connect-webhook.ts - the Stripe
 * Connect webhook. Signatures are REAL: generated and verified with the SDK's
 * local HMAC helpers from the guarded payments client (built with a
 * placeholder sk_test_ key; no network). Supabase and the Stripe API are
 * fakes. No .env.local, no real key. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/connect-webhook.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type Stripe from "stripe";
import { makeFakeStripe, makeFakeSupabase, stripeApiError, v2Account, withStripeKey, type DbError, type FakeStripeBehavior, type Row } from "./test-fakes";

const require = createRequire(import.meta.url);
const { handleConnectWebhook }: typeof import("./connect-webhook") = require("./connect-webhook.ts");
const { getPaymentsStripeClient }: typeof import("@/lib/billing/stripe-mode-guard") = require("../billing/stripe-mode-guard.ts");

const SECRET = "whsec_connect_webhook_unit_tests_only";
const ENV = { STRIPE_CONNECT_WEBHOOK_SECRET: SECRET } as unknown as NodeJS.ProcessEnv;
const signer = getPaymentsStripeClient({ STRIPE_CONNECT_SECRET_KEY: "sk_test_placeholder_connect_webhook_tests" } as unknown as NodeJS.ProcessEnv);

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const INVOICE = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const ACCT = "acct_1TestConnect000001";
const OTHER_ACCT = "acct_1OtherOrg0000000001";
const SESSION = "cs_test_a1B2c3D4e5";
const INTENT = "pi_3TestIntent0001";

function organizations(): Row[] {
  return [
    { id: ORG, stripe_connect_account_id: ACCT, stripe_connect_charges_enabled: false },
    { id: OTHER_ORG, stripe_connect_account_id: OTHER_ACCT, stripe_connect_charges_enabled: false },
  ];
}

function invoiceRow(overrides: Partial<Row> = {}): Row {
  return { id: INVOICE, organization_id: ORG, job_id: JOB, contact_id: null, number: 42, status: "sent", total: 500, amount_paid: 0, balance_due: 500, paid_at: null, ...overrides };
}

function session(overrides: Record<string, unknown> = {}, metadata: Record<string, string> = {}) {
  return {
    id: SESSION,
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    status: "complete",
    amount_total: 50000,
    currency: "usd",
    payment_intent: INTENT,
    metadata: { trackpr_kind: "invoice_payment", invoice_id: INVOICE, organization_id: ORG, expected_amount_cents: "50000", ...metadata },
    ...overrides,
  };
}

function eventPayload(type: string, object: Record<string, unknown>, account: string | null = ACCT): string {
  const event: Record<string, unknown> = { id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, created: 1791000000, livemode: false, data: { object } };
  if (account) event.account = account;
  return JSON.stringify(event);
}

function signedRequest(payload: string, options: { secret?: string; signature?: string | null; url?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const signature = options.signature === undefined ? signer.webhooks.generateTestHeaderString({ payload, secret: options.secret ?? SECRET }) : options.signature;
  if (signature !== null) headers.set("stripe-signature", signature);
  return new Request(options.url ?? "http://localhost:3000/api/webhooks/stripe-connect", { method: "POST", headers, body: payload });
}

function ledgerTriggers(table: string, row: Row, tables: Record<string, Row[]>): Row {
  if (table !== "customer_payments") return row;
  const invoice = tables.invoices.find((inv) => inv.id === row.invoice_id)!;
  invoice.amount_paid = Number(invoice.amount_paid) + Number(row.amount);
  invoice.balance_due = Number(invoice.total) - Number(invoice.amount_paid);
  invoice.status = Number(invoice.balance_due) <= 0 ? "paid" : "partially_paid";
  return row;
}

const incidentRpc = (fn: string, args: Row) =>
  fn === "record_automation_incident_signal"
    ? { data: { id: "incident-1", organization_id: args.p_organization_id, category: args.p_category, severity: args.p_severity, status: "open", fingerprint: args.p_fingerprint, title: args.p_title, metadata: args.p_metadata, occurrence_count: 1 }, error: null }
    : { data: {}, error: null };

function setup(options: { payments?: Row[]; invoice?: Partial<Row>; stripe?: FakeStripeBehavior; insertError?: DbError; rpc?: (fn: string, args: Row) => { data: unknown; error: DbError | null } } = {}) {
  const db = makeFakeSupabase(
    { organizations: organizations(), invoices: [invoiceRow(options.invoice)], customer_payments: options.payments ?? [] },
    { onInsert: ledgerTriggers, insertError: options.insertError ? (table) => (table === "customer_payments" ? options.insertError! : null) : undefined, rpc: options.rpc ?? incidentRpc },
  );
  const stripe = makeFakeStripe({
    paymentIntentsRetrieve: () => ({ id: INTENT, status: "succeeded", amount_received: 50000, currency: "usd", metadata: { invoice_id: INVOICE, organization_id: ORG } }),
    ...options.stripe,
    webhooks: signer.webhooks,
  });
  const emitted: string[] = [];
  let serviceCreated = 0;
  const deps = {
    createService: () => ((serviceCreated += 1), db.client),
    stripe: stripe.stripe,
    env: ENV,
    emitLifecycleEvent: (async (_client: unknown, _org: string, input: { eventType: string }) => void emitted.push(input.eventType)) as never,
  };
  const incidents = () => db.rpcCalls.filter((call) => call.fn === "record_automation_incident_signal");
  return { db, stripe, deps, emitted, incidents, serviceCreated: () => serviceCreated };
}

async function body(response: Response) {
  return (await response.json()) as { ok: boolean; outcome: string; reason?: string };
}

// ---------------------------------------------------------------------------
// Signature, configuration, method
// ---------------------------------------------------------------------------

test("a valid signature is accepted; a wrong secret, tampered payload or missing header is 400 before any database work", async () => {
  const payload = eventPayload("customer.created", { id: "cus_1" });
  const ok = setup();
  assert.equal((await handleConnectWebhook(signedRequest(payload), ok.deps)).status, 200);

  const tampered = payload.replace("cus_1", "cus_2");
  const cases: [string, Request][] = [
    ["wrong secret", signedRequest(payload, { secret: "whsec_someone_else" })],
    ["tampered payload", signedRequest(tampered, { signature: signer.webhooks.generateTestHeaderString({ payload, secret: SECRET }) })],
    ["garbage signature", signedRequest(payload, { signature: "t=1,v1=deadbeef" })],
    ["missing header", signedRequest(payload, { signature: null })],
  ];
  for (const [label, request] of cases) {
    const ctx = setup();
    const response = await handleConnectWebhook(request, ctx.deps);
    assert.equal(response.status, 400, label);
    assert.deepEqual(await body(response), { ok: false, outcome: "invalid_signature" });
    assert.equal(ctx.serviceCreated(), 0, label);
  }
});

test("an unset STRIPE_CONNECT_WEBHOOK_SECRET is 500 (a retry after configuration helps); nothing is read", async () => {
  const ctx = setup();
  const response = await handleConnectWebhook(signedRequest(eventPayload("account.updated", { id: ACCT })), { ...ctx.deps, env: {} as NodeJS.ProcessEnv });
  assert.equal(response.status, 500);
  assert.equal(ctx.serviceCreated(), 0);
});

test("live key refusal: with the real guarded client and a live key outside Vercel Production, the webhook refuses (500) before verifying or reading anything", async () => {
  const db = makeFakeSupabase({ organizations: organizations() });
  let serviceCreated = 0;
  const response = await withStripeKey("sk_live_guard_unit_test_only", () =>
    handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session())), { createService: () => ((serviceCreated += 1), db.client), env: ENV }),
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await body(response), { ok: false, outcome: "not_configured" });
  assert.equal(serviceCreated, 0);
  assert.equal(db.calls.length, 0);
});

test("only POST is handled", async () => {
  const ctx = setup();
  const response = await handleConnectWebhook(new Request("http://localhost:3000/api/webhooks/stripe-connect", { method: "GET" }), ctx.deps);
  assert.equal(response.status, 405);
  assert.equal(ctx.serviceCreated(), 0);
});

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

test("an event with no event.account (a platform event) is ignored with 200, before any database work", async () => {
  for (const type of ["checkout.session.completed", "account.updated", "charge.refunded"]) {
    const ctx = setup();
    const response = await handleConnectWebhook(signedRequest(eventPayload(type, type === "checkout.session.completed" ? session() : { id: "x" }, null)), ctx.deps);
    assert.equal(response.status, 200, type);
    assert.deepEqual(await body(response), { ok: true, outcome: "ignored", reason: "no_connected_account" });
    assert.equal(ctx.serviceCreated(), 0);
  }
});

test("unrelated event types are acknowledged and ignored with 200 - no database or Stripe call", async () => {
  for (const type of ["payment_intent.succeeded", "customer.created", "checkout.session.expired", "checkout.session.async_payment_succeeded"]) {
    const ctx = setup();
    const response = await handleConnectWebhook(signedRequest(eventPayload(type, { id: "obj_1" })), ctx.deps);
    assert.equal(response.status, 200, type);
    assert.deepEqual(await body(response), { ok: true, outcome: "ignored", reason: "unhandled_event_type" });
    assert.equal(ctx.db.calls.length, 0);
    assert.equal(ctx.stripe.calls.length, 0);
  }
});

// ---------------------------------------------------------------------------
// account.updated
// ---------------------------------------------------------------------------

test("account.updated re-reads the account from Stripe (by the signed event.account) and stores THAT - the payload is not trusted", async () => {
  // Stripe's fresh v2 record: card payments still pending, payouts pending, no outstanding requirements.
  const ctx = setup({ stripe: { v2AccountsRetrieve: () => v2Account({ card: "pending", payouts: "pending", requirements: [] }) } });
  // The payload claims charges are enabled; Stripe's own record says no.
  const response = await handleConnectWebhook(signedRequest(eventPayload("account.updated", { id: ACCT, charges_enabled: true, payouts_enabled: true })), ctx.deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true, outcome: "synced" });
  assert.deepEqual(ctx.stripe.calls.map((call) => call.method), ["v2.core.accounts.retrieve"]);
  assert.deepEqual(ctx.stripe.calls[0].args, [ACCT, { include: ["configuration.merchant", "requirements"] }], "a fresh v2 retrieve of event.account");
  assert.equal(ctx.db.tables.organizations[0].stripe_connect_charges_enabled, false);
  assert.equal(ctx.db.tables.organizations[0].stripe_connect_details_submitted, true);
});

test("account.updated for a v2 account (Accounts v2 still emits this v1 snapshot event): charges become enabled only when the FRESH v2 card_payments status is active", async () => {
  const ctx = setup({ stripe: { v2AccountsRetrieve: () => v2Account({ card: "active", payouts: "active", requirements: [{ status: "eventually_due" }] }) } });
  // A v1-shaped payload, as Stripe sends for v2 accounts; its flags are irrelevant.
  const response = await handleConnectWebhook(signedRequest(eventPayload("account.updated", { id: ACCT, object: "account", charges_enabled: false, payouts_enabled: false, details_submitted: false })), ctx.deps);
  assert.deepEqual(await body(response), { ok: true, outcome: "synced" });
  const org = ctx.db.tables.organizations[0];
  assert.deepEqual([org.stripe_connect_charges_enabled, org.stripe_connect_payouts_enabled, org.stripe_connect_details_submitted], [true, true, true]);
});

test("account.updated: the payload's own account id never selects the account - event.account does", async () => {
  const ctx = setup({ stripe: { v2AccountsRetrieve: (id) => v2Account({ id, card: "active" }) } });
  await handleConnectWebhook(signedRequest(eventPayload("account.updated", { id: OTHER_ACCT, charges_enabled: true })), ctx.deps);
  assert.deepEqual(ctx.stripe.calls.map((call) => call.args[0]), [ACCT]);
  assert.equal(ctx.db.tables.organizations[1].stripe_connect_charges_enabled, false, "the other organization is untouched");
});

test("account.updated: unknown account -> 200 ignored (no Stripe call); organization mismatch -> 200 ok:false; Stripe down or storage failure -> 500 retry", async () => {
  const unknown = setup();
  const unknownResponse = await handleConnectWebhook(signedRequest(eventPayload("account.updated", { id: "acct_1NobodyOwnsThis0000" }, "acct_1NobodyOwnsThis0000")), unknown.deps);
  assert.equal(unknownResponse.status, 200);
  assert.deepEqual(await body(unknownResponse), { ok: true, outcome: "ignored", reason: "unknown_account" });
  assert.equal(unknown.stripe.calls.length, 0);

  const mismatch = setup({ stripe: { v2AccountsRetrieve: () => v2Account({ card: "active", organizationId: OTHER_ORG }) } });
  const mismatchResponse = await handleConnectWebhook(signedRequest(eventPayload("account.updated", { id: ACCT })), mismatch.deps);
  assert.equal(mismatchResponse.status, 200);
  assert.deepEqual(await body(mismatchResponse), { ok: false, outcome: "not_applied", reason: "account_mismatch" });
  assert.equal(mismatch.db.writes().length, 0);

  const down = setup({ stripe: { v2AccountsRetrieve: () => { throw stripeApiError("down"); } } });
  const downResponse = await handleConnectWebhook(signedRequest(eventPayload("account.updated", { id: ACCT })), down.deps);
  assert.equal(downResponse.status, 500);
  assert.deepEqual(await body(downResponse), { ok: false, outcome: "retry", reason: "stripe_unavailable" });
});

// ---------------------------------------------------------------------------
// checkout.session.completed
// ---------------------------------------------------------------------------

test("checkout.session.completed: a verified invoice payment is recorded through online-payment.ts - one card_online insert, the invoice moved only by the (emulated) trigger", async () => {
  const ctx = setup();
  const response = await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session())), ctx.deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true, outcome: "recorded" });
  const writes = ctx.db.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].table, "customer_payments");
  assert.equal((writes[0].payload as Row).method, "card_online");
  assert.equal((writes[0].payload as Row).organization_id, ORG);
  assert.equal((writes[0].payload as Row).stripe_account_id, ACCT);
  assert.equal(ctx.db.writes("invoices").length, 0, "the webhook never writes invoices");
  assert.deepEqual(ctx.stripe.calls.map((call) => [call.method, (call.args[2] as Stripe.RequestOptions | undefined)?.stripeAccount]), [["paymentIntents.retrieve", ACCT]]);
  assert.deepEqual(ctx.emitted, ["payment.recorded", "invoice.paid"]);
});

test("checkout.session.completed: a replayed / duplicate event is 200 duplicate - no Stripe call, no insert, no lifecycle event", async () => {
  const ctx = setup({ payments: [{ id: "pay-existing", organization_id: ORG, invoice_id: INVOICE, stripe_checkout_session_id: SESSION, stripe_payment_intent_id: INTENT }] });
  const payload = eventPayload("checkout.session.completed", session());
  for (let i = 0; i < 2; i += 1) {
    const response = await handleConnectWebhook(signedRequest(payload), ctx.deps);
    assert.equal(response.status, 200);
    assert.deepEqual(await body(response), { ok: true, outcome: "duplicate" });
  }
  assert.equal(ctx.db.writes().length, 0);
  assert.equal(ctx.stripe.calls.length, 0);
  assert.deepEqual(ctx.emitted, []);
});

test("checkout.session.completed: non-payment sessions and non-invoice payment sessions are ignored with 200", async () => {
  const subscription = setup();
  const subscriptionResponse = await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session({ mode: "subscription" }))), subscription.deps);
  assert.deepEqual(await body(subscriptionResponse), { ok: true, outcome: "ignored", reason: "not_payment_mode" });

  const other = setup();
  const otherResponse = await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session({}, { trackpr_kind: "something_else" }))), other.deps);
  assert.deepEqual(await body(otherResponse), { ok: true, outcome: "ignored", reason: "not_invoice_payment" });

  const unpaid = setup();
  const unpaidResponse = await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session({ payment_status: "unpaid" }))), unpaid.deps);
  assert.deepEqual(await body(unpaidResponse), { ok: true, outcome: "ignored", reason: "not_paid" });
  for (const ctx of [subscription, other, unpaid]) assert.equal(ctx.db.writes().length, 0);
});

test("wrong connected account: an event from ANOTHER organization's account naming this organization in metadata raises the incident in the ACCOUNT owner's organization - metadata never selects the organization", async () => {
  const ctx = setup();
  const response = await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session(), OTHER_ACCT)), ctx.deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: false, outcome: "reconciliation_required", reason: "organization_mismatch" });
  const [incident] = ctx.incidents();
  assert.equal(incident.args.p_organization_id, OTHER_ORG);
  assert.equal(ctx.db.writes("customer_payments").length, 0);
});

test("an account no organization owns is 200 ok:false unattributable (logged; a retry cannot help) - nothing recorded", async () => {
  const ctx = setup();
  const response = await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session(), "acct_1NobodyOwnsThis0000")), ctx.deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: false, outcome: "unattributable" });
  assert.equal(ctx.db.writes().length, 0);
  assert.equal(ctx.incidents().length, 0);
});

test("mismatched metadata, invalid session/payment intent ids and amount mismatches are 200 reconciliation_required after the incident is recorded", async () => {
  const cases: [Record<string, unknown>, Record<string, string>, string][] = [
    [{}, { organization_id: OTHER_ORG }, "organization_mismatch"],
    [{ payment_intent: "not_a_pi" }, {}, "invalid_identifiers"],
    [{ id: "cs_bad" }, {}, "invalid_identifiers"],
    [{}, { invoice_id: "not-a-uuid" }, "invalid_identifiers"],
    [{ amount_total: 49999 }, {}, "amount_mismatch"],
    [{ currency: "eur" }, {}, "amount_mismatch"],
  ];
  for (const [overrides, metadata, reason] of cases) {
    const ctx = setup();
    const response = await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session(overrides, metadata))), ctx.deps);
    assert.equal(response.status, 200, reason);
    assert.deepEqual(await body(response), { ok: false, outcome: "reconciliation_required", reason });
    assert.equal(ctx.incidents().length, 1);
    assert.equal(ctx.incidents()[0].args.p_organization_id, ORG);
    assert.equal(ctx.db.writes("customer_payments").length, 0);
  }
});

test("PaymentIntent metadata mismatch and a database rejection are 200 reconciliation_required; the invoice is untouched", async () => {
  const pi = setup({ stripe: { paymentIntentsRetrieve: () => ({ id: INTENT, status: "succeeded", amount_received: 50000, currency: "usd", metadata: { invoice_id: INVOICE, organization_id: OTHER_ORG } }) } });
  assert.deepEqual(await body(await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session())), pi.deps)), { ok: false, outcome: "reconciliation_required", reason: "payment_intent_mismatch" });

  const rejected = setup({ insertError: { code: "P0001", message: "Payment of 500.00 would exceed the balance due of 300.00" } });
  const response = await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session())), rejected.deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: false, outcome: "reconciliation_required", reason: "database_rejected" });
  assert.equal(rejected.db.tables.invoices[0].status, "sent");
  assert.deepEqual(rejected.emitted, []);
});

test("failed outcomes where a retry helps are 500: Stripe unreachable while verifying, or the reconciliation incident could not be written", async () => {
  const down = setup({ stripe: { paymentIntentsRetrieve: () => { throw stripeApiError("connection reset"); } } });
  const downResponse = await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session())), down.deps);
  assert.equal(downResponse.status, 500);
  assert.deepEqual(await body(downResponse), { ok: false, outcome: "retry", reason: "stripe_unavailable" });
  assert.equal(down.db.writes().length, 0);

  const noIncident = setup({ insertError: { code: "P0001", message: "rejected" }, rpc: () => ({ data: null, error: { code: "XX000", message: "incident write failed" } }) });
  const noIncidentResponse = await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session())), noIncident.deps);
  assert.equal(noIncidentResponse.status, 500);
  assert.deepEqual(await body(noIncidentResponse), { ok: false, outcome: "retry", reason: "incident_not_recorded" });
});

test("no client-controlled selection: query-string organization/account parameters on the webhook URL change nothing", async () => {
  const ctx = setup();
  const request = signedRequest(eventPayload("checkout.session.completed", session()), { url: `http://localhost:3000/api/webhooks/stripe-connect?organization_id=${OTHER_ORG}&account=${OTHER_ACCT}` });
  assert.deepEqual(await body(await handleConnectWebhook(request, ctx.deps)), { ok: true, outcome: "recorded" });
  assert.equal((ctx.db.writes("customer_payments")[0].payload as Row).organization_id, ORG);
  assert.deepEqual(ctx.db.calls.find((call) => call.table === "organizations")?.filters, [["eq", "stripe_connect_account_id", ACCT]]);
});

test("response bodies never carry ids, amounts or Stripe messages", async () => {
  const ctx = setup({ insertError: { code: "P0001", message: `Payment for ${INVOICE} refused XYZZY-DB-MESSAGE` } });
  const text = await (await handleConnectWebhook(signedRequest(eventPayload("checkout.session.completed", session())), ctx.deps)).text();
  for (const secret of [INVOICE, ORG, ACCT, SESSION, INTENT, "50000", "XYZZY-DB-MESSAGE"]) assert.equal(text.includes(secret), false, secret);
});

// ---------------------------------------------------------------------------
// Refunds and disputes: incident, ledger unchanged
// ---------------------------------------------------------------------------

const RECORDED = { id: "pay-online", organization_id: ORG, invoice_id: INVOICE, amount: 500, method: "card_online", stripe_account_id: ACCT, stripe_checkout_session_id: SESSION, stripe_payment_intent_id: INTENT };

test("charge.refunded for Trackpr's payment raises an incident and leaves the ledger unchanged (200 ok:false)", async () => {
  const ctx = setup({ payments: [{ ...RECORDED }], invoice: { status: "paid", amount_paid: 500, balance_due: 0 } });
  const charge = { id: "ch_1", object: "charge", payment_intent: INTENT, amount_refunded: 50000, currency: "usd", refunds: { object: "list", data: [{ id: "re_1", amount: 50000, currency: "usd" }] } };
  const response = await handleConnectWebhook(signedRequest(eventPayload("charge.refunded", charge)), ctx.deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: false, outcome: "reconciliation_required", reason: "refunded" });
  const [incident] = ctx.incidents();
  assert.equal(incident.args.p_category, "online_payment_reconciliation");
  assert.equal(incident.args.p_severity, "warning");
  assert.equal(incident.args.p_fingerprint, "online_payment_reconciliation:refunded:re_1");
  assert.equal((incident.args.p_metadata as Row).customer_payment_id, "pay-online");
  assert.equal(ctx.db.writes().length, 0, "no ledger or invoice write");
  assert.equal(ctx.db.tables.invoices[0].status, "paid");
});

test("charge.dispute.created for Trackpr's payment raises a critical incident; a refund/dispute on a charge Trackpr never recorded is ignored", async () => {
  const ctx = setup({ payments: [{ ...RECORDED }] });
  const dispute = { id: "dp_1", object: "dispute", payment_intent: INTENT, charge: "ch_1", amount: 50000, currency: "usd" };
  assert.deepEqual(await body(await handleConnectWebhook(signedRequest(eventPayload("charge.dispute.created", dispute)), ctx.deps)), { ok: false, outcome: "reconciliation_required", reason: "disputed" });
  assert.equal(ctx.incidents()[0].args.p_severity, "critical");
  assert.equal(ctx.db.writes().length, 0);

  const foreign = setup();
  const response = await handleConnectWebhook(signedRequest(eventPayload("charge.refunded", { id: "ch_2", object: "charge", payment_intent: "pi_3NotTrackpr0001", amount_refunded: 100, currency: "usd", refunds: { data: [] } })), foreign.deps);
  assert.deepEqual(await body(response), { ok: true, outcome: "ignored", reason: "not_trackpr_payment" });
  assert.equal(foreign.incidents().length, 0);
});

test("a refund for a payment recorded under a DIFFERENT account/organization is ignored, never attached across organizations", async () => {
  const ctx = setup({ payments: [{ ...RECORDED }] });
  const response = await handleConnectWebhook(signedRequest(eventPayload("charge.refunded", { id: "ch_1", object: "charge", payment_intent: INTENT, amount_refunded: 50000, currency: "usd", refunds: { data: [] } }, OTHER_ACCT)), ctx.deps);
  assert.deepEqual(await body(response), { ok: true, outcome: "ignored", reason: "not_trackpr_payment" });
  assert.equal(ctx.incidents().length, 0);
});

test("a refund/dispute incident that cannot be written is 500 so Stripe retries", async () => {
  const ctx = setup({ payments: [{ ...RECORDED }], rpc: () => ({ data: null, error: { code: "XX000", message: "down" } }) });
  const response = await handleConnectWebhook(signedRequest(eventPayload("charge.dispute.created", { id: "dp_1", object: "dispute", payment_intent: INTENT, amount: 50000, currency: "usd" })), ctx.deps);
  assert.equal(response.status, 500);
});

// ---------------------------------------------------------------------------
// Structural
// ---------------------------------------------------------------------------

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("structural: the route exports POST only and wires handleConnectWebhook with the service client; the handler uses the guarded client and its own secret", () => {
  const route = read("app/api/webhooks/stripe-connect/route.ts");
  assert.match(route, /export async function POST\(/);
  assert.doesNotMatch(route, /export (async )?function (GET|PUT|PATCH|DELETE)\b/);
  assert.match(route, /handleConnectWebhook\(request, \{ createService: createServiceRoleClient \}\)/);
  assert.doesNotMatch(route, /from "stripe"|getStripeClient|new\s+Stripe\s*\(|STRIPE_WEBHOOK_SECRET/);

  const handler = read("lib/payments/connect-webhook.ts");
  assert.match(handler, /paymentsStripe\(\{ stripe: deps\.stripe \}\)/);
  assert.match(handler, /\.STRIPE_CONNECT_WEBHOOK_SECRET\b/);
  assert.doesNotMatch(handler, /\bSTRIPE_WEBHOOK_SECRET\b/, "never the platform subscription webhook's secret");
  assert.doesNotMatch(handler, /getStripeClient|new\s+Stripe\s*\(|@\/lib\/billing\/stripe"/);
  assert.doesNotMatch(handler, /\.from\("invoices"\)\.update|amount_paid|payment_status/, "never touches invoice money or subscription status");
});

test("structural: no Supabase project reference (production or otherwise) or live key in any Phase 1C source file", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    const root = path.join(process.cwd(), dir);
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) files.push(rel);
    }
  };
  for (const dir of ["lib/payments", "app/pay", "app/api/payments", "app/api/webhooks/stripe-connect"]) walk(dir);
  assert.ok(files.length >= 10);
  for (const file of files) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    // No Supabase project host at all (so no production project ref), and no live Stripe key.
    assert.doesNotMatch(source, /[a-z0-9]{20}\.supabase\.co|sk_live_[A-Za-z0-9]|rk_live_[A-Za-z0-9]/, file);
  }
});
