/**
 * Phase 1C: unit tests for lib/payments/online-payment.ts - recording a
 * Stripe-confirmed invoice payment. Fake Supabase and fake Stripe only. Run:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/online-payment.test.ts
 *
 * What these prove: every verification step, that the only ledger write is
 * one card_online insert (the invoice itself is never updated here - the fake
 * emulates customer_payments_apply the way the database trigger would), that
 * replays are idempotent, and that every Stripe-success/ledger-failure path
 * raises a reconciliation incident and is never reported as recorded. The
 * database's own enforcement of the same rules is proven separately by
 * supabase/pending/scratch/validate-online-payments.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type Stripe from "stripe";
import { makeFakeStripe, makeFakeSupabase, stripeApiError, withStripeKey, type DbError, type Row } from "./test-fakes";

const require = createRequire(import.meta.url);
const { recordOnlineInvoicePayment }: typeof import("./online-payment") = require("./online-payment.ts");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const INVOICE = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const CONTACT = "55555555-5555-4555-8555-555555555555";
const ACCT = "acct_1TestConnect000001";
const SESSION = "cs_test_a1B2c3D4e5";
const INTENT = "pi_3TestIntent0001";
const CREATED = 1791000000;

type Emitted = { organizationId: string; eventType: string; input: Row };

function organizations(): Row[] {
  return [
    { id: ORG, stripe_connect_account_id: ACCT },
    { id: OTHER_ORG, stripe_connect_account_id: "acct_1OtherOrg0000000001" },
  ];
}

function invoiceRow(overrides: Partial<Row> = {}): Row {
  return { id: INVOICE, organization_id: ORG, job_id: JOB, contact_id: CONTACT, number: 42, status: "sent", total: 500, amount_paid: 0, balance_due: 500, paid_at: null, ...overrides };
}

function session(overrides: Partial<Stripe.Checkout.Session> = {}, metadata: Record<string, string> = {}): Stripe.Checkout.Session {
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
  } as Stripe.Checkout.Session;
}

function intent(overrides: Partial<Stripe.PaymentIntent> = {}): Partial<Stripe.PaymentIntent> {
  return { id: INTENT, status: "succeeded", amount_received: 50000, currency: "usd", metadata: { invoice_id: INVOICE, organization_id: ORG }, ...overrides };
}

/** Emulates customer_payments_guard_insert + customer_payments_apply on the fake tables. */
function ledgerTriggers(table: string, row: Row, tables: Record<string, Row[]>): Row {
  if (table !== "customer_payments") return row;
  const invoice = tables.invoices.find((inv) => inv.id === row.invoice_id)!;
  const paidCents = Math.round(Number(invoice.amount_paid) * 100) + Math.round(Number(row.amount) * 100);
  const totalCents = Math.round(Number(invoice.total) * 100);
  invoice.amount_paid = paidCents / 100;
  invoice.balance_due = (totalCents - paidCents) / 100;
  invoice.status = paidCents >= totalCents ? "paid" : "partially_paid";
  invoice.paid_at = paidCents >= totalCents ? "2026-10-05T12:00:00.000Z" : null;
  return row;
}

const incidentRpc = (fn: string, args: Row) =>
  fn === "record_automation_incident_signal"
    ? { data: { id: "incident-1", organization_id: args.p_organization_id, category: args.p_category, severity: args.p_severity, status: "open", fingerprint: args.p_fingerprint, title: args.p_title, metadata: args.p_metadata, occurrence_count: 1 }, error: null }
    : { data: {}, error: null };

function setup(options: { invoice?: Partial<Row>; payments?: Row[]; insertError?: (row: Row, tables: Record<string, Row[]>) => DbError | null; rpc?: (fn: string, args: Row) => { data: unknown; error: DbError | null }; intent?: () => Partial<Stripe.PaymentIntent> } = {}) {
  const db = makeFakeSupabase(
    { organizations: organizations(), invoices: [invoiceRow(options.invoice)], customer_payments: options.payments ?? [] },
    { onInsert: ledgerTriggers, insertError: options.insertError ? (table, row, tables) => (table === "customer_payments" ? options.insertError!(row, tables) : null) : undefined, rpc: options.rpc ?? incidentRpc },
  );
  const stripe = makeFakeStripe({ paymentIntentsRetrieve: options.intent ?? (() => intent()) });
  const emitted: Emitted[] = [];
  const emitLifecycleEvent = async (_client: unknown, organizationId: string, input: { eventType: string } & Row) => {
    emitted.push({ organizationId, eventType: input.eventType, input });
  };
  const deps = { stripe: stripe.stripe, emitLifecycleEvent: emitLifecycleEvent as never };
  const run = (overrides: Partial<Stripe.Checkout.Session> = {}, metadata: Record<string, string> = {}, event: { account?: string | null } = {}) =>
    recordOnlineInvoicePayment(db.client, { eventId: "evt_1", account: "account" in event ? event.account : ACCT, created: CREATED, session: session(overrides, metadata) }, deps);
  const incidents = () => db.rpcCalls.filter((call) => call.fn === "record_automation_incident_signal");
  return { db, stripe, emitted, run, incidents, seededPayments: options.payments?.length ?? 0 };
}

function assertNoLedgerChange(ctx: ReturnType<typeof setup>, label: string, options: { insertAttempted?: boolean } = {}) {
  // A database rejection means exactly one insert was ATTEMPTED and refused;
  // every other path must never reach the insert at all.
  assert.equal(ctx.db.writes("customer_payments").length, options.insertAttempted ? 1 : 0, `${label}: payment insert attempts`);
  assert.equal(ctx.db.tables.customer_payments.length, ctx.seededPayments, `${label}: no payment row persisted`);
  assert.equal(ctx.db.writes("invoices").length, 0, `${label}: invoices never written`);
  assert.equal(ctx.emitted.length, 0, `${label}: no lifecycle event`);
}

// ---------------------------------------------------------------------------
// Ignored
// ---------------------------------------------------------------------------

test("sessions that are not Trackpr invoice payments, or not paid, are ignored: no reads beyond the event, no Stripe call, no write, no incident", async () => {
  const cases: [Partial<Stripe.Checkout.Session>, Record<string, string>, string][] = [
    [{ mode: "subscription" }, {}, "not_invoice_payment"],
    [{}, { trackpr_kind: "something_else" }, "not_invoice_payment"],
    [{ metadata: null }, {}, "not_invoice_payment"],
    [{ payment_status: "unpaid" }, {}, "not_paid"],
    [{ payment_status: "no_payment_required" }, {}, "not_paid"],
  ];
  for (const [overrides, metadata, reason] of cases) {
    const ctx = setup();
    const result = await ctx.run(overrides, metadata);
    assert.deepEqual(result, { kind: "ignored", reason }, JSON.stringify(overrides));
    assert.equal(ctx.db.calls.length, 0);
    assert.equal(ctx.stripe.calls.length, 0);
    assert.equal(ctx.incidents().length, 0);
  }
});

// ---------------------------------------------------------------------------
// Recorded
// ---------------------------------------------------------------------------

test("a verified full payment inserts exactly one card_online row through the ledger, and the DATABASE (not this code) marks the invoice paid", async () => {
  const ctx = setup();
  const result = await ctx.run();
  assert.deepEqual(result, { kind: "recorded", organizationId: ORG, invoiceId: INVOICE, paymentId: "customer_payments-1", invoiceStatus: "paid" });

  const writes = ctx.db.writes();
  assert.equal(writes.length, 1, "the only write is the one insert");
  assert.equal(writes[0].table, "customer_payments");
  assert.equal(writes[0].op, "insert");
  assert.deepEqual(writes[0].payload, {
    organization_id: ORG,
    invoice_id: INVOICE,
    job_id: JOB,
    contact_id: CONTACT,
    amount: 500,
    method: "card_online",
    reference: null,
    received_at: new Date(CREATED * 1000).toISOString(),
    notes: null,
    stripe_checkout_session_id: SESSION,
    stripe_payment_intent_id: INTENT,
    stripe_account_id: ACCT,
  });
  assert.equal(ctx.db.tables.invoices[0].status, "paid", "set by the emulated trigger");

  // The PaymentIntent was re-read from Stripe ON the connected account.
  assert.deepEqual(ctx.stripe.calls.map((call) => call.method), ["paymentIntents.retrieve"]);
  assert.equal(ctx.stripe.calls[0].args[0], INTENT);
  assert.deepEqual(ctx.stripe.calls[0].args[2], { stripeAccount: ACCT });

  assert.deepEqual(ctx.emitted.map((event) => [event.organizationId, event.eventType]), [[ORG, "payment.recorded"], [ORG, "invoice.paid"]]);
  const recorded = ctx.emitted[0].input as { paymentId: string; payload: Row };
  assert.equal(recorded.paymentId, "customer_payments-1");
  assert.equal(recorded.payload.method, "card_online");
  assert.equal(recorded.payload.invoice_status_after, "paid");
  assert.equal(recorded.payload.amount_paid_after, 500);
  const paid = ctx.emitted[1].input as { completingPaymentId: string; payload: Row };
  assert.equal(paid.completingPaymentId, "customer_payments-1");
  assert.equal(paid.payload.total, 500);
  assert.equal(ctx.incidents().length, 0);
});

test("a legitimate payment smaller than the balance (the balance grew after checkout) is recorded as partial; only payment.recorded is emitted", async () => {
  const ctx = setup({ invoice: { total: 800, balance_due: 800 } });
  const result = await ctx.run();
  assert.equal(result.kind, "recorded");
  if (result.kind === "recorded") assert.equal(result.invoiceStatus, "partially_paid");
  assert.deepEqual(ctx.emitted.map((event) => event.eventType), ["payment.recorded"]);
});

test("the organization is resolved from the signed event's connected account, never from metadata", async () => {
  const ctx = setup();
  await ctx.run();
  const orgLookup = ctx.db.calls.find((call) => call.table === "organizations")!;
  assert.deepEqual(orgLookup.filters, [["eq", "stripe_connect_account_id", ACCT]]);
  const invoiceLookup = ctx.db.calls.find((call) => call.table === "invoices")!;
  assert.deepEqual(invoiceLookup.filters, [["eq", "id", INVOICE], ["eq", "organization_id", ORG]]);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("a replayed event for an already-recorded session is a duplicate: no Stripe call, no insert, no lifecycle event, no incident", async () => {
  const ctx = setup({ payments: [{ id: "pay-existing", organization_id: ORG, invoice_id: INVOICE, stripe_checkout_session_id: SESSION, stripe_payment_intent_id: INTENT }] });
  assert.deepEqual(await ctx.run(), { kind: "duplicate", organizationId: ORG, invoiceId: INVOICE, paymentId: "pay-existing" });
  assert.equal(ctx.stripe.calls.length, 0);
  assertNoLedgerChange(ctx, "replay");
  assert.equal(ctx.incidents().length, 0);
});

test("two deliveries racing past the pre-check: the unique index decides, the loser resolves to the winner's row", async () => {
  for (const index of ["customer_payments_stripe_checkout_session_unique", "customer_payments_stripe_payment_intent_unique"]) {
    const ctx = setup({
      insertError: (_row, tables) => {
        tables.customer_payments.push({ id: "pay-winner", organization_id: ORG, invoice_id: INVOICE, stripe_checkout_session_id: SESSION, stripe_payment_intent_id: INTENT });
        return { code: "23505", message: `duplicate key value violates unique constraint "${index}"` };
      },
    });
    assert.deepEqual(await ctx.run(), { kind: "duplicate", organizationId: ORG, invoiceId: INVOICE, paymentId: "pay-winner" }, index);
    assert.equal(ctx.emitted.length, 0);
    assert.equal(ctx.incidents().length, 0);
  }
});

// ---------------------------------------------------------------------------
// Unattributable: no organization to raise an incident in
// ---------------------------------------------------------------------------

test("a paid invoice session with no connected account, or from an account no organization owns, fails loudly (never recorded, never acknowledged as success)", async () => {
  for (const account of [null, undefined, "", "not-an-account", "acct_1NobodyOwnsThis0000"]) {
    const ctx = setup();
    const result = await ctx.run({}, {}, { account });
    assert.equal(result.kind, "failed", String(account));
    if (result.kind === "failed") assert.equal(result.reason, "unattributable");
    assertNoLedgerChange(ctx, String(account));
    assert.equal(ctx.stripe.calls.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Reconciliation incidents: Stripe succeeded, the ledger cannot be written
// ---------------------------------------------------------------------------

async function expectReconciliation(ctx: ReturnType<typeof setup>, promise: ReturnType<ReturnType<typeof setup>["run"]>, reason: string) {
  const result = await promise;
  assert.equal(result.kind, "reconciliation_required", `${reason}: ${JSON.stringify(result)}`);
  if (result.kind === "reconciliation_required") {
    assert.equal(result.reason, reason);
    assert.equal(result.organizationId, ORG);
    assert.equal(result.incidentId, "incident-1");
  }
  assertNoLedgerChange(ctx, reason, { insertAttempted: reason === "database_rejected" });
  const [incident, ...more] = ctx.incidents();
  assert.equal(more.length, 0, "exactly one incident");
  assert.equal(incident.args.p_organization_id, ORG);
  assert.equal(incident.args.p_category, "online_payment_reconciliation");
  assert.equal(incident.args.p_severity, "critical");
  assert.equal(incident.args.p_fingerprint, `online_payment_reconciliation:${SESSION}`);
  const metadata = incident.args.p_metadata as Row;
  assert.equal(metadata.reason, reason);
  assert.equal(metadata.stripe_account_id, ACCT);
  assert.equal(metadata.stripe_checkout_session_id, SESSION);
  assert.equal(metadata.stripe_event_id, "evt_1");
  return { result, metadata, incident };
}

test("metadata naming a different organization than the account's owner raises an incident in the ACCOUNT owner's organization", async () => {
  const ctx = setup();
  await expectReconciliation(ctx, ctx.run({}, { organization_id: OTHER_ORG }), "organization_mismatch");
  assert.equal(ctx.stripe.calls.length, 0);
});

test("malformed or missing identifiers raise an incident", async () => {
  for (const [overrides, metadata] of [
    [{ payment_intent: null }, {}],
    [{ payment_intent: "not_a_pi" }, {}],
    [{ id: "cs_bad" }, {}],
    [{}, { invoice_id: "not-a-uuid" }],
  ] as [Partial<Stripe.Checkout.Session>, Record<string, string>][]) {
    const ctx = setup();
    const result = await ctx.run(overrides, metadata);
    assert.equal(result.kind, "reconciliation_required", JSON.stringify([overrides, metadata]));
    if (result.kind === "reconciliation_required") assert.equal(result.reason, "invalid_identifiers");
    assertNoLedgerChange(ctx, "identifiers");
  }
});

test("an amount that differs from the session's expected amount, is not USD, or is not positive raises an incident", async () => {
  for (const [overrides, metadata] of [
    [{ amount_total: 49999 }, {}],
    [{ currency: "eur" }, {}],
    [{ amount_total: 0 }, { expected_amount_cents: "0" }],
    [{ amount_total: null }, {}],
    [{}, { expected_amount_cents: "" }],
  ] as [Partial<Stripe.Checkout.Session>, Record<string, string>][]) {
    const ctx = setup();
    await expectReconciliation(ctx, ctx.run(overrides, metadata), "amount_mismatch");
  }
});

test("a PaymentIntent that did not succeed, or whose amount, currency or metadata disagree with the session, raises an incident", async () => {
  for (const overrides of [
    { status: "processing" },
    { amount_received: 40000 },
    { currency: "cad" },
    { metadata: { invoice_id: "66666666-6666-4666-8666-666666666666", organization_id: ORG } },
    { metadata: { invoice_id: INVOICE, organization_id: OTHER_ORG } },
    { metadata: {} },
  ] as Partial<Stripe.PaymentIntent>[]) {
    const ctx = setup({ intent: () => intent(overrides) });
    await expectReconciliation(ctx, ctx.run(), "payment_intent_mismatch");
  }
});

test("a Stripe outage while verifying the PaymentIntent fails (Stripe retries) without recording or raising an incident", async () => {
  const ctx = setup({ intent: () => { throw stripeApiError("connection reset"); } });
  const result = await ctx.run();
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.reason, "stripe_unavailable");
  assertNoLedgerChange(ctx, "stripe outage");
  assert.equal(ctx.incidents().length, 0);
});

test("the invoice missing from the organization, no longer payable, or with a smaller balance raises an incident without attempting the insert", async () => {
  const notFound = setup({ invoice: { organization_id: OTHER_ORG } });
  await expectReconciliation(notFound, notFound.run(), "invoice_not_found");

  for (const status of ["paid", "void", "draft"]) {
    const ctx = setup({ invoice: { status } });
    const { metadata } = await expectReconciliation(ctx, ctx.run(), "invoice_not_payable");
    assert.equal(metadata.invoice_status, status);
    assert.equal(metadata.invoice_number, "INV-000042");
  }

  const overBalance = setup({ invoice: { status: "partially_paid", amount_paid: 200, balance_due: 300 } });
  const { metadata } = await expectReconciliation(overBalance, overBalance.run(), "exceeds_balance");
  assert.equal(metadata.invoice_balance_due, 300);
  assert.equal(metadata.amount_cents, 50000);
});

test("when the DATABASE rejects the insert (e.g. an overpayment race), the error is not swallowed: an incident records it and nothing is reported as recorded", async () => {
  const ctx = setup({ insertError: () => ({ code: "P0001", message: "Payment of 500.00 would exceed the balance due of 300.00" }) });
  const { result, metadata, incident } = await expectReconciliation(ctx, ctx.run(), "database_rejected");
  assert.equal(result.kind, "reconciliation_required");
  assert.match(String(metadata.detail), /exceed the balance due/);
  assert.equal(metadata.stripe_payment_intent_id, INTENT);
  assert.equal(metadata.invoice_id, INVOICE);
  assert.equal(metadata.currency, "usd");
  assert.match(String(incident.args.p_title), /INV-000042/);
  assert.match(String(incident.args.p_description), /\$500/);
  assert.equal(ctx.db.tables.invoices[0].status, "sent", "the invoice is exactly as the database left it");
});

test("a unique violation on an unrelated constraint is NOT treated as a replay - it is a rejection with an incident", async () => {
  const ctx = setup({ insertError: () => ({ code: "23505", message: 'duplicate key value violates unique constraint "customer_payments_reversal_unique"' }) });
  await expectReconciliation(ctx, ctx.run(), "database_rejected");
});

test("if the incident itself cannot be recorded, the outcome is failed - never recorded, never reconciled", async () => {
  const ctx = setup({ insertError: () => ({ code: "P0001", message: "rejected" }), rpc: () => ({ data: null, error: { code: "XX000", message: "incident write failed" } }) });
  const result = await ctx.run();
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.equal(result.reason, "incident_not_recorded");
    assert.match(result.detail, /database_rejected/);
  }
  assert.equal(ctx.emitted.length, 0);
});

// ---------------------------------------------------------------------------
// Guarded client and the real service-role lifecycle emitter
// ---------------------------------------------------------------------------

test("the default Stripe client is the guarded one: with a live key outside Vercel Production verification fails and nothing is recorded", async () => {
  const db = makeFakeSupabase({ organizations: organizations(), invoices: [invoiceRow()], customer_payments: [] }, { onInsert: ledgerTriggers, rpc: incidentRpc });
  const result = await withStripeKey("sk_live_guard_unit_test_only", () => recordOnlineInvoicePayment(db.client, { eventId: "evt_1", account: ACCT, created: CREATED, session: session() }, { emitLifecycleEvent: (async () => {}) as never }));
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.reason, "stripe_unavailable");
  assert.equal(db.writes().length, 0);
});

test("without an injected hook the service-role lifecycle emitter is used: automation RPCs carry the trusted organization id", async () => {
  const rpc = (fn: string, args: Row) => {
    if (fn === "create_automation_event") return { data: { id: `evt-${String(args.p_event_type)}`, organization_id: args.p_organization_id, event_type: args.p_event_type, status: "pending", payload: args.p_payload, is_duplicate: false }, error: null };
    if (fn === "start_workflow_execution" || fn === "complete_workflow_execution") return { data: { id: "exec-1", organization_id: ORG, workflow_name: "lifecycle", attempt: 1, status: fn === "start_workflow_execution" ? "running" : "completed" }, error: null };
    return { data: {}, error: null };
  };
  const db = makeFakeSupabase({ organizations: organizations(), invoices: [invoiceRow()], customer_payments: [] }, { onInsert: ledgerTriggers, rpc });
  const stripe = makeFakeStripe({ paymentIntentsRetrieve: () => intent() });
  const result = await recordOnlineInvoicePayment(db.client, { eventId: "evt_1", account: ACCT, created: CREATED, session: session() }, { stripe: stripe.stripe });
  assert.equal(result.kind, "recorded");
  const created = db.rpcCalls.filter((call) => call.fn === "create_automation_event");
  assert.deepEqual(created.map((call) => [call.args.p_event_type, call.args.p_organization_id, call.args.p_idempotency_key]), [
    ["payment.recorded", ORG, "payment.recorded:customer_payments-1"],
    ["invoice.paid", ORG, `invoice.paid:${INVOICE}:customer_payments-1`],
  ]);
});
