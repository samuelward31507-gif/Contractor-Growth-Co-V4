/**
 * Phase 1C, Step 5: unit tests for lib/payments/pay-page-view.ts - the public
 * pay page's states, labels and notices. Pure functions, no I/O. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/payments/pay-page-view.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { PublicInvoice } from "./public-invoice";

const require = createRequire(import.meta.url);
const { describePayPage, formatCalendarDate, formatPhone }: typeof import("./pay-page-view") = require("./pay-page-view.ts");

function invoice(overrides: Partial<PublicInvoice> = {}): PublicInvoice {
  return {
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
    ...overrides,
  };
}

test("valid payable invoice: business name, phone, invoice number, title, balance due, due date and Pay now", () => {
  const view = describePayPage(invoice(), {});
  assert.equal(view.state, "payable");
  assert.equal(view.notice, null);
  assert.deepEqual(view.invoice, {
    organizationName: "Acme Roofing",
    organizationPhoneDisplay: "(555) 123-0000",
    organizationPhoneHref: "tel:+15551230000",
    label: "INV-000042",
    title: "Roof repair",
    balanceDueLabel: "$500",
    totalLabel: "$500",
    amountPaidLabel: null,
    dueDateLabel: "October 15, 2026",
    paidDateLabel: null,
    overdue: false,
  });
});

test("a partially paid invoice shows the remaining balance with what was already paid", () => {
  const view = describePayPage(invoice({ status: "partially_paid", amountPaid: 125.5, balanceDue: 374.5 }), {});
  assert.equal(view.state, "payable");
  assert.equal(view.invoice?.balanceDueLabel, "$374.50");
  assert.equal(view.invoice?.amountPaidLabel, "$125.50");
});

test("unknown / draft / void tokens (null projection) all render the one unavailable state, with no invoice details", () => {
  assert.deepEqual(describePayPage(null, {}), { state: "unavailable", notice: null, invoice: null });
  assert.deepEqual(describePayPage(null, { checkout: "success" }), { state: "unavailable", notice: null, invoice: null }, "a query code can't reveal anything about a missing invoice");
});

test("a paid invoice shows paid, never Pay now", () => {
  const view = describePayPage(invoice({ status: "paid", amountPaid: 500, balanceDue: 0, paidAt: "2026-10-03T12:00:00.000Z", onlinePayment: { available: false, reason: "paid" } }), {});
  assert.equal(view.state, "paid");
  assert.ok(view.invoice?.paidDateLabel);
});

test("Connect unavailable or subscription inactive (both surface only as 'not accepting online payments') -> offline state, no reason disclosed", () => {
  const view = describePayPage(invoice({ onlinePayment: { available: false, reason: "not_accepting_online_payments" } }), {});
  assert.equal(view.state, "offline");
  assert.equal(JSON.stringify(view).includes("subscription"), false);
  assert.equal(JSON.stringify(view).includes("Stripe"), false);
});

test("returning from Stripe: success shows 'confirming' until the database says paid, then 'received'; cancel says no charge", () => {
  assert.equal(describePayPage(invoice(), { checkout: "success" }).notice?.tone, "info");
  assert.match(describePayPage(invoice(), { checkout: "success" }).notice?.message ?? "", /confirming/);
  const paid = invoice({ status: "paid", amountPaid: 500, balanceDue: 0, onlinePayment: { available: false, reason: "paid" } });
  assert.deepEqual(describePayPage(paid, { checkout: "success" }).notice, { tone: "success", message: "Payment received. Thank you!" });
  assert.deepEqual(describePayPage(invoice(), { checkout: "cancelled" }).notice, { tone: "info", message: "Payment cancelled - you haven't been charged." });
});

test("route codes map to fixed messages; unknown or repeated codes render nothing", () => {
  assert.equal(describePayPage(invoice(), { checkout: "paid" }).notice?.message, "This invoice has already been paid.");
  assert.match(describePayPage(invoice(), { checkout: "unavailable" }).notice?.message ?? "", /Acme Roofing at \(555\) 123-0000/);
  assert.equal(describePayPage(invoice(), { checkout: "error" }).notice?.tone, "error");
  assert.equal(describePayPage(invoice(), { checkout: "<script>" }).notice, null);
  assert.equal(describePayPage(invoice(), { checkout: ["success", "error"] }).notice, null);
});

test("overdue is shown; dates render without timezone drift; odd phone numbers are shown but not linked", () => {
  assert.equal(describePayPage(invoice({ overdue: true }), {}).invoice?.overdue, true);
  assert.equal(formatCalendarDate("2026-01-01"), "January 1, 2026");
  assert.equal(formatCalendarDate("not-a-date"), null);
  assert.equal(formatPhone("+442071234567"), "+442071234567");
  const odd = describePayPage(invoice({ organizationPhone: "call us: 555" }), {});
  assert.equal(odd.invoice?.organizationPhoneDisplay, "call us: 555");
  assert.equal(odd.invoice?.organizationPhoneHref, null);
  assert.equal(describePayPage(invoice({ organizationPhone: null }), {}).invoice?.organizationPhoneDisplay, null);
});
