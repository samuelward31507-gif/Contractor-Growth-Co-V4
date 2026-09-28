/**
 * Unit tests for lib/invoices/domain.ts - the pure rules behind Phase 1B's
 * invoices and customer payments. Every rule here has a twin in
 * supabase/pending/invoice_foundation.sql; supabase/pending/scratch/validate.mjs
 * proves the database half. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/invoices/domain.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addAmounts,
  applyPayment,
  assertTotalsEditable,
  calendarDateInTimeZone,
  canIssue,
  canVoid,
  computeBalanceDue,
  defaultDueDate,
  deriveInvoiceState,
  formatInvoiceNumber,
  formatMoney,
  fromCents,
  isOverdue,
  isTwoDecimalAmount,
  parseAmountInput,
  reversePayment,
  statusForAmountPaid,
  subtractAmounts,
  sumCollected,
  toCents,
  transitionInvoice,
  type InvoiceMoney,
} from "./domain";

const sent = (total: number, amountPaid = 0, dueDate: string | null = "2026-10-12"): InvoiceMoney => ({ status: "sent", total, amountPaid, dueDate });

// ---------------------------------------------------------------------------
// Amount precision
// ---------------------------------------------------------------------------

test("amounts are dollars with exactly two decimals", () => {
  assert.equal(isTwoDecimalAmount(1234.56), true);
  assert.equal(isTwoDecimalAmount(0), true);
  assert.equal(isTwoDecimalAmount(10.005), false);
  assert.equal(isTwoDecimalAmount(Number.NaN), false);
  assert.equal(isTwoDecimalAmount(Number.POSITIVE_INFINITY), false);
  assert.equal(toCents(1234.56), 123456);
  assert.equal(fromCents(123456), 1234.56);
  assert.throws(() => toCents(10.005));
});

test("arithmetic is cent-exact, never floating drift", () => {
  assert.equal(addAmounts(0.1, 0.2), 0.3);
  assert.equal(subtractAmounts(1.1, 0.2), 0.9);
  assert.equal(addAmounts(1234.56, 765.44), 2000);
});

test("parseAmountInput mirrors the job amount rules and requires a positive value by default", () => {
  assert.deepEqual(parseAmountInput(" 1300.25 "), { amount: 1300.25 });
  assert.equal(parseAmountInput("").error, "Enter an amount.");
  assert.equal(parseAmountInput("abc").error, "Enter a valid amount.");
  assert.equal(parseAmountInput("-1").error, "Amount cannot be negative.");
  assert.equal(parseAmountInput("0").error, "Amount must be more than zero.");
  assert.deepEqual(parseAmountInput("0", { allowZero: true }), { amount: 0 });
  assert.equal(parseAmountInput("12.345").error, "Enter the amount in dollars and cents (no more than two decimal places).");
  assert.equal(parseAmountInput("99999999999").error, "Enter a realistic amount.");
});

// ---------------------------------------------------------------------------
// Numbering and due dates
// ---------------------------------------------------------------------------

test("invoice numbers render as INV-000001 and reject non-positive integers", () => {
  assert.equal(formatInvoiceNumber(1), "INV-000001");
  assert.equal(formatInvoiceNumber(123456), "INV-123456");
  assert.equal(formatInvoiceNumber(1234567), "INV-1234567");
  assert.throws(() => formatInvoiceNumber(0));
  assert.throws(() => formatInvoiceNumber(1.5));
});

test("default due date is issue date + 14 days in the organization's timezone, including the midnight boundary", () => {
  // 2026-10-01 04:30 UTC is still 2026-09-30 in Denver (UTC-6).
  const instant = new Date("2026-10-01T04:30:00.000Z");
  assert.equal(calendarDateInTimeZone(instant, "America/Denver"), "2026-09-30");
  assert.equal(calendarDateInTimeZone(instant, "UTC"), "2026-10-01");
  assert.equal(defaultDueDate(instant, "America/Denver"), "2026-10-14");
  assert.equal(defaultDueDate(instant, "UTC"), "2026-10-15");
  // Month and year rollover.
  assert.equal(defaultDueDate(new Date("2026-12-25T18:00:00.000Z"), "America/Denver"), "2027-01-08");
});

// ---------------------------------------------------------------------------
// Balance, overdue, derived state
// ---------------------------------------------------------------------------

test("balance due is total minus amount paid", () => {
  assert.equal(computeBalanceDue(1300.25, 0), 1300.25);
  assert.equal(computeBalanceDue(1300.25, 300.25), 1000);
  assert.equal(computeBalanceDue(1300.25, 1300.25), 0);
});

test("overdue is derived from due_date and only for invoices with an open balance", () => {
  assert.equal(isOverdue(sent(100, 0, "2026-10-12"), "2026-10-12"), false);
  assert.equal(isOverdue(sent(100, 0, "2026-10-12"), "2026-10-13"), true);
  assert.equal(isOverdue({ status: "partially_paid", dueDate: "2026-10-12" }, "2026-10-13"), true);
  assert.equal(isOverdue({ status: "paid", dueDate: "2026-10-12" }, "2026-10-13"), false);
  assert.equal(isOverdue({ status: "draft", dueDate: "2026-10-12" }, "2026-10-13"), false);
  assert.equal(isOverdue({ status: "void", dueDate: "2026-10-12" }, "2026-10-13"), false);
  assert.equal(isOverdue({ status: "sent", dueDate: null }, "2026-10-13"), false);
});

test("deriveInvoiceState reports balance, overdue flag and days overdue", () => {
  const state = deriveInvoiceState(sent(500, 200, "2026-10-01"), "2026-10-04");
  assert.deepEqual(state, { status: "sent", balanceDue: 300, isOverdue: true, daysOverdue: 3 });
  const onTime = deriveInvoiceState(sent(500, 200, "2026-10-01"), "2026-10-01");
  assert.equal(onTime.isOverdue, false);
  assert.equal(onTime.daysOverdue, 0);
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

test("issue is only valid from draft", () => {
  assert.deepEqual(transitionInvoice({ status: "draft", amountPaid: 0 }, "issue"), { ok: true, status: "sent" });
  assert.equal(canIssue({ status: "draft" }), true);
  for (const status of ["sent", "partially_paid", "paid", "void"] as const) {
    assert.equal(transitionInvoice({ status, amountPaid: 0 }, "issue").ok, false);
    assert.equal(canIssue({ status }), false);
  }
});

test("void is valid from draft and from sent with nothing collected, never with money on the invoice", () => {
  assert.deepEqual(transitionInvoice({ status: "draft", amountPaid: 0 }, "void"), { ok: true, status: "void" });
  assert.deepEqual(transitionInvoice({ status: "sent", amountPaid: 0 }, "void"), { ok: true, status: "void" });
  assert.equal(transitionInvoice({ status: "partially_paid", amountPaid: 50 }, "void").ok, false);
  assert.equal(transitionInvoice({ status: "paid", amountPaid: 100 }, "void").ok, false);
  assert.equal(transitionInvoice({ status: "void", amountPaid: 0 }, "void").error, "This invoice is already void.");
  assert.equal(canVoid({ status: "sent", amountPaid: 0 }), true);
  assert.equal(canVoid({ status: "sent", amountPaid: 0.01 }), false);
});

test("totals are frozen once the invoice leaves draft", () => {
  assert.deepEqual(assertTotalsEditable({ status: "draft" }), { ok: true });
  for (const status of ["sent", "partially_paid", "paid", "void"] as const) {
    assert.equal(assertTotalsEditable({ status }).ok, false);
  }
});

test("statusForAmountPaid follows the ledger sum exactly", () => {
  assert.equal(statusForAmountPaid(100, 0), "sent");
  assert.equal(statusForAmountPaid(100, 0.01), "partially_paid");
  assert.equal(statusForAmountPaid(100, 99.99), "partially_paid");
  assert.equal(statusForAmountPaid(100, 100), "paid");
});

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

test("a partial payment moves the invoice to partially_paid with the right balance", () => {
  const outcome = applyPayment(sent(1300.25), 300.25);
  assert.deepEqual(outcome, { ok: true, amountPaid: 300.25, balanceDue: 1000, status: "partially_paid" });
});

test("an exact full payment moves the invoice to paid with zero balance", () => {
  const outcome = applyPayment({ status: "partially_paid", total: 1300.25, amountPaid: 300.25, dueDate: null }, 1000);
  assert.deepEqual(outcome, { ok: true, amountPaid: 1300.25, balanceDue: 0, status: "paid" });
});

test("overpayment is rejected, by a cent or by a lot", () => {
  assert.equal(applyPayment(sent(100), 100.01).ok, false);
  assert.equal(applyPayment({ status: "partially_paid", total: 100, amountPaid: 60, dueDate: null }, 40.01).ok, false);
  assert.equal(applyPayment(sent(100), 5000).error, "That is more than the balance due of $100.");
});

test("payments are rejected on draft, paid and void invoices, and must be positive two-decimal amounts", () => {
  assert.equal(applyPayment({ status: "draft", total: 100, amountPaid: 0, dueDate: null }, 10).ok, false);
  assert.equal(applyPayment({ status: "paid", total: 100, amountPaid: 100, dueDate: null }, 10).ok, false);
  assert.equal(applyPayment({ status: "void", total: 100, amountPaid: 0, dueDate: null }, 10).ok, false);
  assert.equal(applyPayment(sent(100), 0).error, "A payment must be a positive amount.");
  assert.equal(applyPayment(sent(100), -5).error, "A payment must be a positive amount.");
  assert.equal(applyPayment(sent(100), 10.005).ok, false);
});

test("a reversal is a new negative row that exactly offsets the original and moves the status back", () => {
  const ledger = [{ id: "p1", amount: 300.25, reversesPaymentId: null }, { id: "p2", amount: 1000, reversesPaymentId: null }];
  const paidInvoice: InvoiceMoney = { status: "paid", total: 1300.25, amountPaid: 1300.25, dueDate: null };
  const outcome = reversePayment(paidInvoice, ledger, "p2");
  assert.deepEqual(outcome, {
    ok: true,
    reversal: { amount: -1000, reversesPaymentId: "p2" },
    amountPaid: 300.25,
    balanceDue: 1000,
    status: "partially_paid",
  });
  const back = reversePayment({ ...paidInvoice, status: "partially_paid", amountPaid: 300.25 }, [...ledger, { id: "r2", amount: -1000, reversesPaymentId: "p2" }], "p1");
  assert.equal(back.ok, true);
  if (back.ok) assert.equal(back.status, "sent");
});

test("a payment can be reversed at most once, a reversal cannot be reversed, and unknown ids fail", () => {
  const ledger = [
    { id: "p1", amount: 100, reversesPaymentId: null },
    { id: "r1", amount: -100, reversesPaymentId: "p1" },
  ];
  const invoice = sent(200, 0);
  assert.equal(reversePayment(invoice, ledger, "p1").error, "This payment has already been reversed.");
  assert.equal(reversePayment(invoice, ledger, "r1").error, "A reversal cannot itself be reversed.");
  assert.equal(reversePayment(invoice, ledger, "nope").error, "That payment could not be found on this invoice.");
  assert.equal(reversePayment({ status: "void", total: 200, amountPaid: 0, dueDate: null }, ledger, "p1").ok, false);
});

test("collected is the cent-exact sum of the whole ledger including reversals", () => {
  assert.equal(sumCollected([{ amount: 0.1 }, { amount: 0.2 }, { amount: -0.1 }]), 0.2);
  assert.equal(sumCollected([]), 0);
});

test("money formatting shows cents only when present", () => {
  assert.equal(formatMoney(12400), "$12,400");
  assert.equal(formatMoney(1234.56), "$1,234.56");
  assert.equal(formatMoney(0), "$0");
});
