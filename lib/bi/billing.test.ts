/**
 * Phase 1B-4: unit tests for lib/bi/billing.ts - the invoice/payment ledger
 * metrics behind Insights' "Invoices & payments" section and the AI insights
 * input. Pure, no I/O. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/billing.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { BillingInvoiceRow, BillingPaymentRow } from "./billing";

const require = createRequire(import.meta.url);
const { computeBillingMetrics, computeInvoiceAging, findCompletionInstant, SANCTIONED_COLLECTED_REVENUE_DEFINITION }: typeof import("./billing") = require("./billing.ts");

const OCT = { label: "custom", from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };
const ALL_TIME = { label: "all time", from: null, to: null };
const TODAY = "2026-10-15";

const inv = (overrides: Partial<BillingInvoiceRow> & { id: string }): BillingInvoiceRow => ({
  status: "sent",
  total: 100,
  balance_due: 100,
  issued_at: "2026-10-05T12:00:00.000Z",
  due_date: "2026-10-19",
  ...overrides,
});
const pay = (invoice_id: string, amount: number, received_at: string, created_at = received_at): BillingPaymentRow => ({ invoice_id, amount, received_at, created_at });

test("the sanctioned definition is the exact approved sentence", () => {
  assert.equal(SANCTIONED_COLLECTED_REVENUE_DEFINITION, "Collected revenue = customer payments recorded in Trackpr, net of recorded reversals.");
});

test("invoiced is SUM(total) over invoices ISSUED in the period - drafts, void, and invoices issued outside the period are excluded", () => {
  const metrics = computeBillingMetrics({
    invoices: [
      inv({ id: "a", status: "sent", total: 250, balance_due: 250 }),
      inv({ id: "b", status: "paid", total: 400, balance_due: 0 }),
      inv({ id: "c", status: "draft", total: 999, issued_at: null }),
      inv({ id: "d", status: "void", total: 999 }),
      inv({ id: "e", status: "partially_paid", total: 80, balance_due: 30, issued_at: "2026-09-30T23:59:59.000Z" }),
      inv({ id: "f", status: "sent", total: 60, balance_due: 60, issued_at: "2026-11-01T00:00:00.000Z" }),
    ],
    payments: [],
    range: OCT,
    today: TODAY,
  });
  assert.equal(metrics.invoicedValue, 650, "half-open: an invoice issued exactly at `to` is excluded, one before `from` is excluded");
  assert.equal(metrics.invoicesIssued, 2);
});

test("collected is the net customer_payments sum for payments RECEIVED in the period; reversals are negative rows, counted separately and never as payments received", () => {
  const metrics = computeBillingMetrics({
    invoices: [inv({ id: "a", status: "paid", total: 1000, balance_due: 0 })],
    payments: [
      pay("a", 600, "2026-10-02T00:00:00.000Z"),
      pay("a", 400, "2026-10-03T00:00:00.000Z"),
      pay("a", -400, "2026-10-04T00:00:00.000Z"),
      pay("a", 0.1, "2026-10-05T00:00:00.000Z"),
      pay("a", 0.2, "2026-10-06T00:00:00.000Z"),
      pay("a", 5000, "2026-09-30T23:59:59.000Z"),
      pay("a", 7000, "2026-11-01T00:00:00.000Z"),
    ],
    range: OCT,
    today: TODAY,
  });
  assert.equal(metrics.collectedValue, 600.3, "cent-exact and net of the reversal; out-of-period rows excluded on both half-open edges");
  assert.equal(metrics.paymentsReceived, 4);
  assert.equal(metrics.reversedValue, 400);
  assert.equal(metrics.reversalCount, 1);
});

test("a reversal recorded in a later period reduces THAT period's collected figure, never the period the original payment landed in", () => {
  const payments = [pay("a", 500, "2026-10-20T00:00:00.000Z"), pay("a", -500, "2026-11-02T00:00:00.000Z")];
  const invoices = [inv({ id: "a", status: "sent", total: 500, balance_due: 500 })];
  const october = computeBillingMetrics({ invoices, payments, range: OCT, today: TODAY });
  const november = computeBillingMetrics({ invoices, payments, range: { label: "custom", from: "2026-11-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" }, today: TODAY });
  const allTime = computeBillingMetrics({ invoices, payments, range: ALL_TIME, today: TODAY });
  assert.equal(october.collectedValue, 500);
  assert.equal(november.collectedValue, -500);
  assert.equal(november.reversedValue, 500);
  assert.equal(allTime.collectedValue, 0);
});

test("outstanding and overdue are current-state balances as of today, never period-scoped", () => {
  const metrics = computeBillingMetrics({
    invoices: [
      inv({ id: "a", status: "sent", total: 100, balance_due: 100, due_date: "2026-10-14", issued_at: "2025-01-01T00:00:00.000Z" }),
      inv({ id: "b", status: "partially_paid", total: 300, balance_due: 250, due_date: "2026-10-15" }),
      inv({ id: "c", status: "sent", total: 75, balance_due: 75, due_date: null }),
      inv({ id: "d", status: "paid", total: 500, balance_due: 0, due_date: "2026-01-01" }),
      inv({ id: "e", status: "draft", total: 900, balance_due: 900, due_date: "2026-01-01", issued_at: null }),
    ],
    payments: [],
    range: OCT,
    today: TODAY,
  });
  assert.equal(metrics.outstandingValue, 425, "invoice a was issued long before the period and still counts - outstanding is not a date-range question");
  assert.equal(metrics.outstandingInvoices, 3);
  assert.equal(metrics.overdueValue, 100, "due today is not overdue; paid/draft never are; no due date never is");
  assert.equal(metrics.overdueInvoices, 1);
});

test("days to payment uses the COMPLETING payment's received_at minus issued_at, scoped by that received_at, never paid_at", () => {
  const invoices = [
    inv({ id: "a", status: "paid", total: 1000, balance_due: 0, issued_at: "2026-10-01T00:00:00.000Z" }),
    inv({ id: "b", status: "paid", total: 200, balance_due: 0, issued_at: "2026-10-10T00:00:00.000Z" }),
    inv({ id: "c", status: "paid", total: 300, balance_due: 0, issued_at: "2026-09-01T00:00:00.000Z" }),
    inv({ id: "d", status: "partially_paid", total: 400, balance_due: 100, issued_at: "2026-10-01T00:00:00.000Z" }),
  ];
  const payments = [
    // a: partial on day 2, completed on day 11 (backdated - recorded much later, created_at is irrelevant)
    pay("a", 400, "2026-10-03T00:00:00.000Z"),
    pay("a", 600, "2026-10-12T00:00:00.000Z", "2026-10-30T00:00:00.000Z"),
    // b: paid in full 3 days after issue
    pay("b", 200, "2026-10-13T00:00:00.000Z"),
    // c: issued in September, completed in September - outside the October period
    pay("c", 300, "2026-09-05T00:00:00.000Z"),
    // d: still open, never completes
    pay("d", 300, "2026-10-05T00:00:00.000Z"),
  ];
  const metrics = computeBillingMetrics({ invoices, payments, range: OCT, today: TODAY });
  assert.equal(metrics.invoicesPaid, 2, "only invoices whose completing payment landed in the period");
  assert.equal(metrics.averageDaysToPayment, 7, "(11 + 3) / 2");

  const allTime = computeBillingMetrics({ invoices, payments, range: ALL_TIME, today: TODAY });
  assert.equal(allTime.invoicesPaid, 3);
  assert.equal(allTime.averageDaysToPayment, 6, "(11 + 3 + 4) / 3");
});

test("days to payment is null (never 0) when nothing was paid in the period", () => {
  const metrics = computeBillingMetrics({ invoices: [inv({ id: "a" })], payments: [], range: OCT, today: TODAY });
  assert.equal(metrics.averageDaysToPayment, null);
  assert.equal(metrics.invoicesPaid, 0);
});

test("findCompletionInstant: a reversal that reopens the balance moves completion to the payment that closed it again; an unpaid ledger has none", () => {
  const invoice = { total: 100, issued_at: "2026-10-01T00:00:00.000Z" };
  assert.equal(findCompletionInstant(invoice, [pay("x", 100, "2026-10-02T00:00:00.000Z")]), "2026-10-02T00:00:00.000Z");
  assert.equal(
    findCompletionInstant(invoice, [pay("x", 100, "2026-10-02T00:00:00.000Z"), pay("x", -100, "2026-10-03T00:00:00.000Z"), pay("x", 100, "2026-10-09T00:00:00.000Z")]),
    "2026-10-09T00:00:00.000Z",
  );
  assert.equal(findCompletionInstant(invoice, [pay("x", 100, "2026-10-02T00:00:00.000Z"), pay("x", -100, "2026-10-03T00:00:00.000Z")]), null, "reversed back open");
  assert.equal(findCompletionInstant(invoice, [pay("x", 60, "2026-10-02T00:00:00.000Z")]), null);
  assert.equal(findCompletionInstant({ total: 100, issued_at: null }, [pay("x", 100, "2026-10-02T00:00:00.000Z")]), null, "never issued");
  assert.equal(
    findCompletionInstant(invoice, [pay("x", 50, "2026-10-05T00:00:00.000Z", "2026-10-05T00:00:00.001Z"), pay("x", 50, "2026-10-05T00:00:00.000Z", "2026-10-05T00:00:00.000Z")]),
    "2026-10-05T00:00:00.000Z",
    "ties on received_at break on created_at",
  );
});

test("an empty ledger is all zeros and nulls - a genuinely empty result, not an error", () => {
  const metrics = computeBillingMetrics({ invoices: [], payments: [], range: OCT, today: TODAY });
  assert.deepEqual(metrics, {
    invoicedValue: 0,
    invoicesIssued: 0,
    collectedValue: 0,
    paymentsReceived: 0,
    reversedValue: 0,
    reversalCount: 0,
    outstandingValue: 0,
    outstandingInvoices: 0,
    overdueValue: 0,
    overdueInvoices: 0,
    invoicesPaid: 0,
    averageDaysToPayment: null,
  });
});

// ---------------------------------------------------------------------------
// getBillingRowsResult - `failed` semantics against a mocked client (the
// lib/bi/queries.partial-data.test.ts pattern).
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";

const { getBillingRowsResult }: typeof import("./billing") = require("./billing.ts");

type MockResult = { data: unknown; error: { message: string } | null };

function makeMockSupabase(results: Record<string, MockResult>): SupabaseClient {
  return {
    from: (table: string) => {
      const result = results[table] ?? { data: [], error: null };
      const builder = {
        select: () => builder,
        eq: () => builder,
        limit: () => builder,
        order: () => builder,
        range: () => Promise.resolve(result),
        then: (resolve: (value: MockResult) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

test("getBillingRowsResult: a genuinely empty ledger never sets failed; a real error on either table does, and (Phase 2E) carries no rows from either table - never a partial ledger", async () => {
  const empty = await getBillingRowsResult(makeMockSupabase({}), "org-1");
  assert.equal(empty.failed, false);
  assert.deepEqual(empty.invoices, []);
  assert.deepEqual(empty.payments, []);

  const invoicesFailing = await getBillingRowsResult(
    makeMockSupabase({ invoices: { data: null, error: { message: "timeout" } }, customer_payments: { data: [pay("a", 10, "2026-10-01T00:00:00.000Z")], error: null } }),
    "org-1",
  );
  assert.equal(invoicesFailing.failed, true);
  assert.equal(invoicesFailing.payments.length, 0);

  const paymentsFailing = await getBillingRowsResult(makeMockSupabase({ customer_payments: { data: null, error: { message: "timeout" } } }), "org-1");
  assert.equal(paymentsFailing.failed, true);
});

// ---------------------------------------------------------------------------
// Period boundaries - instants, not text. Postgres returns timestamps as
// "2026-09-01T06:00:00+00:00"; the resolved range is "...06:00:00.000Z".
// Compared as text, the exact local midnight that starts a period sorted
// before it and fell into the previous period.
// ---------------------------------------------------------------------------

const { resolveDateRange }: typeof import("./queries") = require("./queries.ts");
const { inRange }: typeof import("./billing") = require("./billing.ts");

test("exact local midnight: a payment at Sep 1 00:00 Denver (as Postgres returns it) belongs to September; the instant before it belongs to August", () => {
  const now = new Date("2026-10-15T18:00:00Z");
  const september = resolveDateRange("previousMonth", now, "America/Denver");
  const august = { label: "custom", from: "2026-08-01T06:00:00.000Z", to: september.from };
  assert.equal(september.from, "2026-09-01T06:00:00.000Z");

  const midnight = "2026-09-01T06:00:00+00:00";
  const instantBefore = "2026-09-01T05:59:59.999+00:00";
  assert.deepEqual([inRange(midnight, september), inRange(midnight, august)], [true, false]);
  assert.deepEqual([inRange(instantBefore, september), inRange(instantBefore, august)], [false, true]);

  const payments = [pay("a", 100, midnight), pay("a", 7, instantBefore)];
  const forSeptember = computeBillingMetrics({ invoices: [], payments, range: september, today: "2026-10-15" });
  const forAugust = computeBillingMetrics({ invoices: [], payments, range: august, today: "2026-10-15" });
  assert.deepEqual([forSeptember.collectedValue, forSeptember.paymentsReceived], [100, 1]);
  assert.deepEqual([forAugust.collectedValue, forAugust.paymentsReceived], [7, 1]);
});

test("exact local midnight: the period's end belongs to the next period; issue dates and paid-in-period follow the same rule", () => {
  const september = resolveDateRange("previousMonth", new Date("2026-10-15T18:00:00Z"), "America/Denver");
  assert.equal(inRange("2026-10-01T06:00:00+00:00", september), false);
  assert.equal(inRange("2026-10-01T05:59:59.999+00:00", september), true);

  const invoice = inv({ id: "a", status: "paid", total: 100, balance_due: 0, issued_at: "2026-09-01T06:00:00+00:00" });
  const metrics = computeBillingMetrics({ invoices: [invoice], payments: [pay("a", 100, "2026-09-01T06:00:00+00:00")], range: september, today: "2026-10-15" });
  assert.deepEqual([metrics.invoicesIssued, metrics.invoicedValue, metrics.invoicesPaid, metrics.collectedValue], [1, 100, 1, 100]);
});

// ---------------------------------------------------------------------------
// Phase 2A: invoice aging (Analytics)
// ---------------------------------------------------------------------------

const AGING_TODAY = "2026-10-01";
const aged = (status: BillingInvoiceRow["status"], due_date: string | null, balance_due: number) => ({ status, due_date, balance_due });
const agingOf = (rows: ReturnType<typeof aged>[]) => Object.fromEntries(computeInvoiceAging(rows, AGING_TODAY).map((bucket) => [bucket.key, [bucket.count, bucket.value]]));

test("aging: every boundary - due today is current; 1 and 30 days are 1-30; 31 and 60 are 31-60; 61 is 61+", () => {
  assert.deepEqual(
    agingOf([
      aged("sent", "2026-10-01", 100), // due today
      aged("sent", "2026-10-15", 10), // not yet due
      aged("sent", "2026-09-30", 200), // 1 day
      aged("sent", "2026-09-01", 300), // 30 days
      aged("sent", "2026-08-31", 400), // 31 days
      aged("sent", "2026-08-02", 500), // 60 days
      aged("sent", "2026-08-01", 600), // 61 days
    ]),
    { current: [2, 110], "1-30": [2, 500], "31-60": [2, 900], "61+": [1, 600] },
  );
});

test("aging: no due date is current; partially paid ages by the balance still owed", () => {
  assert.deepEqual(agingOf([aged("sent", null, 75), aged("partially_paid", "2026-09-20", 40.5)]), { current: [1, 75], "1-30": [1, 40.5], "31-60": [0, 0], "61+": [0, 0] });
});

test("aging: paid, draft and void invoices are never aged, whatever their due date", () => {
  assert.deepEqual(agingOf([aged("paid", "2026-01-01", 0), aged("draft", "2026-01-01", 999), aged("void", "2026-01-01", 999)]), { current: [0, 0], "1-30": [0, 0], "31-60": [0, 0], "61+": [0, 0] });
});

test("aging: buckets are calendar days, so a DST change between due date and today shifts nothing; cents stay exact", () => {
  // Due Oct 31; on Nov 2 (after the Nov 1 fall-back) it is exactly 2 days past due.
  assert.deepEqual(computeInvoiceAging([aged("sent", "2026-10-31", 50)], "2026-11-02").find((bucket) => bucket.key === "1-30"), { key: "1-30", label: "1-30 days", count: 1, value: 50 });
  assert.equal(computeInvoiceAging([aged("sent", "2026-09-01", 0.1), aged("sent", "2026-09-02", 0.2)], AGING_TODAY)[1].value, 0.3);
});
