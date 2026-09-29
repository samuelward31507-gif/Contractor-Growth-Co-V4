/**
 * Phase 1C: unit tests for lib/payments/public-invoice.ts - what a customer
 * holding a payment link may see. Fake Supabase only. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/public-invoice.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { makeFakeSupabase, type Row } from "./test-fakes";

const require = createRequire(import.meta.url);
const { getPublicInvoiceByPaymentToken, loadPayableInvoiceByToken }: typeof import("./public-invoice") = require("./public-invoice.ts");

const TOKEN = "a1".repeat(24);
const ORG = "11111111-1111-4111-8111-111111111111";

function invoiceRow(overrides: Partial<Row> = {}, organization: Partial<Row> = {}): Row {
  return {
    id: "33333333-3333-4333-8333-333333333333",
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
    // Present in the table, and must never reach the customer.
    notes: "INTERNAL: customer was difficult",
    void_reason: null,
    created_by: "user-1",
    organization: {
      name: "Acme Roofing",
      sms_phone_number: "+15551230000",
      timezone: "America/Denver",
      payment_status: "active",
      stripe_connect_account_id: "acct_1TestConnect000001",
      stripe_connect_charges_enabled: true,
      ...organization,
    },
    ...overrides,
  };
}

const PUBLIC_KEYS = ["amountPaid", "balanceDue", "dueDate", "issuedAt", "label", "onlinePayment", "organizationName", "organizationPhone", "overdue", "paidAt", "status", "title", "total"];

test("a malformed or unknown token resolves to nothing - malformed ones without even querying", async () => {
  const db = makeFakeSupabase({ invoices: [invoiceRow()] });
  for (const bad of ["", "abc", TOKEN.toUpperCase(), `${TOKEN}0`, "zz".repeat(24)]) {
    assert.equal(await getPublicInvoiceByPaymentToken(db.client, bad), null, bad);
  }
  assert.equal(db.calls.length, 0);
  assert.equal(await getPublicInvoiceByPaymentToken(db.client, "b2".repeat(24)), null);
});

test("drafts and void invoices resolve to nothing, as if the link did not exist", async () => {
  for (const status of ["draft", "void"]) {
    const db = makeFakeSupabase({ invoices: [invoiceRow({ status })] });
    assert.equal(await getPublicInvoiceByPaymentToken(db.client, TOKEN), null, status);
    assert.equal(await loadPayableInvoiceByToken(db.client, TOKEN), null, status);
  }
});

test("the public projection has exactly the customer-facing fields: no notes, ids, subscription status or Stripe account", async () => {
  const db = makeFakeSupabase({ invoices: [invoiceRow()] });
  const invoice = await getPublicInvoiceByPaymentToken(db.client, TOKEN, new Date("2026-10-05T12:00:00Z"));
  assert.ok(invoice);
  assert.deepEqual(Object.keys(invoice).sort(), PUBLIC_KEYS);
  assert.deepEqual(invoice, {
    label: "INV-000042",
    title: "Roof repair",
    status: "sent",
    total: 500,
    amountPaid: 0,
    balanceDue: 500,
    issuedAt: "2026-10-01T15:00:00.000Z",
    dueDate: "2026-10-15",
    paidAt: null,
    overdue: false,
    organizationName: "Acme Roofing",
    organizationPhone: "+15551230000",
    onlinePayment: { available: true },
  });
  const serialized = JSON.stringify(invoice);
  for (const secret of ["INTERNAL", "acct_", "payment_status", ORG, "44444444", "33333333", TOKEN]) assert.equal(serialized.includes(secret), false, secret);
});

test("the query selects an explicit column list that never includes notes, void_reason or created_by, and looks the invoice up by token only", async () => {
  const db = makeFakeSupabase({ invoices: [invoiceRow()] });
  await getPublicInvoiceByPaymentToken(db.client, TOKEN);
  const [call] = db.calls;
  assert.equal(call.table, "invoices");
  assert.deepEqual(call.filters, [["eq", "payment_token", TOKEN]]);
  for (const forbidden of ["notes", "void_reason", "created_by", "contact", "estimate", "*"]) assert.equal(call.columns?.includes(forbidden), false, forbidden);
  assert.equal(db.writes().length, 0);
});

test("online payment availability: paid, not accepting (without saying why), or available", async () => {
  const cases: [Partial<Row>, Partial<Row>, unknown][] = [
    [{ status: "paid", amount_paid: 500, balance_due: 0, paid_at: "2026-10-03T00:00:00.000Z" }, {}, { available: false, reason: "paid" }],
    [{}, { payment_status: "suspended" }, { available: false, reason: "not_accepting_online_payments" }],
    [{}, { stripe_connect_charges_enabled: false }, { available: false, reason: "not_accepting_online_payments" }],
    [{}, { stripe_connect_account_id: null }, { available: false, reason: "not_accepting_online_payments" }],
    [{ status: "partially_paid", amount_paid: 200, balance_due: 300 }, {}, { available: true }],
  ];
  for (const [invoiceOverrides, orgOverrides, expected] of cases) {
    const db = makeFakeSupabase({ invoices: [invoiceRow(invoiceOverrides, orgOverrides)] });
    const invoice = await getPublicInvoiceByPaymentToken(db.client, TOKEN);
    assert.deepEqual(invoice?.onlinePayment, expected, JSON.stringify([invoiceOverrides, orgOverrides]));
  }
});

test("overdue is derived in the organization's timezone; numeric strings from PostgREST become numbers", async () => {
  const db = makeFakeSupabase({ invoices: [invoiceRow({ total: "500.00", amount_paid: "125.50", balance_due: "374.50", status: "partially_paid" })] });
  // 2026-10-16 03:00 UTC is still 2026-10-15 in Denver: not overdue yet.
  const early = await getPublicInvoiceByPaymentToken(db.client, TOKEN, new Date("2026-10-16T03:00:00Z"));
  assert.equal(early?.overdue, false);
  assert.equal(early?.balanceDue, 374.5);
  assert.equal(early?.amountPaid, 125.5);
  const late = await getPublicInvoiceByPaymentToken(db.client, TOKEN, new Date("2026-10-16T18:00:00Z"));
  assert.equal(late?.overdue, true);
});
