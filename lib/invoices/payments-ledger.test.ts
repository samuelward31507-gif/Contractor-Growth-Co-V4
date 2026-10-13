/**
 * Audit: Money "Collected" sums getCustomerPaymentsResult. It used to read
 * with .limit(5000) and report success, so a larger ledger silently
 * undercounted. It must page through every row, or say it failed.
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/invoices/payments-ledger.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { getCustomerPaymentsResult } = await import(pathToFileURL(path.join(process.cwd(), "lib/invoices/queries.ts")).href);

function fakeLedger(total: number, failAt?: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: `p-${String(i).padStart(6, "0")}`, amount: 1, received_at: "2026-10-01T00:00:00.000Z" }));
  const query = () => {
    let limit: number | null = null;
    const q = {
      select: () => q, eq: () => q, order: () => q,
      limit: (n: number) => { limit = n; return q; },
      range: async (from: number, to: number) => (failAt !== undefined && from >= failAt ? { data: null, error: { message: "boom" } } : { data: rows.slice(from, to + 1), error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows.slice(0, limit ?? rows.length), error: null }),
    };
    return q;
  };
  return { from: () => query() };
}

test("a ledger larger than 5,000 payments is read in full - Collected never silently undercounts", async () => {
  const result = await getCustomerPaymentsResult(fakeLedger(6200) as never, "org-1");
  assert.equal(result.failed, false);
  assert.equal(result.data.length, 6200);
});

test("a read error part-way through is reported as failed, never as a complete ledger", async () => {
  const result = await getCustomerPaymentsResult(fakeLedger(6200, 2000) as never, "org-1");
  assert.equal(result.failed, true);
});
