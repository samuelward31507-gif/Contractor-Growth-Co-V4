/**
 * Founder finance calculations (lib/founder/finance.ts): per-currency
 * totals, cash basis, the Stripe verified-exponent contract, burn, cash
 * freshness, runway and the attention list. Pure - no database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/founder/finance.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CASH_FRESHNESS_RULE,
  attentionItems,
  cashByCurrency,
  currencyDecimals,
  formatFinanceMoney,
  isCashStale,
  latestCashBalances,
  missingRecurringPayments,
  monthlyBurn,
  netCashResult,
  parseAmount,
  parseCashBalanceInput,
  parseExpenseInput,
  parseIncomeInput,
  periodBounds,
  resolvePeriod,
  runway,
  stripeMajor,
  summarizeExpenses,
  summarizeManualIncome,
  summarizeRecurring,
  summarizeStripe,
  type CashBalance,
  type Expense,
  type IncomeReceipt,
  type RecurringCost,
  type StripeMonthRow,
} from "./finance";

const TODAY = "2026-10-10";

let n = 0;
const expense = (over: Partial<Expense>): Expense => ({
  id: `e${++n}`,
  recurringCostId: null,
  coversMonth: null,
  vendor: "Vendor",
  category: "software",
  description: null,
  amount: 100,
  currency: "USD",
  incurredOn: "2026-10-01",
  dueOn: null,
  paidOn: "2026-10-01",
  voidedAt: null,
  voidReason: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...over,
});
const cost = (over: Partial<RecurringCost>): RecurringCost => ({ id: `c${++n}`, vendor: "Vercel", category: "hosting", description: null, amount: 20, currency: "USD", cadence: "monthly", startOn: "2026-01-01", endOn: null, voidedAt: null, voidReason: null, createdAt: "", updatedAt: "v1", ...over });
const income = (over: Partial<IncomeReceipt>): IncomeReceipt => ({ id: `i${++n}`, payer: "Client", kind: "recurring_fee", description: null, amount: 500, currency: "USD", receivedOn: "2026-10-02", receivedVia: "bank_transfer", reference: null, voidedAt: null, voidReason: null, createdAt: "", updatedAt: "", ...over });
const balance = (over: Partial<CashBalance>): CashBalance => ({ id: `b${++n}`, accountLabel: "Checking", balance: 10000, currency: "USD", asOf: "2026-10-05", note: null, voidedAt: null, voidReason: null, createdAt: "2026-10-05T00:00:00Z", ...over });
const stripeRow = (over: Partial<StripeMonthRow>): StripeMonthRow => ({ month: "2026-10-01", currency: "USD", collected: 0, recurringCollected: 0, uncategorizedCollected: 0, refunded: 0, succeededPayments: 0, failedAttempts: 0, invoicesWithFailedAttempts: 0, failedAttemptedAmount: 0, lastRecordedAt: null, exponent: 2, exponentStatus: "verified", ...over });

test("currency decimals mirror founder_currency_minor_units; amounts are checked against them", () => {
  assert.equal(currencyDecimals("USD"), 2);
  assert.equal(currencyDecimals("JPY"), 0);
  assert.equal(currencyDecimals("KWD"), 3);
  assert.equal(currencyDecimals("CLF"), null);
  assert.equal(currencyDecimals("usd"), null);
  assert.deepEqual(parseAmount("1,250.50", "USD"), { ok: true, value: 1250.5 });
  assert.equal(parseAmount("12.5", "JPY").ok, false);
  assert.deepEqual(parseAmount("1.250", "KWD"), { ok: true, value: 1.25 });
  assert.equal(parseAmount("1.2345", "KWD").ok, false);
  assert.equal(parseAmount("0", "USD").ok, false);
  assert.equal(parseAmount("-5", "USD").ok, false);
  assert.deepEqual(parseAmount("-5", "USD", { allowNegative: true }), { ok: true, value: -5 });
  assert.equal(parseAmount("abc", "USD").ok, false);
});

test("form parsing: paid needs a paid date not in the future; income can't be Stripe; balances may be negative", () => {
  const base = { vendor: "Figma", category: "software", amount: "15", currency: "usd", incurredOn: "2026-10-01" };
  const paid = parseExpenseInput({ ...base, status: "paid", paidOn: "2026-10-02" }, TODAY);
  assert.ok(paid.ok && paid.value.paidOn === "2026-10-02" && paid.value.currency === "USD");
  assert.equal(parseExpenseInput({ ...base, status: "paid", paidOn: "2026-10-11" }, TODAY).ok, false, "future payment refused");
  assert.equal(parseExpenseInput({ ...base, status: "paid" }, TODAY).ok, false, "paid needs a date");
  const unpaid = parseExpenseInput({ ...base, status: "unpaid", paidOn: "2026-10-02", dueOn: "2026-10-20" }, TODAY);
  assert.ok(unpaid.ok && unpaid.value.paidOn === null && unpaid.value.dueOn === "2026-10-20", "unpaid ignores a stray paid date");
  assert.equal(parseExpenseInput({ ...base, category: "bribes", status: "unpaid" }, TODAY).ok, false);

  const inc = { payer: "Acme", kind: "setup_fee", amount: "1000", currency: "USD", receivedOn: "2026-10-01" };
  assert.ok(parseIncomeInput({ ...inc, receivedVia: "check" }, TODAY).ok);
  const stripe = parseIncomeInput({ ...inc, receivedVia: "stripe" }, TODAY);
  assert.ok(!stripe.ok && /Stripe payments are recorded automatically/.test(stripe.error));

  assert.ok(parseCashBalanceInput({ accountLabel: "Checking", balance: "-250.10", currency: "USD", asOf: "2026-10-09" }, TODAY).ok);
  assert.equal(parseCashBalanceInput({ accountLabel: "Checking", balance: "10", currency: "USD", asOf: "2026-10-11" }, TODAY).ok, false);
});

test("Stripe: only a verified exponent converts; setup is derived; unverified currencies have no amounts", () => {
  assert.equal(stripeMajor(129700, "verified", 2), 1297);
  assert.equal(stripeMajor(129700, "unverified", null), null);
  assert.equal(stripeMajor(129700, "verified", null), null, "never defaults to 2");
  const [cad, usd] = summarizeStripe([
    stripeRow({ month: "2026-09-01", collected: 300000, recurringCollected: 200000, uncategorizedCollected: 10000, refunded: 5000, succeededPayments: 3, failedAttempts: 2, invoicesWithFailedAttempts: 1, failedAttemptedAmount: 99900 }),
    stripeRow({ month: "2026-10-01", collected: 100000, recurringCollected: 100000, succeededPayments: 1 }),
    stripeRow({ currency: "CAD", collected: 20000, succeededPayments: 1, exponent: null, exponentStatus: "unverified" }),
  ]);
  assert.equal(usd.collected, 4000);
  assert.equal(usd.recurring, 3000);
  assert.equal(usd.setup, 900, "collected - recurring - uncategorized");
  assert.equal(usd.uncategorized, 100);
  assert.equal(usd.refunded, 50);
  assert.equal(usd.failedAttempts, 2);
  assert.equal(usd.failedAttemptedAmount, 999);
  assert.equal(cad.verified, false);
  assert.equal(cad.collected, null);
  assert.equal(cad.succeededPayments, 1, "counts still shown");
});

test("manual income stays separate and counts by received date; voided records never count", () => {
  const result = summarizeManualIncome([income({}), income({ kind: "setup_fee", amount: 250 }), income({ receivedOn: "2026-09-30" }), income({ voidedAt: "x", voidReason: "dup" }), income({ currency: "EUR", amount: 90 })], "2026-10-01", "2026-10-11");
  assert.deepEqual(result.total, { USD: 750, EUR: 90 });
  assert.deepEqual(result.recurring, { USD: 500, EUR: 90 });
  assert.equal(result.count, 3);
});

test("expenses: cash basis by paid date, per currency, unpaid and overdue apart, voided excluded", () => {
  const list = [
    expense({ amount: 0.1 }),
    expense({ amount: 0.2 }),
    expense({ paidOn: "2026-09-30", amount: 999 }),
    expense({ currency: "JPY", amount: 5000 }),
    expense({ paidOn: null, dueOn: "2026-10-05", amount: 40, vendor: "Late" }),
    expense({ paidOn: null, dueOn: "2026-10-30", amount: 60 }),
    expense({ voidedAt: "x", voidReason: "wrong", amount: 7 }),
    expense({ category: "payment_processing", amount: 12 }),
  ];
  const s = summarizeExpenses(list, "2026-10-01", "2026-10-11", TODAY);
  assert.deepEqual(s.paid, { USD: 12.3, JPY: 5000 }, "0.1 + 0.2 without float drift; no cross-currency sum");
  assert.equal(s.paidCount, 4);
  assert.deepEqual(s.unpaid, { USD: 100 });
  assert.deepEqual(s.overdue.map((e) => e.vendor), ["Late"]);
});

test("recurring: monthly and annual kept apart; ended, future and voided costs excluded; missing payments found", () => {
  const vercel = cost({});
  const annual = cost({ cadence: "annual", amount: 120, vendor: "Domain" });
  const ended = cost({ endOn: "2026-08-31" });
  const voided = cost({ voidedAt: "x", voidReason: "dup" });
  const future = cost({ startOn: "2026-11-01" });
  const r = summarizeRecurring([vercel, annual, ended, voided, future], TODAY);
  assert.deepEqual(r.monthly, { USD: 20 });
  assert.deepEqual(r.annual, { USD: 120 });
  assert.equal(r.activeCount, 2);

  const paidFigma = cost({ vendor: "Figma" });
  const missing = missingRecurringPayments([vercel, paidFigma, annual, ended], [expense({ recurringCostId: paidFigma.id, coversMonth: "2026-09-01" })], TODAY);
  assert.deepEqual(missing.map((m) => [m.cost.vendor, m.month]), [["Vercel", "2026-09-01"]]);
});

test("net cash result: per currency, Stripe net of refunds plus manual income minus paid expenses; unverified gets no figure", () => {
  const stripe = summarizeStripe([stripeRow({ collected: 100000, refunded: 10000, succeededPayments: 2 }), stripeRow({ currency: "CAD", collected: 5000, succeededPayments: 1, exponent: null, exponentStatus: "unverified" })]);
  const rows = netCashResult(stripe, { USD: 200, EUR: 50 }, { USD: 300, CAD: 10 });
  assert.deepEqual(rows, [
    { currency: "CAD", net: null, inflow: null, outflow: 10, status: "unverified_stripe_format" },
    { currency: "EUR", net: 50, inflow: 50, outflow: 0, status: "ok" },
    { currency: "USD", net: 800, inflow: 1100, outflow: 300, status: "ok" },
  ]);
});

test("burn: three complete months of paid expenses, only when records reach back that far", () => {
  const history = [expense({ incurredOn: "2026-06-15", paidOn: "2026-06-15", amount: 1 }), expense({ paidOn: "2026-07-05", amount: 300 }), expense({ paidOn: "2026-08-05", amount: 300 }), expense({ paidOn: "2026-09-05", amount: 300 }), expense({ paidOn: "2026-10-05", amount: 5000 })];
  const ok = monthlyBurn(history, TODAY);
  assert.deepEqual(ok.window, { from: "2026-07-01", to: "2026-10-01" });
  assert.deepEqual(ok.rows, [{ currency: "USD", monthlyBurn: 300, windowTotal: 900, recordsSince: "2026-06-15", status: "ok" }], "the current, incomplete month is excluded");

  const recent = monthlyBurn([expense({ incurredOn: "2026-08-20", paidOn: "2026-08-20", amount: 900 })], TODAY);
  assert.equal(recent.rows[0].status, "insufficient_history");
  assert.equal(recent.rows[0].monthlyBurn, null);
  assert.equal(recent.rows[0].recordsSince, "2026-08-20");

  const prepaid = monthlyBurn([expense({ incurredOn: "2026-09-01", paidOn: "2026-06-30", amount: 1200 })], TODAY);
  assert.equal(prepaid.rows[0].recordsSince, "2026-06-30", "a prepayment dates the records from when it was paid");
});

test("cash: latest live balance per account, stale after 35 days, voided ignored, per-currency totals", () => {
  const accounts = latestCashBalances(
    [
      balance({ asOf: "2026-09-01", balance: 1 }),
      balance({ asOf: "2026-10-05", balance: 9000 }),
      balance({ asOf: "2026-10-09", balance: 1, voidedAt: "x", voidReason: "typo" }),
      balance({ accountLabel: "Savings", asOf: "2026-09-01", balance: 5000 }),
      balance({ accountLabel: "Wise EUR", currency: "EUR", asOf: "2026-10-01", balance: 700 }),
    ],
    TODAY,
  );
  assert.deepEqual(accounts.map((a) => [a.accountLabel, a.balance, a.ageDays, a.stale]), [["Wise EUR", 700, 9, false], ["Checking", 9000, 5, false], ["Savings", 5000, 39, true]]);
  assert.deepEqual(cashByCurrency(accounts), [
    { currency: "EUR", total: 700, accounts: 1, oldestAsOf: "2026-10-01", staleAccounts: 0 },
    { currency: "USD", total: 14000, accounts: 2, oldestAsOf: "2026-09-01", staleAccounts: 1 },
  ]);
});

test("runway: same currency only; stale cash, missing burn or no cash give a reason instead of a number", () => {
  const rows = runway(
    [
      { currency: "USD", total: 9000, accounts: 1, oldestAsOf: "2026-10-05", staleAccounts: 0 },
      { currency: "EUR", total: 700, accounts: 1, oldestAsOf: "2026-08-01", staleAccounts: 1 },
      { currency: "GBP", total: -50, accounts: 1, oldestAsOf: "2026-10-05", staleAccounts: 0 },
    ],
    [
      { currency: "USD", monthlyBurn: 3000, windowTotal: 9000, recordsSince: "2026-01-01", status: "ok" },
      { currency: "EUR", monthlyBurn: 100, windowTotal: 300, recordsSince: "2026-01-01", status: "ok" },
      { currency: "GBP", monthlyBurn: 10, windowTotal: 30, recordsSince: "2026-01-01", status: "ok" },
      { currency: "JPY", monthlyBurn: 1000, windowTotal: 3000, recordsSince: "2026-01-01", status: "ok" },
    ],
  );
  assert.deepEqual(rows.find((r) => r.currency === "USD"), { currency: "USD", status: "ok", months: 3, cash: 9000, burn: 3000 });
  assert.equal(rows.find((r) => r.currency === "EUR")?.status, "stale_cash");
  assert.equal(rows.find((r) => r.currency === "GBP")?.status, "overdrawn");
  assert.equal(rows.find((r) => r.currency === "JPY")?.status, "no_cash", "JPY burn is never compared with USD cash");
  const noBurn = runway([{ currency: "USD", total: 100, accounts: 1, oldestAsOf: TODAY, staleAccounts: 0 }], [{ currency: "USD", monthlyBurn: null, windowTotal: 10, recordsSince: "2026-09-01", status: "insufficient_history" }]);
  assert.equal(noBurn[0].status, "no_burn");
});

test("attention: unpaid invoices are urgent; failed attempts later paid are not losses; missing data is flagged", () => {
  const stripe = summarizeStripe([stripeRow({ collected: 50000, succeededPayments: 1, failedAttempts: 3, invoicesWithFailedAttempts: 2 }), stripeRow({ currency: "CAD", collected: 100, succeededPayments: 1, exponent: null, exponentStatus: "unverified" })]);
  const items = attentionItems({
    todayKey: TODAY,
    unrecovered: [{ currency: "USD", invoices: 1, amountDueLatestAttempt: 129700, earliestFailureAt: null, latestFailureAt: null, exponent: 2, exponentStatus: "verified" }],
    stripe,
    cashAccounts: [],
    hasAnyCashRecord: false,
    expenses: [],
    overdue: [],
    missingPayments: [],
    burnRows: [],
    burnWindowFrom: "2026-07-01",
  });
  assert.deepEqual(items.map((i) => [i.id, i.tone]), [
    ["unrecovered-USD", "danger"],
    ["failed-attempts", "warning"],
    ["no-cash", "warning"],
    ["no-expenses", "warning"],
    ["unverified-format", "info"],
    ["gross", "info"],
  ]);
  assert.match(items[0].detail, /\$1,297\.00/);
  assert.match(items[1].detail, /aren't losses/);
  assert.match(items.find((i) => i.id === "unverified-format")!.title, /CAD/);

  const quiet = attentionItems({ todayKey: TODAY, unrecovered: [], stripe: [], cashAccounts: [], hasAnyCashRecord: true, expenses: [expense({ incurredOn: "2026-01-01" })], overdue: [], missingPayments: [], burnRows: [{ currency: "USD", monthlyBurn: 10, windowTotal: 30, recordsSince: "2026-01-01", status: "ok" }], burnWindowFrom: "2026-07-01" });
  assert.deepEqual(quiet, []);
});

test("periods: this month runs to date; the others are complete months; unknown values fall back", () => {
  assert.deepEqual(periodBounds("this_month", TODAY), { from: "2026-10-01", to: "2026-10-11", complete: false });
  assert.deepEqual(periodBounds("last_month", TODAY), { from: "2026-09-01", to: "2026-10-01", complete: true });
  assert.deepEqual(periodBounds("last_3_months", TODAY), { from: "2026-07-01", to: "2026-10-01", complete: true });
  assert.deepEqual(periodBounds("last_12_months", TODAY), { from: "2025-10-01", to: "2026-10-01", complete: true });
  assert.equal(resolvePeriod("bogus"), "this_month");
  assert.equal(resolvePeriod(["last_month"]), "last_month");
});

test("money formatting uses each currency's own precision", () => {
  assert.equal(formatFinanceMoney(1250, "USD"), "$1,250.00");
  assert.equal(formatFinanceMoney(5000, "JPY"), "¥5,000");
  assert.match(formatFinanceMoney(1.25, "KWD"), /1\.250/);
});

test("cash freshness boundary: younger than 35 days is fresh; exactly 35 and older is stale - in the calculation and in runway", () => {
  assert.equal(isCashStale(34), false);
  assert.equal(isCashStale(35), true);
  assert.equal(isCashStale(36), true);
  const accounts = latestCashBalances(
    [
      balance({ accountLabel: "A 34 days", asOf: "2026-09-06" }),
      balance({ accountLabel: "B 35 days", asOf: "2026-09-05" }),
      balance({ accountLabel: "C 36 days", asOf: "2026-09-04" }),
    ],
    TODAY,
  );
  assert.deepEqual(accounts.map((a) => [a.accountLabel, a.ageDays, a.stale]), [["A 34 days", 34, false], ["B 35 days", 35, true], ["C 36 days", 36, true]]);
  const burn = [{ currency: "USD", monthlyBurn: 1000, windowTotal: 3000, recordsSince: "2026-01-01", status: "ok" as const }];
  for (const [asOf, expected] of [["2026-09-06", "ok"], ["2026-09-05", "stale_cash"], ["2026-09-04", "stale_cash"]] as const) {
    const [row] = runway(cashByCurrency(latestCashBalances([balance({ asOf })], TODAY)), burn);
    assert.equal(row.status, expected, `balance dated ${asOf}`);
  }
  // The UI's wording comes from the same constant as the rule.
  assert.equal(CASH_FRESHNESS_RULE, "A balance is stale once it is 35 days old");
  const items = attentionItems({ todayKey: TODAY, unrecovered: [], stripe: [], cashAccounts: accounts, hasAnyCashRecord: true, expenses: [expense({ incurredOn: "2026-01-01" })], overdue: [], missingPayments: [], burnRows: burn, burnWindowFrom: "2026-07-01" });
  assert.deepEqual(items.filter((i) => i.id.startsWith("stale-")).map((i) => i.title), ["B 35 days balance is 35 days old", "C 36 days balance is 36 days old"]);
});

test("burn history is judged per currency: an old USD record never makes a new JPY ledger look complete", () => {
  const rows = monthlyBurn(
    [
      // USD: recorded since June, so its window (Jul-Sep) is fully covered.
      expense({ incurredOn: "2026-06-01", paidOn: "2026-06-01", amount: 100 }),
      expense({ paidOn: "2026-07-05", amount: 300 }),
      expense({ paidOn: "2026-08-05", amount: 300 }),
      expense({ paidOn: "2026-09-05", amount: 300 }),
      // JPY: first recorded in September - one month of a three-month window.
      expense({ currency: "JPY", incurredOn: "2026-09-10", paidOn: "2026-09-10", amount: 90000 }),
    ],
    TODAY,
  ).rows;
  assert.deepEqual(rows.find((r) => r.currency === "USD"), { currency: "USD", monthlyBurn: 300, windowTotal: 900, recordsSince: "2026-06-01", status: "ok" });
  assert.deepEqual(rows.find((r) => r.currency === "JPY"), { currency: "JPY", monthlyBurn: null, windowTotal: 90000, recordsSince: "2026-09-10", status: "insufficient_history" }, "not 30,000/month from one month of data");
  const [jpyRunway] = runway([{ currency: "JPY", total: 500000, accounts: 1, oldestAsOf: TODAY, staleAccounts: 0 }], rows);
  assert.equal(jpyRunway.status, "no_burn");
  assert.match((jpyRunway as { reason: string }).reason, /JPY expense records start on 2026-09-10/);
  const items = attentionItems({ todayKey: TODAY, unrecovered: [], stripe: [], cashAccounts: [], hasAnyCashRecord: true, expenses: [expense({})], overdue: [], missingPayments: [], burnRows: rows, burnWindowFrom: "2026-07-01" });
  const history = items.find((i) => i.id === "burn-history");
  assert.ok(history && /: JPY$/.test(history.title) && !/USD/.test(history.title), history?.title);
});
