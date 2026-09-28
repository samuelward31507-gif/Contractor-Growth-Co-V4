/**
 * Unit tests for lib/invoices/summary.ts - the Money page's invoice/payment
 * figures and the invoices list filter. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/invoices/summary.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterInvoices, summarizeInvoiceMoney, type FilterableInvoice, type SummaryInvoice } from "./summary";

const inv = (overrides: Partial<SummaryInvoice> & { id: string }): SummaryInvoice => ({
  job_id: `job-${overrides.id}`,
  status: "sent",
  total: 100,
  amount_paid: 0,
  balance_due: 100,
  due_date: "2026-10-20",
  ...overrides,
});

test("invoiced counts only issued, non-void invoices; drafts are reported separately", () => {
  const summary = summarizeInvoiceMoney({
    invoices: [inv({ id: "a", status: "draft" }), inv({ id: "b", status: "sent", total: 250, balance_due: 250 }), inv({ id: "c", status: "paid", total: 400, amount_paid: 400, balance_due: 0 }), inv({ id: "d", status: "void", total: 999 })],
    payments: [],
    jobs: [],
    today: "2026-10-10",
  });
  assert.equal(summary.invoiced, 650);
  assert.equal(summary.invoicedCount, 2);
  assert.equal(summary.draftCount, 1);
});

test("collected is the customer_payments ledger sum including reversals, never an invoice figure", () => {
  const summary = summarizeInvoiceMoney({
    invoices: [inv({ id: "a", status: "paid", total: 1000, amount_paid: 1000, balance_due: 0 })],
    payments: [{ amount: 600 }, { amount: 400 }, { amount: -400 }, { amount: 0.1 }, { amount: 0.2 }],
    jobs: [],
    today: "2026-10-10",
  });
  assert.equal(summary.collected, 600.3);
  assert.equal(summary.paymentCount, 4, "reversal rows are not counted as payments received");
});

test("outstanding and overdue come from open balances and the organization's calendar date", () => {
  const summary = summarizeInvoiceMoney({
    invoices: [
      inv({ id: "a", status: "sent", total: 100, balance_due: 100, due_date: "2026-10-09" }),
      inv({ id: "b", status: "partially_paid", total: 300, amount_paid: 50, balance_due: 250, due_date: "2026-10-10" }),
      inv({ id: "c", status: "sent", total: 75, balance_due: 75, due_date: null }),
      inv({ id: "d", status: "paid", total: 500, amount_paid: 500, balance_due: 0, due_date: "2026-01-01" }),
      inv({ id: "e", status: "draft", total: 900, balance_due: 900, due_date: "2026-01-01" }),
    ],
    payments: [],
    jobs: [],
    today: "2026-10-10",
  });
  assert.equal(summary.outstanding, 425);
  assert.equal(summary.outstandingCount, 3);
  assert.equal(summary.overdue, 100, "due today is not overdue; paid and draft never are; no due date never is");
  assert.equal(summary.overdueCount, 1);
});

test("not yet invoiced is completed jobs with no live invoice; unknown amounts are counted but never summed", () => {
  const summary = summarizeInvoiceMoney({
    invoices: [inv({ id: "a", job_id: "job-1", status: "sent" }), inv({ id: "b", job_id: "job-2", status: "void" })],
    payments: [],
    jobs: [
      { id: "job-1", status: "completed", amount: 100 },
      { id: "job-2", status: "completed", amount: 200 },
      { id: "job-3", status: "completed", amount: null },
      { id: "job-4", status: "in_progress", amount: 300 },
    ],
    today: "2026-10-10",
  });
  assert.equal(summary.notYetInvoicedCount, 2, "job-2's only invoice is void, so it is not yet invoiced; job-4 is not completed");
  assert.equal(summary.notYetInvoicedKnownValue, 200);
  assert.equal(summary.notYetInvoicedUnknownCount, 1);
});

test("filterInvoices matches number, title and contact, and treats overdue as a derived status", () => {
  const rows: FilterableInvoice[] = [
    { ...inv({ id: "a", status: "sent", due_date: "2026-10-01" }), number: 7, title: "Roof repair", contact: { first_name: "Ann", last_name: "Lee", company_name: "Lee Homes", phone: null, email: null } },
    { ...inv({ id: "b", status: "paid", amount_paid: 100, balance_due: 0 }), number: 12, title: "Gutters", contact: null },
  ];
  assert.deepEqual(filterInvoices(rows, { query: "inv-000007" }, "2026-10-10").map((r) => r.id), ["a"]);
  assert.deepEqual(filterInvoices(rows, { query: "lee homes" }, "2026-10-10").map((r) => r.id), ["a"]);
  assert.deepEqual(filterInvoices(rows, { query: "gutter" }, "2026-10-10").map((r) => r.id), ["b"]);
  assert.deepEqual(filterInvoices(rows, { status: "paid" }, "2026-10-10").map((r) => r.id), ["b"]);
  assert.deepEqual(filterInvoices(rows, { status: "overdue" }, "2026-10-10").map((r) => r.id), ["a"]);
  assert.deepEqual(filterInvoices(rows, { status: "overdue" }, "2026-09-30").map((r) => r.id), []);
  assert.equal(filterInvoices(rows, { status: "all" }, "2026-10-10").length, 2);
});
