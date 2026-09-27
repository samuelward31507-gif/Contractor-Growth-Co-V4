/**
 * Pure unit tests for lib/agency/revenue.ts's non-I/O currency aggregation
 * logic (applyRow/toCurrencyAmounts/netCollected/emptyMutableTotals) - kept
 * separate from revenue.partial-data.test.ts (mocked single-table client for
 * loadRevenueEvents) and revenue.integration.test.ts (real DB, authorization,
 * real webhook-produced data), matching this codebase's own established
 * split (see lib/agency/cost-readiness.test.ts for the identical pattern).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/revenue.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { applyRow, toCurrencyAmounts, netCollected, emptyMutableTotals }: typeof import("./revenue") = require("./revenue.ts");

test("1. a payment_succeeded event with revenueCategory='setup' is added to both collected and setupCollected, never recurring/uncategorized", () => {
  const totals = emptyMutableTotals();
  applyRow(totals, "payment_succeeded", "setup", "usd", 250000);

  assert.deepEqual(toCurrencyAmounts(totals.collected), [{ currency: "usd", amount: 250000 }]);
  assert.deepEqual(toCurrencyAmounts(totals.setupCollected), [{ currency: "usd", amount: 250000 }]);
  assert.deepEqual(toCurrencyAmounts(totals.recurringCollected), []);
  assert.deepEqual(toCurrencyAmounts(totals.uncategorizedCollected), []);
});

test("2. a payment_succeeded event with revenueCategory=null is added to collected and uncategorizedCollected, never setup/recurring - never guessed", () => {
  const totals = emptyMutableTotals();
  applyRow(totals, "payment_succeeded", null, "usd", 149700);

  assert.deepEqual(toCurrencyAmounts(totals.collected), [{ currency: "usd", amount: 149700 }]);
  assert.deepEqual(toCurrencyAmounts(totals.uncategorizedCollected), [{ currency: "usd", amount: 149700 }]);
  assert.deepEqual(toCurrencyAmounts(totals.setupCollected), []);
  assert.deepEqual(toCurrencyAmounts(totals.recurringCollected), []);
});

test("3. a refund event is added only to refunded, never to collected or netCollected directly (net is derived, never itself accumulated)", () => {
  const totals = emptyMutableTotals();
  applyRow(totals, "payment_succeeded", "recurring", "usd", 100000);
  applyRow(totals, "refund", null, "usd", 30000);

  assert.deepEqual(toCurrencyAmounts(totals.collected), [{ currency: "usd", amount: 100000 }]);
  assert.deepEqual(toCurrencyAmounts(totals.refunded), [{ currency: "usd", amount: 30000 }]);
  assert.deepEqual(netCollected(totals.collected, totals.refunded), [{ currency: "usd", amount: 70000 }]);
});

test("4. a payment_failed event is added only to failedAttempted - never to collected, refunded, or netCollected", () => {
  const totals = emptyMutableTotals();
  applyRow(totals, "payment_failed", null, "usd", 149700);

  assert.deepEqual(toCurrencyAmounts(totals.failedAttempted), [{ currency: "usd", amount: 149700 }]);
  assert.deepEqual(toCurrencyAmounts(totals.collected), []);
  assert.deepEqual(netCollected(totals.collected, totals.refunded), []);
});

test("5. two different currencies are NEVER combined into one total - each keeps its own entry", () => {
  const totals = emptyMutableTotals();
  applyRow(totals, "payment_succeeded", "recurring", "usd", 100000);
  applyRow(totals, "payment_succeeded", "recurring", "eur", 50000);

  const collected = toCurrencyAmounts(totals.collected);
  assert.equal(collected.length, 2, "usd and eur must both appear as their own entries, never summed together");
  assert.deepEqual(
    collected.sort((a, b) => a.currency.localeCompare(b.currency)),
    [
      { currency: "eur", amount: 50000 },
      { currency: "usd", amount: 100000 },
    ],
  );
});

test("6. netCollected treats a currency present on only one side as 0 on the other, never throwing or dropping it", () => {
  const totals = emptyMutableTotals();
  applyRow(totals, "refund", null, "gbp", 5000);

  assert.deepEqual(netCollected(totals.collected, totals.refunded), [{ currency: "gbp", amount: -5000 }], "a refund with no matching collected revenue in the same currency still produces a real (negative) net figure, never silently dropped");
});

test("7. multiple payment_succeeded rows in the same currency accumulate correctly, independent of category", () => {
  const totals = emptyMutableTotals();
  applyRow(totals, "payment_succeeded", "recurring", "usd", 149700);
  applyRow(totals, "payment_succeeded", "recurring", "usd", 149700);
  applyRow(totals, "payment_succeeded", "setup", "usd", 250000);

  assert.deepEqual(toCurrencyAmounts(totals.collected), [{ currency: "usd", amount: 549400 }]);
  assert.deepEqual(toCurrencyAmounts(totals.recurringCollected), [{ currency: "usd", amount: 299400 }]);
  assert.deepEqual(toCurrencyAmounts(totals.setupCollected), [{ currency: "usd", amount: 250000 }]);
});

test("8. an empty totals object produces empty arrays everywhere, never a fabricated zero-amount entry", () => {
  const totals = emptyMutableTotals();
  assert.deepEqual(toCurrencyAmounts(totals.collected), []);
  assert.deepEqual(netCollected(totals.collected, totals.refunded), [], "no currency was ever observed, so there is nothing to report - an empty array, not a $0 USD placeholder");
});
