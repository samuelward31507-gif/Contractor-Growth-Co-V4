/**
 * Phase 2E: the billing ledger reads (getBillingRowsResult in
 * lib/bi/billing.ts) are paged instead of one capped read. Below the
 * existing 10,000-row limit they return the same rows - so every billing
 * figure is unchanged - and at the limit, or on any read error, they fail
 * with no rows rather than a silently truncated ledger.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/billing.paging.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingInvoiceRow, BillingPaymentRow } from "./billing";

const require = createRequire(import.meta.url);
const { getBillingRowsResult, computeBillingMetrics, computeInvoiceAging }: typeof import("./billing") = require(path.join(process.cwd(), "lib/bi/billing.ts"));

const SEP = { label: "custom", from: "2026-09-01T06:00:00.000Z", to: "2026-10-01T06:00:00.000Z" };
const TODAY = "2026-10-15";

function invoices(n: number): BillingInvoiceRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `inv-${String(i).padStart(6, "0")}`,
    status: (["sent", "partially_paid", "paid", "draft", "void"] as const)[i % 5],
    total: 100 + (i % 7),
    balance_due: i % 5 === 2 ? 0 : 50,
    issued_at: i % 5 === 3 ? null : `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T12:00:00+00:00`,
    due_date: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`,
  }));
}
function payments(n: number): BillingPaymentRow[] {
  return Array.from({ length: n }, (_, i) => ({ invoice_id: `inv-${String(i % 400).padStart(6, "0")}`, amount: i % 9 === 0 ? -5 : 25.5, received_at: `2026-09-${String(1 + (i % 29)).padStart(2, "0")}T0${i % 10}:00:00+00:00`, created_at: "2026-09-30T00:00:00+00:00" }));
}

/** A Supabase stand-in serving `tables`: a paged read through range(), or - for the legacy comparison - the whole table through await. */
function fakeSupabase(tables: Record<string, unknown[]>, options: { failTable?: string; failOnPage?: number } = {}) {
  const ranges: Record<string, [number, number][]> = {};
  const calls: string[] = [];
  const supabase = {
    from(table: string) {
      ranges[table] ??= [];
      const builder = {
        select: (columns: string) => (calls.push(`${table} select ${columns}`), builder),
        eq: (column: string, value: unknown) => (calls.push(`${table} eq ${column} ${value}`), builder),
        order: (column: string) => (calls.push(`${table} order ${column}`), builder),
        range(from: number, to: number) {
          ranges[table].push([from, to]);
          if (options.failTable === table && options.failOnPage === ranges[table].length) return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: tables[table].slice(from, to + 1), error: null });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { supabase, ranges, calls };
}

test("same columns, organization filter and a stable order as before - now one paged read per table", async () => {
  const { supabase, calls } = fakeSupabase({ invoices: invoices(3), customer_payments: payments(3) });
  await getBillingRowsResult(supabase, "org-1");
  assert.deepEqual(calls, [
    "invoices select id, status, total, balance_due, issued_at, due_date",
    "invoices eq organization_id org-1",
    "invoices order id",
    "customer_payments select invoice_id, amount, received_at, created_at",
    "customer_payments eq organization_id org-1",
    "customer_payments order id",
  ]);
});

test("below the limit: every row comes back across pages, and every billing figure equals the one computed from the whole ledger", async () => {
  const ledger = { invoices: invoices(2345), customer_payments: payments(3456) };
  const { supabase, ranges } = fakeSupabase(ledger);
  const rows = await getBillingRowsResult(supabase, "org-1");
  assert.equal(rows.failed, false);
  assert.deepEqual(ranges.invoices, [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.equal(ranges.customer_payments.length, 4);
  assert.deepEqual(rows.invoices, ledger.invoices);
  assert.deepEqual(rows.payments, ledger.customer_payments);
  const expected = computeBillingMetrics({ invoices: ledger.invoices, payments: ledger.customer_payments, range: SEP, today: TODAY });
  assert.deepEqual(computeBillingMetrics({ invoices: rows.invoices, payments: rows.payments, range: SEP, today: TODAY }), expected);
  assert.deepEqual(computeInvoiceAging(rows.invoices, TODAY), computeInvoiceAging(ledger.invoices, TODAY));
});

test("an empty ledger is not a failure", async () => {
  const rows = await getBillingRowsResult(fakeSupabase({ invoices: [], customer_payments: [] }).supabase, "org-1");
  assert.deepEqual(rows, { invoices: [], payments: [], failed: false });
});

test("at the 10,000-row limit the ledger fails with no rows - never a silently truncated Collected or Outstanding", async () => {
  for (const [table, ledger] of [
    ["customer_payments", { invoices: invoices(10), customer_payments: payments(10_001) }],
    ["invoices", { invoices: invoices(10_001), customer_payments: payments(10) }],
  ] as const) {
    const rows = await getBillingRowsResult(fakeSupabase(ledger).supabase, "org-1");
    assert.deepEqual(rows, { invoices: [], payments: [], failed: true }, table);
  }
  // Exactly 10,000 is already "at the limit": the pager can't tell a full last page from a truncated one.
  const exactly = await getBillingRowsResult(fakeSupabase({ invoices: invoices(10), customer_payments: payments(10_000) }).supabase, "org-1");
  assert.equal(exactly.failed, true);
  const under = await getBillingRowsResult(fakeSupabase({ invoices: invoices(9_999), customer_payments: payments(9_999) }).supabase, "org-1");
  assert.deepEqual([under.failed, under.invoices.length, under.payments.length], [false, 9_999, 9_999]);
});

test("a read error on any page of either table fails with no rows - no partial totals from the pages that arrived", async () => {
  for (const failTable of ["invoices", "customer_payments"]) {
    const rows = await getBillingRowsResult(fakeSupabase({ invoices: invoices(2500), customer_payments: payments(2500) }, { failTable, failOnPage: 2 }).supabase, "org-1");
    assert.deepEqual(rows, { invoices: [], payments: [], failed: true }, failTable);
    const metrics = computeBillingMetrics({ invoices: rows.invoices, payments: rows.payments, range: SEP, today: TODAY });
    assert.deepEqual([metrics.collectedValue, metrics.outstandingValue, metrics.invoicedValue], [0, 0, 0]);
  }
});
