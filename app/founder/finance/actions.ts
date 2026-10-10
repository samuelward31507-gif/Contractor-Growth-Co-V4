"use server";

import { revalidatePath } from "next/cache";
import { getFounderContext, type FounderContext } from "@/lib/founder/access";
import { isDateKey, localDateKey } from "@/lib/founder/model";
import { parseAmount, parseCashBalanceInput, parseDate, parseExpenseInput, parseIncomeInput, parseReason, parseRecurringCorrection, parseRecurringCostInput } from "@/lib/founder/finance";

/**
 * Founder finance writes. Every one goes through a SECURITY DEFINER database
 * function in supabase/pending/founder_finance.sql - there are no table
 * writes here (the tables have no insert/update/delete grant, and a guard
 * trigger refuses any write that doesn't come through those functions).
 *
 * Each action re-resolves founder access first (never trusting that the page
 * rendered for a founder), validates the input so the form can say what's
 * wrong, and lets the database enforce the rest again: ownership, currency
 * decimals, idempotency (the request id made when the form opened becomes
 * the row id, so a double-submit or retry returns "duplicate"), stale writes
 * (the record's updated_at as loaded), and the audit history.
 */

type Fields = Record<string, unknown>;
export type FinanceActionResult = { ok: true; status: "recorded" | "duplicate"; id?: string } | { ok: false; error: string };

const NOT_AVAILABLE: { ok: false; error: string } = { ok: false, error: "The Founder Command Center isn't available for this account." };
const REOPEN: { ok: false; error: string } = { ok: false, error: "Please reopen the form and try again." };
const STALE = "This record changed since you opened it. Close and reopen it to see the latest version, then try again.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function founder(): Promise<FounderContext | null> {
  return getFounderContext();
}

function refresh() {
  revalidatePath("/founder/finance", "layout");
}

const idOf = (value: unknown): string | null => (typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null);
const versionOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const today = (ctx: FounderContext) => localDateKey(new Date(), ctx.timeZone);

/** Database refusals as messages. FS422 carries a message written for the founder. */
function financeError(error: { code?: string; message?: string }, notFound: string): string {
  switch (error.code) {
    case "FS409":
      return STALE;
    case "FS404":
      return notFound;
    case "FS422": {
      const message = (error.message ?? "").trim();
      return message ? `${message[0].toUpperCase()}${message.slice(1)}.` : "That change isn't allowed.";
    }
    case "FS403":
      return "Financial records change only through these forms.";
    case "42883":
    case "PGRST202":
      return "Founder finance isn't enabled on this database yet.";
    default:
      return "We couldn't save that. Please try again - nothing is recorded twice.";
  }
}

function result(data: unknown, fallbackId?: string): FinanceActionResult {
  const r = (data ?? {}) as { status?: string; id?: string };
  return { ok: true, status: r.status === "duplicate" ? "duplicate" : "recorded", id: r.id ?? fallbackId };
}

// --- expenses -------------------------------------------------------------------------------

/** Records an expense - paid (with the date it was paid) or unpaid (optionally with a due date). */
export async function recordFounderExpense(fields: Fields): Promise<FinanceActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const requestId = idOf(fields.requestId);
  if (!requestId) return REOPEN;
  const parsed = parseExpenseInput(fields, today(ctx));
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const { data, error } = await ctx.supabase.rpc("founder_record_expense", {
    p_request_id: requestId,
    p_vendor: v.vendor,
    p_category: v.category,
    p_description: v.description,
    p_amount: v.amount,
    p_currency: v.currency,
    p_incurred_on: v.incurredOn,
    p_due_on: v.dueOn,
    p_paid_on: v.paidOn,
    p_recurring_cost_id: null,
    p_covers_month: null,
  });
  if (error) return { ok: false, error: financeError(error, "That expense could not be found.") };
  refresh();
  return result(data, requestId);
}

/** Records the payment of a recurring cost for one month (at most one live payment per cost per month - the database refuses a second). */
export async function recordRecurringCostPayment(costId: string, fields: Fields): Promise<FinanceActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const requestId = idOf(fields.requestId);
  if (!requestId) return REOPEN;
  if (!UUID.test(costId)) return { ok: false, error: "That recurring cost could not be found." };
  const { data: cost } = await ctx.supabase.from("founder_recurring_costs").select("id, vendor, category, currency, voided_at").eq("id", costId).eq("owner_id", ctx.userId).maybeSingle();
  if (!cost) return { ok: false, error: "That recurring cost could not be found." };
  const c = cost as { vendor: string; category: string; currency: string; voided_at: string | null };
  if (c.voided_at) return { ok: false, error: "That recurring cost was voided." };
  const month = String(fields.coversMonth ?? "").trim();
  const coversMonth = /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month;
  if (!isDateKey(coversMonth) || !coversMonth.endsWith("-01")) return { ok: false, error: "Choose the month this payment covers." };
  const amount = parseAmount(fields.amount, c.currency);
  if (!amount.ok) return amount;
  const paidOn = parseDate(fields.paidOn, "date it was paid", { notAfter: today(ctx) });
  if (!paidOn.ok) return paidOn;
  const { data, error } = await ctx.supabase.rpc("founder_record_expense", {
    p_request_id: requestId,
    p_vendor: c.vendor,
    p_category: c.category,
    p_description: null,
    p_amount: amount.value,
    p_currency: c.currency,
    p_incurred_on: paidOn.value,
    p_due_on: null,
    p_paid_on: paidOn.value,
    p_recurring_cost_id: costId,
    p_covers_month: coversMonth,
  });
  if (error) return { ok: false, error: financeError(error, "That recurring cost could not be found.") };
  refresh();
  return result(data, requestId);
}

export async function markFounderExpensePaid(expenseId: string, fields: Fields): Promise<FinanceActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (!UUID.test(expenseId)) return { ok: false, error: "That expense could not be found." };
  const expected = versionOf(fields.expectedUpdatedAt);
  if (!expected) return { ok: false, error: STALE };
  const paidOn = parseDate(fields.paidOn, "date it was paid", { notAfter: today(ctx) });
  if (!paidOn.ok) return paidOn;
  const { data, error } = await ctx.supabase.rpc("founder_mark_expense_paid", { p_expense_id: expenseId, p_expected_updated_at: expected, p_paid_on: paidOn.value });
  if (error) return { ok: false, error: financeError(error, "That expense could not be found.") };
  refresh();
  return result(data, expenseId);
}

/** Corrects what was entered, with a reason; the before and after are kept in the record's history. */
export async function correctFounderExpense(expenseId: string, fields: Fields): Promise<FinanceActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (!UUID.test(expenseId)) return { ok: false, error: "That expense could not be found." };
  const expected = versionOf(fields.expectedUpdatedAt);
  if (!expected) return { ok: false, error: STALE };
  const parsed = parseExpenseInput(fields, today(ctx));
  if (!parsed.ok) return parsed;
  const reason = parseReason(fields.reason);
  if (!reason.ok) return reason;
  const v = parsed.value;
  const { data, error } = await ctx.supabase.rpc("founder_correct_expense", {
    p_expense_id: expenseId,
    p_expected_updated_at: expected,
    p_vendor: v.vendor,
    p_category: v.category,
    p_description: v.description,
    p_amount: v.amount,
    p_currency: v.currency,
    p_incurred_on: v.incurredOn,
    p_due_on: v.dueOn,
    p_paid_on: v.paidOn,
    p_reason: reason.value,
  });
  if (error) return { ok: false, error: financeError(error, "That expense could not be found.") };
  refresh();
  return result(data, expenseId);
}

// --- recurring costs ---------------------------------------------------------------------------

export async function createFounderRecurringCost(fields: Fields): Promise<FinanceActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const requestId = idOf(fields.requestId);
  if (!requestId) return REOPEN;
  const parsed = parseRecurringCostInput(fields);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const { data, error } = await ctx.supabase.rpc("founder_create_recurring_cost", {
    p_request_id: requestId,
    p_vendor: v.vendor,
    p_category: v.category,
    p_description: v.description,
    p_amount: v.amount,
    p_currency: v.currency,
    p_cadence: v.cadence,
    p_start_on: v.startOn,
  });
  if (error) return { ok: false, error: financeError(error, "That recurring cost could not be found.") };
  refresh();
  return result(data, requestId);
}

/** Vendor, category and description only - a price change ends the cost and starts a new one. */
export async function correctFounderRecurringCost(costId: string, fields: Fields): Promise<FinanceActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (!UUID.test(costId)) return { ok: false, error: "That recurring cost could not be found." };
  const expected = versionOf(fields.expectedUpdatedAt);
  if (!expected) return { ok: false, error: STALE };
  const parsed = parseRecurringCorrection(fields);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const { data, error } = await ctx.supabase.rpc("founder_correct_recurring_cost", { p_cost_id: costId, p_expected_updated_at: expected, p_vendor: v.vendor, p_category: v.category, p_description: v.description, p_reason: v.reason });
  if (error) return { ok: false, error: financeError(error, "That recurring cost could not be found.") };
  refresh();
  return result(data, costId);
}

export async function endFounderRecurringCost(costId: string, fields: Fields): Promise<FinanceActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (!UUID.test(costId)) return { ok: false, error: "That recurring cost could not be found." };
  const expected = versionOf(fields.expectedUpdatedAt);
  if (!expected) return { ok: false, error: STALE };
  const endOn = parseDate(fields.endOn, "end date");
  if (!endOn.ok) return endOn;
  const { data, error } = await ctx.supabase.rpc("founder_end_recurring_cost", { p_cost_id: costId, p_expected_updated_at: expected, p_end_on: endOn.value });
  if (error) return { ok: false, error: financeError(error, "That recurring cost could not be found.") };
  refresh();
  return result(data, costId);
}

// --- income received outside Stripe ---------------------------------------------------------------

/** Income received outside Stripe. Kept apart from Stripe revenue (the database refuses a Stripe received-via method). */
export async function recordFounderIncome(fields: Fields): Promise<FinanceActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const requestId = idOf(fields.requestId);
  if (!requestId) return REOPEN;
  const parsed = parseIncomeInput(fields, today(ctx));
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const { data, error } = await ctx.supabase.rpc("founder_record_income", {
    p_request_id: requestId,
    p_payer: v.payer,
    p_kind: v.kind,
    p_description: v.description,
    p_amount: v.amount,
    p_currency: v.currency,
    p_received_on: v.receivedOn,
    p_received_via: v.receivedVia,
    p_reference: v.reference,
  });
  if (error) return { ok: false, error: financeError(error, "That income record could not be found.") };
  refresh();
  return result(data, requestId);
}

export async function correctFounderIncome(incomeId: string, fields: Fields): Promise<FinanceActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (!UUID.test(incomeId)) return { ok: false, error: "That income record could not be found." };
  const expected = versionOf(fields.expectedUpdatedAt);
  if (!expected) return { ok: false, error: STALE };
  const parsed = parseIncomeInput(fields, today(ctx));
  if (!parsed.ok) return parsed;
  const reason = parseReason(fields.reason);
  if (!reason.ok) return reason;
  const v = parsed.value;
  const { data, error } = await ctx.supabase.rpc("founder_correct_income", {
    p_income_id: incomeId,
    p_expected_updated_at: expected,
    p_payer: v.payer,
    p_kind: v.kind,
    p_description: v.description,
    p_amount: v.amount,
    p_currency: v.currency,
    p_received_on: v.receivedOn,
    p_received_via: v.receivedVia,
    p_reference: v.reference,
    p_reason: reason.value,
  });
  if (error) return { ok: false, error: financeError(error, "That income record could not be found.") };
  refresh();
  return result(data, incomeId);
}

// --- cash balances (append-only: a correction is a new balance; a mistake is voided) ------------------

export async function recordFounderCashBalance(fields: Fields): Promise<FinanceActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const requestId = idOf(fields.requestId);
  if (!requestId) return REOPEN;
  const parsed = parseCashBalanceInput(fields, today(ctx));
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const { data, error } = await ctx.supabase.rpc("founder_record_cash_balance", { p_request_id: requestId, p_account_label: v.accountLabel, p_balance: v.balance, p_currency: v.currency, p_as_of: v.asOf, p_note: v.note });
  if (error) return { ok: false, error: financeError(error, "That balance could not be found.") };
  refresh();
  return result(data, requestId);
}

// --- void (entered in error; kept, with the reason, in the history) ----------------------------------

const VOIDERS = {
  expense: { fn: "founder_void_expense", arg: "p_expense_id", notFound: "That expense could not be found." },
  recurring_cost: { fn: "founder_void_recurring_cost", arg: "p_cost_id", notFound: "That recurring cost could not be found." },
  income: { fn: "founder_void_income", arg: "p_income_id", notFound: "That income record could not be found." },
  cash_balance: { fn: "founder_void_cash_balance", arg: "p_balance_id", notFound: "That balance could not be found." },
} as const;

export async function voidFounderFinanceRecord(entity: string, id: string, reason: string): Promise<FinanceActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const voider = Object.prototype.hasOwnProperty.call(VOIDERS, entity) ? VOIDERS[entity as keyof typeof VOIDERS] : null;
  if (!voider || !UUID.test(id)) return { ok: false, error: "That record could not be found." };
  const parsed = parseReason(reason);
  if (!parsed.ok) return parsed;
  const { data, error } = await ctx.supabase.rpc(voider.fn, { [voider.arg]: id, p_reason: parsed.value });
  if (error) return { ok: false, error: financeError(error, voider.notFound) };
  refresh();
  return result(data, id);
}
