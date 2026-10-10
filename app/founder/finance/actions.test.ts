/**
 * Founder finance server actions (app/founder/finance/actions.ts): a
 * non-founder is refused before anything is called; every write goes to the
 * matching founder_finance.sql database function (never a table write) with
 * the request id / expected version the database needs for idempotency and
 * stale-write checks; input is validated before the round trip; and database
 * refusals become messages. The database-side rules themselves (ownership,
 * decimals, audit, guards) are proven by
 * supabase/pending/scratch/validate-founder-finance.mjs and the TEST run.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/founder/finance/actions.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

const ME = "founder-1";
const REQ = "11111111-1111-4111-8111-111111111111";
const COST = "33333333-3333-4333-8333-333333333333";
const THEIR_COST = "44444444-4444-4444-8444-444444444444";
const EXPENSE = "55555555-5555-4555-8555-555555555555";

let caller: string | null = ME;
let rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
/** Read through a function: assert.deepEqual(rpcCalls, []) narrows the variable itself. */
const rpcCall = (i: number) => rpcCalls[i];
let rpcResponse: { data: unknown; error: unknown } = { data: { status: "recorded" }, error: null };
/** Table operations attempted - only selects are ever expected. */
let tableOps: { table: string; op: string; filters: [string, unknown][] }[] = [];
const costs = [
  { id: COST, owner_id: ME, vendor: "Vercel", category: "hosting", currency: "USD", voided_at: null },
  { id: THEIR_COST, owner_id: "founder-2", vendor: "Theirs", category: "hosting", currency: "USD", voided_at: null },
];

class Query {
  private filters: [string, unknown][] = [];
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() {
    tableOps.push({ table: this.table, op: "select", filters: this.filters });
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }
  insert() {
    tableOps.push({ table: this.table, op: "insert", filters: this.filters });
    return this;
  }
  update() {
    tableOps.push({ table: this.table, op: "update", filters: this.filters });
    return this;
  }
  delete() {
    tableOps.push({ table: this.table, op: "delete", filters: this.filters });
    return this;
  }
  async maybeSingle() {
    const rows = this.table === "founder_recurring_costs" ? costs : [];
    return { data: rows.find((row) => this.filters.every(([c, v]) => (row as Record<string, unknown>)[c] === v)) ?? null, error: null };
  }
}

const db = {
  from: (table: string) => new Query(table),
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return rpcResponse;
  },
};

mock.module(lib("lib/founder/access.ts"), {
  namedExports: { getFounderContext: async () => (caller ? { supabase: db, userId: caller, email: "f@example.com", timeZone: "America/Denver" } : null) },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });

const actions = await import(lib("app/founder/finance/actions.ts"));

// Dates relative to "today" in the founder's zone, so the tests don't age.
const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const tomorrowKey = new Date(Date.parse(`${todayKey}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
  caller = ME;
  rpcCalls = [];
  tableOps = [];
  rpcResponse = { data: { status: "recorded" }, error: null };
});

const expenseFields = { requestId: REQ, vendor: " Figma ", category: "software", amount: "15.00", currency: "usd", incurredOn: todayKey, status: "paid", paidOn: todayKey };

test("a non-founder is refused by every action; no database function or table is touched", async () => {
  caller = null;
  const refused = { ok: false, error: "The Founder Command Center isn't available for this account." };
  for (const result of [
    await actions.recordFounderExpense(expenseFields),
    await actions.recordRecurringCostPayment(COST, { requestId: REQ, coversMonth: "2026-09", amount: "20", paidOn: todayKey }),
    await actions.markFounderExpensePaid(EXPENSE, { expectedUpdatedAt: "v1", paidOn: todayKey }),
    await actions.correctFounderExpense(EXPENSE, { ...expenseFields, expectedUpdatedAt: "v1", reason: "typo" }),
    await actions.createFounderRecurringCost({ requestId: REQ, vendor: "x", category: "software", amount: "1", currency: "USD", cadence: "monthly", startOn: todayKey }),
    await actions.correctFounderRecurringCost(COST, { expectedUpdatedAt: "v1", vendor: "x", category: "software", reason: "r" }),
    await actions.endFounderRecurringCost(COST, { expectedUpdatedAt: "v1", endOn: todayKey }),
    await actions.recordFounderIncome({ requestId: REQ, payer: "x", kind: "one_time", amount: "1", currency: "USD", receivedOn: todayKey, receivedVia: "check" }),
    await actions.correctFounderIncome(EXPENSE, { expectedUpdatedAt: "v1", reason: "r" }),
    await actions.recordFounderCashBalance({ requestId: REQ, accountLabel: "x", balance: "1", currency: "USD", asOf: todayKey }),
    await actions.voidFounderFinanceRecord("expense", EXPENSE, "wrong"),
  ]) {
    assert.deepEqual(result, refused);
  }
  assert.deepEqual(rpcCalls, []);
  assert.deepEqual(tableOps, []);
});

test("record expense: calls founder_record_expense with the request id as the row id, trimmed and normalized", async () => {
  const result = await actions.recordFounderExpense(expenseFields);
  assert.deepEqual(result, { ok: true, status: "recorded", id: REQ });
  assert.deepEqual(rpcCalls, [
    {
      name: "founder_record_expense",
      args: { p_request_id: REQ, p_vendor: "Figma", p_category: "software", p_description: null, p_amount: 15, p_currency: "USD", p_incurred_on: todayKey, p_due_on: null, p_paid_on: todayKey, p_recurring_cost_id: null, p_covers_month: null },
    },
  ]);
  assert.ok(tableOps.every((op) => op.op === "select"), "never a table write");
});

test("a retried submit is reported as a duplicate, not a second record", async () => {
  rpcResponse = { data: { status: "duplicate", id: REQ }, error: null };
  assert.deepEqual(await actions.recordFounderExpense(expenseFields), { ok: true, status: "duplicate", id: REQ });
});

test("inputs are checked before the database: request id, decimals, future dates", async () => {
  assert.deepEqual(await actions.recordFounderExpense({ ...expenseFields, requestId: "not-a-uuid" }), { ok: false, error: "Please reopen the form and try again." });
  assert.equal((await actions.recordFounderExpense({ ...expenseFields, currency: "JPY", amount: "10.5" })).ok, false);
  assert.equal((await actions.recordFounderExpense({ ...expenseFields, paidOn: tomorrowKey })).ok, false);
  assert.equal((await actions.recordFounderIncome({ requestId: REQ, payer: "Acme", kind: "one_time", amount: "1", currency: "USD", receivedOn: todayKey, receivedVia: "stripe" })).ok, false, "manual income can't be Stripe");
  assert.deepEqual(rpcCalls, []);
});

test("edits need the version that was loaded, and a stale write is reported as such", async () => {
  const missingVersion = await actions.correctFounderExpense(EXPENSE, { ...expenseFields, reason: "typo" });
  assert.ok(!missingVersion.ok && /changed since you opened it/.test(missingVersion.error));
  assert.equal((await actions.correctFounderExpense(EXPENSE, { ...expenseFields, expectedUpdatedAt: "v1", reason: "  " })).ok, false, "a correction needs a reason");
  assert.deepEqual(rpcCalls, []);

  rpcResponse = { data: null, error: { code: "FS409", message: "this expense changed since it was loaded" } };
  const stale = await actions.correctFounderExpense(EXPENSE, { ...expenseFields, expectedUpdatedAt: "2026-10-01T00:00:00Z", reason: "amount was wrong" });
  assert.ok(!stale.ok && /changed since you opened it/.test(stale.error));
  assert.equal(rpcCall(0).name, "founder_correct_expense");
  assert.equal(rpcCall(0).args.p_expected_updated_at, "2026-10-01T00:00:00Z");
  assert.equal(rpcCall(0).args.p_reason, "amount was wrong");
});

test("database refusals become readable messages", async () => {
  rpcResponse = { data: null, error: { code: "FS422", message: "that month is already recorded for this recurring cost" } };
  assert.deepEqual(await actions.recordRecurringCostPayment(COST, { requestId: REQ, coversMonth: "2026-09", amount: "20", paidOn: todayKey }), { ok: false, error: "That month is already recorded for this recurring cost." });
  rpcResponse = { data: null, error: { code: "FS404", message: "expense not found" } };
  assert.deepEqual(await actions.markFounderExpensePaid(EXPENSE, { expectedUpdatedAt: "v1", paidOn: todayKey }), { ok: false, error: "That expense could not be found." });
  rpcResponse = { data: null, error: { code: "PGRST202", message: "x" } };
  assert.deepEqual(await actions.recordFounderCashBalance({ requestId: REQ, accountLabel: "Checking", balance: "-5", currency: "USD", asOf: todayKey }), { ok: false, error: "Founder finance isn't enabled on this database yet." });
  rpcResponse = { data: null, error: { code: "XX000", message: "internal detail" } };
  const other = await actions.recordFounderIncome({ requestId: REQ, payer: "Acme", kind: "one_time", amount: "1", currency: "USD", receivedOn: todayKey, receivedVia: "check" });
  assert.ok(!other.ok && !/internal detail/.test(other.error), "internal errors aren't shown");
});

test("recurring payment: only the caller's own cost, in its currency, for one covered month", async () => {
  const theirs = await actions.recordRecurringCostPayment(THEIR_COST, { requestId: REQ, coversMonth: "2026-09", amount: "20", paidOn: todayKey });
  assert.deepEqual(theirs, { ok: false, error: "That recurring cost could not be found." });
  assert.deepEqual(rpcCalls, []);
  assert.deepEqual(tableOps[0].filters, [["id", THEIR_COST], ["owner_id", ME]], "looked up with the owner filter");

  const ok = await actions.recordRecurringCostPayment(COST, { requestId: REQ, coversMonth: "2026-09", amount: "24.99", paidOn: todayKey });
  assert.ok(ok.ok);
  assert.deepEqual(rpcCall(0), {
    name: "founder_record_expense",
    args: { p_request_id: REQ, p_vendor: "Vercel", p_category: "hosting", p_description: null, p_amount: 24.99, p_currency: "USD", p_incurred_on: todayKey, p_due_on: null, p_paid_on: todayKey, p_recurring_cost_id: COST, p_covers_month: "2026-09-01" },
  });
});

test("recurring costs, income and cash call their own functions with the database's argument names", async () => {
  await actions.createFounderRecurringCost({ requestId: REQ, vendor: "Domain", category: "hosting", amount: "120", currency: "USD", cadence: "annual", startOn: "2026-01-01" });
  await actions.correctFounderRecurringCost(COST, { expectedUpdatedAt: "v1", vendor: "Vercel Pro", category: "hosting", description: "", reason: "renamed plan" });
  await actions.endFounderRecurringCost(COST, { expectedUpdatedAt: "v2", endOn: "2026-12-31" });
  await actions.recordFounderIncome({ requestId: REQ, payer: "Acme", kind: "setup_fee", amount: "1500", currency: "USD", receivedOn: todayKey, receivedVia: "bank_transfer", reference: "WIRE-1" });
  await actions.correctFounderIncome(EXPENSE, { expectedUpdatedAt: "v1", payer: "Acme", kind: "setup_fee", amount: "1400", currency: "USD", receivedOn: todayKey, receivedVia: "bank_transfer", reason: "partial" });
  await actions.recordFounderCashBalance({ requestId: REQ, accountLabel: "Checking", balance: "-250.10", currency: "USD", asOf: todayKey, note: "" });
  assert.deepEqual(rpcCalls.map((c) => c.name), ["founder_create_recurring_cost", "founder_correct_recurring_cost", "founder_end_recurring_cost", "founder_record_income", "founder_correct_income", "founder_record_cash_balance"]);
  assert.deepEqual(rpcCalls[1].args, { p_cost_id: COST, p_expected_updated_at: "v1", p_vendor: "Vercel Pro", p_category: "hosting", p_description: null, p_reason: "renamed plan" });
  assert.equal(rpcCalls[3].args.p_received_via, "bank_transfer");
  assert.equal(rpcCalls[5].args.p_balance, -250.1);
});

test("void: only the four record kinds, with a reason, through each kind's own function", async () => {
  assert.deepEqual(await actions.voidFounderFinanceRecord("founder_users", EXPENSE, "x"), { ok: false, error: "That record could not be found." });
  assert.deepEqual(await actions.voidFounderFinanceRecord("toString", EXPENSE, "x"), { ok: false, error: "That record could not be found." });
  assert.equal((await actions.voidFounderFinanceRecord("expense", EXPENSE, "   ")).ok, false);
  assert.deepEqual(rpcCalls, []);
  for (const [entity, fn, arg] of [
    ["expense", "founder_void_expense", "p_expense_id"],
    ["recurring_cost", "founder_void_recurring_cost", "p_cost_id"],
    ["income", "founder_void_income", "p_income_id"],
    ["cash_balance", "founder_void_cash_balance", "p_balance_id"],
  ]) {
    rpcCalls = [];
    assert.ok((await actions.voidFounderFinanceRecord(entity, EXPENSE, "entered twice")).ok);
    assert.deepEqual(rpcCalls, [{ name: fn, args: { [arg]: EXPENSE, p_reason: "entered twice" } }]);
  }
});

test("a client-supplied owner is never authority: owner fields in the form are ignored and never reach the database", async () => {
  const spoof = { owner_id: "founder-2", ownerId: "founder-2", p_owner_id: "founder-2", userId: "founder-2" };
  await actions.recordFounderExpense({ ...expenseFields, ...spoof });
  await actions.recordFounderIncome({ ...spoof, requestId: REQ, payer: "Acme", kind: "one_time", amount: "1", currency: "USD", receivedOn: todayKey, receivedVia: "check" });
  await actions.recordFounderCashBalance({ ...spoof, requestId: REQ, accountLabel: "Checking", balance: "1", currency: "USD", asOf: todayKey });
  await actions.createFounderRecurringCost({ ...spoof, requestId: REQ, vendor: "x", category: "software", amount: "1", currency: "USD", cadence: "monthly", startOn: todayKey });
  await actions.recordRecurringCostPayment(COST, { ...spoof, requestId: REQ, coversMonth: "2026-09", amount: "20", paidOn: todayKey });
  assert.equal(rpcCalls.length, 5);
  for (const call of rpcCalls) {
    assert.ok(!Object.keys(call.args).some((key) => /owner|user/i.test(key)), `${call.name} carries no owner argument - the database uses auth.uid()`);
    assert.ok(!Object.values(call.args).includes("founder-2"), call.name);
  }
  // The only owner filter in the actions is the caller's own session id.
  assert.ok(tableOps.every((op) => op.filters.every(([column, value]) => column !== "owner_id" || value === ME)));
});
