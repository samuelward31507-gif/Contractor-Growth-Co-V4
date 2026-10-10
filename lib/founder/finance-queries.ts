import type { SupabaseClient } from "@supabase/supabase-js";
import type { CashBalance, ContractedRow, Expense, FinanceEvent, IncomeReceipt, RecurringCost, StripeMonthRow, UnrecoveredRow } from "./finance";

/**
 * Founder finance reads (supabase/pending/founder_finance.sql).
 *
 * The record tables are read through the founder's own session: RLS limits
 * every row to owner_id = auth.uid() AND is_founder(), and each query also
 * filters on owner_id explicitly. The Stripe and Agency figures come only
 * from the three founder-only, aggregate-only database functions - they
 * return per-currency totals, never client names, organization ids or
 * individual revenue rows, and this module never reads revenue_events or
 * agency_clients directly.
 *
 * Every read returns { ok: false } on error so a page says "couldn't load"
 * rather than showing an empty state that looks like "nothing here".
 * `notEnabled` marks a database where the finance migration isn't applied.
 */

export type FinanceLoaded<T> = { ok: true; data: T } | { ok: false; notEnabled: boolean };

type PgError = { code?: string } | null;
const MISSING = new Set(["42P01", "42883", "PGRST202", "PGRST205"]);
const failed = (error: PgError): { ok: false; notEnabled: boolean } => ({ ok: false, notEnabled: MISSING.has(error?.code ?? "") });
const num = (value: number | string | null | undefined): number => Number(value ?? 0);

const EXPENSE_COLUMNS = "id, recurring_cost_id, covers_month, vendor, category, description, amount, currency, incurred_on, due_on, paid_on, voided_at, void_reason, created_at, updated_at";
const COST_COLUMNS = "id, vendor, category, description, amount, currency, cadence, start_on, end_on, voided_at, void_reason, created_at, updated_at";
const INCOME_COLUMNS = "id, payer, kind, description, amount, currency, received_on, received_via, reference, voided_at, void_reason, created_at, updated_at";
const CASH_COLUMNS = "id, account_label, balance, currency, as_of, note, voided_at, void_reason, created_at";
const EVENT_COLUMNS = "id, entity, entity_id, action, reason, occurred_at";

type Row = Record<string, unknown>;
const s = (row: Row, key: string) => row[key] as string;
const sn = (row: Row, key: string) => (row[key] ?? null) as string | null;

export const toExpense = (r: Row): Expense => ({
  id: s(r, "id"),
  recurringCostId: sn(r, "recurring_cost_id"),
  coversMonth: sn(r, "covers_month"),
  vendor: s(r, "vendor"),
  category: s(r, "category") as Expense["category"],
  description: sn(r, "description"),
  amount: num(r.amount as string),
  currency: s(r, "currency"),
  incurredOn: s(r, "incurred_on"),
  dueOn: sn(r, "due_on"),
  paidOn: sn(r, "paid_on"),
  voidedAt: sn(r, "voided_at"),
  voidReason: sn(r, "void_reason"),
  createdAt: s(r, "created_at"),
  updatedAt: s(r, "updated_at"),
});

export const toRecurringCost = (r: Row): RecurringCost => ({
  id: s(r, "id"),
  vendor: s(r, "vendor"),
  category: s(r, "category") as RecurringCost["category"],
  description: sn(r, "description"),
  amount: num(r.amount as string),
  currency: s(r, "currency"),
  cadence: s(r, "cadence") as RecurringCost["cadence"],
  startOn: s(r, "start_on"),
  endOn: sn(r, "end_on"),
  voidedAt: sn(r, "voided_at"),
  voidReason: sn(r, "void_reason"),
  createdAt: s(r, "created_at"),
  updatedAt: s(r, "updated_at"),
});

export const toIncome = (r: Row): IncomeReceipt => ({
  id: s(r, "id"),
  payer: s(r, "payer"),
  kind: s(r, "kind") as IncomeReceipt["kind"],
  description: sn(r, "description"),
  amount: num(r.amount as string),
  currency: s(r, "currency"),
  receivedOn: s(r, "received_on"),
  receivedVia: s(r, "received_via") as IncomeReceipt["receivedVia"],
  reference: sn(r, "reference"),
  voidedAt: sn(r, "voided_at"),
  voidReason: sn(r, "void_reason"),
  createdAt: s(r, "created_at"),
  updatedAt: s(r, "updated_at"),
});

export const toCashBalance = (r: Row): CashBalance => ({
  id: s(r, "id"),
  accountLabel: s(r, "account_label"),
  balance: num(r.balance as string),
  currency: s(r, "currency"),
  asOf: s(r, "as_of"),
  note: sn(r, "note"),
  voidedAt: sn(r, "voided_at"),
  voidReason: sn(r, "void_reason"),
  createdAt: s(r, "created_at"),
});

export type FinanceRecords = { expenses: Expense[]; recurringCosts: RecurringCost[]; income: IncomeReceipt[]; cashBalances: CashBalance[] };

/** All of the founder's own finance records (voided ones included - pages decide what to show). */
export async function getFinanceRecords(supabase: SupabaseClient, ownerId: string): Promise<FinanceLoaded<FinanceRecords>> {
  const [expenses, costs, income, cash] = await Promise.all([
    supabase.from("founder_expenses").select(EXPENSE_COLUMNS).eq("owner_id", ownerId).order("incurred_on", { ascending: false }).order("created_at", { ascending: false }).limit(5000),
    supabase.from("founder_recurring_costs").select(COST_COLUMNS).eq("owner_id", ownerId).order("start_on", { ascending: false }).limit(1000),
    supabase.from("founder_income_receipts").select(INCOME_COLUMNS).eq("owner_id", ownerId).order("received_on", { ascending: false }).order("created_at", { ascending: false }).limit(5000),
    supabase.from("founder_cash_balances").select(CASH_COLUMNS).eq("owner_id", ownerId).order("as_of", { ascending: false }).order("created_at", { ascending: false }).limit(5000),
  ]);
  const error = expenses.error ?? costs.error ?? income.error ?? cash.error;
  if (error) return failed(error);
  return {
    ok: true,
    data: {
      expenses: (expenses.data as Row[]).map(toExpense),
      recurringCosts: (costs.data as Row[]).map(toRecurringCost),
      income: (income.data as Row[]).map(toIncome),
      cashBalances: (cash.data as Row[]).map(toCashBalance),
    },
  };
}

/** The append-only change history of the founder's own records, newest first. */
export async function getFinanceEvents(supabase: SupabaseClient, ownerId: string, limit = 1000): Promise<FinanceLoaded<FinanceEvent[]>> {
  const { data, error } = await supabase.from("founder_finance_events").select(EVENT_COLUMNS).eq("owner_id", ownerId).order("occurred_at", { ascending: false }).limit(limit);
  if (error) return failed(error);
  return {
    ok: true,
    data: (data as Row[]).map((r) => ({ id: s(r, "id"), entity: s(r, "entity") as FinanceEvent["entity"], entityId: s(r, "entity_id"), action: s(r, "action") as FinanceEvent["action"], reason: sn(r, "reason"), occurredAt: s(r, "occurred_at") })),
  };
}

/** Stripe revenue for [from, to), per month and currency - totals only, minor units. */
export async function getStripeRevenueSummary(supabase: SupabaseClient, from: Date, to: Date): Promise<FinanceLoaded<StripeMonthRow[]>> {
  const { data, error } = await supabase.rpc("founder_stripe_revenue_summary", { p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) return failed(error);
  return {
    ok: true,
    data: ((data ?? []) as Row[]).map((r) => ({
      month: s(r, "month"),
      currency: s(r, "currency"),
      collected: num(r.collected as string),
      recurringCollected: num(r.recurring_collected as string),
      uncategorizedCollected: num(r.uncategorized_collected as string),
      refunded: num(r.refunded as string),
      succeededPayments: num(r.succeeded_payments as string),
      failedAttempts: num(r.failed_attempts as string),
      invoicesWithFailedAttempts: num(r.invoices_with_failed_attempts as string),
      failedAttemptedAmount: num(r.failed_attempted_amount as string),
      lastRecordedAt: sn(r, "last_recorded_at"),
      exponent: r.minor_unit_exponent == null ? null : Number(r.minor_unit_exponent),
      exponentStatus: s(r, "exponent_status"),
    })),
  };
}

/** Invoices with a failed attempt and no successful payment ever recorded - as of now, per currency. */
export async function getUnrecoveredInvoices(supabase: SupabaseClient): Promise<FinanceLoaded<UnrecoveredRow[]>> {
  const { data, error } = await supabase.rpc("founder_stripe_unrecovered_invoices");
  if (error) return failed(error);
  return {
    ok: true,
    data: ((data ?? []) as Row[]).map((r) => ({
      currency: s(r, "currency"),
      invoices: num(r.unrecovered_invoices as string),
      amountDueLatestAttempt: num(r.amount_due_latest_attempt as string),
      earliestFailureAt: sn(r, "earliest_failure_at"),
      latestFailureAt: sn(r, "latest_failure_at"),
      exponent: r.minor_unit_exponent == null ? null : Number(r.minor_unit_exponent),
      exponentStatus: s(r, "exponent_status"),
    })),
  };
}

/** The Agency's contracted fees for live and ongoing clients, per currency - no client names or ids. */
export async function getContractedMrr(supabase: SupabaseClient): Promise<FinanceLoaded<ContractedRow[]>> {
  const { data, error } = await supabase.rpc("founder_contracted_mrr");
  if (error) return failed(error);
  return {
    ok: true,
    data: ((data ?? []) as Row[]).map((r) => ({
      currency: s(r, "currency"),
      monthlyTotal: num(r.monthly_total as string),
      setupTotal: num(r.setup_total as string),
      clientCount: num(r.client_count as string),
      latestChangeAt: sn(r, "latest_change_at"),
    })),
  };
}
