import { addDaysKey, addMonthsKey, isDateKey, monthKeyOf } from "./model";

/**
 * Founder finance (supabase/pending/founder_finance.sql, Phase 4): the
 * pure rules the /founder/finance pages and actions share. No I/O.
 *
 * The database is the authority on every write (ownership, decimals,
 * idempotency, stale writes, audit history). The checks here exist so a form
 * says what's wrong before a round trip, and so the overview's arithmetic is
 * testable. Accounting rules (approved Gate A decisions):
 *  - Cash basis: an expense counts on its paid date, income on its received
 *    date, Stripe revenue on its payment date. Nothing is dated in the future.
 *  - Every figure is per currency. Nothing is ever converted or added across
 *    currencies.
 *  - Contracted MRR (Agency client terms), manual MRR (the founder's own
 *    entries) and collected revenue (Stripe, manual income) are different
 *    metrics and are never summed together.
 *  - Stripe amounts are gross (as paid, before Stripe fees and with any tax
 *    included). Stripe minor units are converted to major units only where
 *    the database marks the exponent verified (today: USD); everything else
 *    is shown as "amount format not verified" and is left out of totals.
 *  - Burn is the average of the last three COMPLETE months of paid
 *    expenses, checked per currency. A cash balance is stale once it is 35
 *    days old (fresh only while younger than 35 days). Runway is
 *    shown only where cash and burn are in the same currency and both are
 *    trustworthy.
 */

// --- vocabulary (mirrors the table checks) --------------------------------------------------

export const EXPENSE_CATEGORIES = ["software", "hosting", "telecom", "payment_processing", "contractors", "payroll", "marketing", "professional_services", "office", "travel", "insurance", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  software: "Software",
  hosting: "Hosting",
  telecom: "Telecom",
  payment_processing: "Payment processing (e.g. Stripe fees)",
  contractors: "Contractors",
  payroll: "Payroll",
  marketing: "Marketing",
  professional_services: "Professional services",
  office: "Office",
  travel: "Travel",
  insurance: "Insurance",
  other: "Other",
};

export const INCOME_KINDS = ["recurring_fee", "setup_fee", "one_time", "other"] as const;
export type IncomeKind = (typeof INCOME_KINDS)[number];
export const INCOME_KIND_LABELS: Record<IncomeKind, string> = { recurring_fee: "Recurring fee", setup_fee: "Setup fee", one_time: "One-time payment", other: "Other" };

/** How manual income arrived. Stripe is deliberately absent: Stripe payments are recorded automatically and never entered by hand. */
export const RECEIVED_VIA = ["bank_transfer", "check", "cash", "other_non_stripe"] as const;
export type ReceivedVia = (typeof RECEIVED_VIA)[number];
export const RECEIVED_VIA_LABELS: Record<ReceivedVia, string> = { bank_transfer: "Bank transfer", check: "Check", cash: "Cash", other_non_stripe: "Other (not Stripe)" };

export const CADENCES = ["monthly", "annual"] as const;
export type Cadence = (typeof CADENCES)[number];

/** Gate A decision 9: a balance is fresh only while it is younger than this many days. */
export const CASH_STALE_AFTER_DAYS = 35;

/** The one freshness rule: 34 days old is fresh, 35 or more is stale. */
export function isCashStale(ageDays: number): boolean {
  return ageDays >= CASH_STALE_AFTER_DAYS;
}

/** The rule in words, for every place the UI explains it. */
export const CASH_FRESHNESS_RULE = `A balance is stale once it is ${CASH_STALE_AFTER_DAYS} days old`;
export const BURN_WINDOW_MONTHS = 3;

// --- currency ---------------------------------------------------------------------------------

/** ISO 4217 decimal places for MANUAL amounts - the same table as public.founder_currency_minor_units. null = not supported. */
export function currencyDecimals(currency: string): number | null {
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  if (currency === "CLF" || currency === "UYW") return null;
  if (["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"].includes(currency)) return 0;
  if (["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"].includes(currency)) return 3;
  return 2;
}

/**
 * A Stripe minor-unit amount in major units - ONLY when the database marked
 * the currency's exponent verified. Otherwise null: never guessed, never
 * defaulted to 2 (founder_finance.sql section 9, display contract).
 */
export function stripeMajor(minor: number, exponentStatus: string, exponent: number | null): number | null {
  if (exponentStatus !== "verified" || exponent == null || !Number.isInteger(exponent) || exponent < 0) return null;
  return minor / 10 ** exponent;
}

/** Adds major-unit amounts without binary drift (e.g. 0.1 + 0.2), at the currency's own precision. */
function addAmount(a: number, b: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(a * factor + b * factor) / factor;
}

function precisionOf(currency: string): number {
  return currencyDecimals(currency) ?? 3;
}

export type CurrencyTotals = Record<string, number>;

function addTo(totals: CurrencyTotals, currency: string, amount: number) {
  totals[currency] = addAmount(totals[currency] ?? 0, amount, precisionOf(currency));
}

// --- form parsing -------------------------------------------------------------------------------

type Fields = Record<string, unknown>;
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const text = (value: unknown) => String(value ?? "").trim();
const optionalText = (value: unknown) => text(value) || null;

export function parseCurrency(raw: unknown): Parsed<string> {
  const code = text(raw).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return { ok: false, error: "Enter a three-letter currency code, like USD." };
  if (currencyDecimals(code) == null) return { ok: false, error: `${code} isn't supported.` };
  return { ok: true, value: code };
}

/**
 * A major-unit amount ("1,250.50") with at most the currency's own decimal
 * places. Commas are accepted as thousands separators only.
 */
export function parseAmount(raw: unknown, currency: string, options: { allowNegative?: boolean; allowZero?: boolean; label?: string } = {}): Parsed<number> {
  const label = options.label ?? "amount";
  const decimals = currencyDecimals(currency);
  if (decimals == null) return { ok: false, error: `${currency} isn't supported.` };
  const cleaned = text(raw).replace(/,/g, "");
  const pattern = options.allowNegative ? /^-?\d+(\.\d+)?$/ : /^\d+(\.\d+)?$/;
  if (!pattern.test(cleaned)) return { ok: false, error: `Enter the ${label} as a number${options.allowNegative ? "" : " above 0"}.` };
  const fraction = cleaned.split(".")[1] ?? "";
  if (fraction.length > decimals) {
    return { ok: false, error: decimals === 0 ? `${currency} amounts have no decimal places.` : `${currency} amounts have at most ${decimals} decimal place${decimals === 1 ? "" : "s"}.` };
  }
  const value = Number(cleaned);
  const limit = options.allowNegative ? 1e14 : 1e12;
  if (!Number.isFinite(value) || Math.abs(value) >= limit) return { ok: false, error: `That ${label} is too large.` };
  if (!options.allowZero && !options.allowNegative && value <= 0) return { ok: false, error: `Enter the ${label} as a number above 0.` };
  return { ok: true, value };
}

export function parseDate(raw: unknown, label: string, options: { optional?: boolean; notAfter?: string } = {}): Parsed<string | null> {
  const value = text(raw);
  if (!value) return options.optional ? { ok: true, value: null } : { ok: false, error: `Enter the ${label}.` };
  if (!isDateKey(value)) return { ok: false, error: `Enter the ${label} as a date.` };
  if (options.notAfter && value > options.notAfter) return { ok: false, error: `The ${label} can't be in the future.` };
  return { ok: true, value };
}

function parseLabel(raw: unknown, label: string, max: number): Parsed<string> {
  const value = text(raw);
  if (!value || value.length > max) return { ok: false, error: `Enter the ${label} (up to ${max} characters).` };
  return { ok: true, value };
}

function parseDescription(raw: unknown, max = 500): Parsed<string | null> {
  const value = optionalText(raw);
  if (value && value.length > max) return { ok: false, error: `Keep it under ${max} characters.` };
  return { ok: true, value };
}

export function parseReason(raw: unknown): Parsed<string> {
  const value = text(raw);
  if (!value || value.length > 500) return { ok: false, error: "Say why (up to 500 characters) - it's kept in the record's history." };
  return { ok: true, value };
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], error: string): Parsed<T> {
  const value = text(raw) as T;
  return allowed.includes(value) ? { ok: true, value } : { ok: false, error };
}

export type ExpenseInput = { vendor: string; category: ExpenseCategory; description: string | null; amount: number; currency: string; incurredOn: string; dueOn: string | null; paidOn: string | null };

/** An expense, with its payment status: "paid" needs a paid date (not in the future); "unpaid" may carry a due date. */
export function parseExpenseInput(fields: Fields, todayKey: string): Parsed<ExpenseInput> {
  const vendor = parseLabel(fields.vendor, "vendor", 200);
  if (!vendor.ok) return vendor;
  const category = oneOf(fields.category, EXPENSE_CATEGORIES, "Choose a category.");
  if (!category.ok) return category;
  const description = parseDescription(fields.description);
  if (!description.ok) return description;
  const currency = parseCurrency(fields.currency);
  if (!currency.ok) return currency;
  const amount = parseAmount(fields.amount, currency.value);
  if (!amount.ok) return amount;
  const incurredOn = parseDate(fields.incurredOn, "expense date");
  if (!incurredOn.ok) return incurredOn;
  const dueOn = parseDate(fields.dueOn, "due date", { optional: true });
  if (!dueOn.ok) return dueOn;
  const paid = text(fields.status) === "paid";
  const paidOn = paid ? parseDate(fields.paidOn, "date it was paid", { notAfter: todayKey }) : ({ ok: true, value: null } as const);
  if (!paidOn.ok) return paidOn;
  return { ok: true, value: { vendor: vendor.value, category: category.value, description: description.value, amount: amount.value, currency: currency.value, incurredOn: incurredOn.value!, dueOn: dueOn.value, paidOn: paidOn.value } };
}

export type RecurringCostInput = { vendor: string; category: ExpenseCategory; description: string | null; amount: number; currency: string; cadence: Cadence; startOn: string };

export function parseRecurringCostInput(fields: Fields): Parsed<RecurringCostInput> {
  const vendor = parseLabel(fields.vendor, "vendor", 200);
  if (!vendor.ok) return vendor;
  const category = oneOf(fields.category, EXPENSE_CATEGORIES, "Choose a category.");
  if (!category.ok) return category;
  const description = parseDescription(fields.description);
  if (!description.ok) return description;
  const currency = parseCurrency(fields.currency);
  if (!currency.ok) return currency;
  const amount = parseAmount(fields.amount, currency.value);
  if (!amount.ok) return amount;
  const cadence = oneOf(fields.cadence, CADENCES, "Choose monthly or annual.");
  if (!cadence.ok) return cadence;
  const startOn = parseDate(fields.startOn, "start date");
  if (!startOn.ok) return startOn;
  return { ok: true, value: { vendor: vendor.value, category: category.value, description: description.value, amount: amount.value, currency: currency.value, cadence: cadence.value, startOn: startOn.value! } };
}

/** Recurring costs correct their descriptive fields only; amount, currency and cadence are fixed (a price change ends the cost and starts a new one). */
export function parseRecurringCorrection(fields: Fields): Parsed<{ vendor: string; category: ExpenseCategory; description: string | null; reason: string }> {
  const vendor = parseLabel(fields.vendor, "vendor", 200);
  if (!vendor.ok) return vendor;
  const category = oneOf(fields.category, EXPENSE_CATEGORIES, "Choose a category.");
  if (!category.ok) return category;
  const description = parseDescription(fields.description);
  if (!description.ok) return description;
  const reason = parseReason(fields.reason);
  if (!reason.ok) return reason;
  return { ok: true, value: { vendor: vendor.value, category: category.value, description: description.value, reason: reason.value } };
}

export type IncomeInput = { payer: string; kind: IncomeKind; description: string | null; amount: number; currency: string; receivedOn: string; receivedVia: ReceivedVia; reference: string | null };

export function parseIncomeInput(fields: Fields, todayKey: string): Parsed<IncomeInput> {
  const payer = parseLabel(fields.payer, "payer", 200);
  if (!payer.ok) return payer;
  const kind = oneOf(fields.kind, INCOME_KINDS, "Choose what the payment was for.");
  if (!kind.ok) return kind;
  const description = parseDescription(fields.description);
  if (!description.ok) return description;
  const currency = parseCurrency(fields.currency);
  if (!currency.ok) return currency;
  const amount = parseAmount(fields.amount, currency.value);
  if (!amount.ok) return amount;
  const receivedOn = parseDate(fields.receivedOn, "date it was received", { notAfter: todayKey });
  if (!receivedOn.ok) return receivedOn;
  const receivedVia = oneOf(fields.receivedVia, RECEIVED_VIA, "Choose how it was received. Stripe payments are recorded automatically and aren't entered here.");
  if (!receivedVia.ok) return receivedVia;
  const reference = parseDescription(fields.reference, 200);
  if (!reference.ok) return reference;
  return { ok: true, value: { payer: payer.value, kind: kind.value, description: description.value, amount: amount.value, currency: currency.value, receivedOn: receivedOn.value!, receivedVia: receivedVia.value, reference: reference.value } };
}

export type CashBalanceInput = { accountLabel: string; balance: number; currency: string; asOf: string; note: string | null };

/** A balance as the account statement showed it on a date. May be negative (overdrawn). */
export function parseCashBalanceInput(fields: Fields, todayKey: string): Parsed<CashBalanceInput> {
  const accountLabel = parseLabel(fields.accountLabel, "account name", 100);
  if (!accountLabel.ok) return accountLabel;
  const currency = parseCurrency(fields.currency);
  if (!currency.ok) return currency;
  const balance = parseAmount(fields.balance, currency.value, { allowNegative: true, allowZero: true, label: "balance" });
  if (!balance.ok) return balance;
  const asOf = parseDate(fields.asOf, "statement date", { notAfter: todayKey });
  if (!asOf.ok) return asOf;
  const note = parseDescription(fields.note);
  if (!note.ok) return note;
  return { ok: true, value: { accountLabel: accountLabel.value, balance: balance.value, currency: currency.value, asOf: asOf.value!, note: note.value } };
}

// --- records ------------------------------------------------------------------------------------

export type Expense = {
  id: string;
  recurringCostId: string | null;
  coversMonth: string | null;
  vendor: string;
  category: ExpenseCategory;
  description: string | null;
  amount: number;
  currency: string;
  incurredOn: string;
  dueOn: string | null;
  paidOn: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecurringCost = {
  id: string;
  vendor: string;
  category: ExpenseCategory;
  description: string | null;
  amount: number;
  currency: string;
  cadence: Cadence;
  startOn: string;
  endOn: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IncomeReceipt = {
  id: string;
  payer: string;
  kind: IncomeKind;
  description: string | null;
  amount: number;
  currency: string;
  receivedOn: string;
  receivedVia: ReceivedVia;
  reference: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CashBalance = { id: string; accountLabel: string; balance: number; currency: string; asOf: string; note: string | null; voidedAt: string | null; voidReason: string | null; createdAt: string };

export type FinanceEntity = "expense" | "recurring_cost" | "income" | "cash_balance";
export type FinanceEvent = { id: string; entity: FinanceEntity; entityId: string; action: "created" | "corrected" | "paid" | "ended" | "voided"; reason: string | null; occurredAt: string };

/** Stripe revenue, one row per month and currency, exactly as founder_stripe_revenue_summary returns it (minor units). */
export type StripeMonthRow = {
  month: string;
  currency: string;
  collected: number;
  recurringCollected: number;
  uncategorizedCollected: number;
  refunded: number;
  succeededPayments: number;
  failedAttempts: number;
  invoicesWithFailedAttempts: number;
  failedAttemptedAmount: number;
  lastRecordedAt: string | null;
  exponent: number | null;
  exponentStatus: string;
};

export type UnrecoveredRow = { currency: string; invoices: number; amountDueLatestAttempt: number; earliestFailureAt: string | null; latestFailureAt: string | null; exponent: number | null; exponentStatus: string };

export type ContractedRow = { currency: string; monthlyTotal: number; setupTotal: number; clientCount: number; latestChangeAt: string | null };

// --- periods ------------------------------------------------------------------------------------

export const FINANCE_PERIODS = ["this_month", "last_month", "last_3_months", "last_12_months"] as const;
export type FinancePeriod = (typeof FINANCE_PERIODS)[number];
export const FINANCE_PERIOD_LABELS: Record<FinancePeriod, string> = { this_month: "This month", last_month: "Last month", last_3_months: "Last 3 months", last_12_months: "Last 12 months" };

export function resolvePeriod(raw: unknown): FinancePeriod {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return FINANCE_PERIODS.includes(value as FinancePeriod) ? (value as FinancePeriod) : "this_month";
}

/**
 * The local-date window [from, to) of a period. "This month" runs to the end
 * of today (month to date); the others are complete calendar months.
 */
export function periodBounds(period: FinancePeriod, todayKey: string): { from: string; to: string; complete: boolean } {
  const month = monthKeyOf(todayKey);
  switch (period) {
    case "this_month":
      return { from: month, to: addDaysKey(todayKey, 1), complete: false };
    case "last_month":
      return { from: addMonthsKey(month, -1), to: month, complete: true };
    case "last_3_months":
      return { from: addMonthsKey(month, -3), to: month, complete: true };
    case "last_12_months":
      return { from: addMonthsKey(month, -12), to: month, complete: true };
  }
}

const inWindow = (key: string | null, from: string, to: string) => key != null && key >= from && key < to;

// --- revenue -------------------------------------------------------------------------------------

export type StripeCurrencySummary = {
  currency: string;
  verified: boolean;
  /** Major units, or null when the currency's amount format isn't verified. */
  collected: number | null;
  recurring: number | null;
  setup: number | null;
  uncategorized: number | null;
  refunded: number | null;
  failedAttemptedAmount: number | null;
  succeededPayments: number;
  failedAttempts: number;
  invoicesWithFailedAttempts: number;
  lastRecordedAt: string | null;
};

/** Collapses the per-month Stripe rows of a period into one summary per currency. Setup = collected that is neither recurring nor uncategorized. */
export function summarizeStripe(rows: StripeMonthRow[]): StripeCurrencySummary[] {
  const by = new Map<string, StripeMonthRow[]>();
  for (const row of rows) by.set(row.currency, [...(by.get(row.currency) ?? []), row]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, list]) => {
      const sum = (pick: (r: StripeMonthRow) => number) => list.reduce((total, r) => total + pick(r), 0);
      const verified = list.every((r) => r.exponentStatus === "verified" && r.exponent != null) && new Set(list.map((r) => r.exponent)).size === 1;
      const exponent = verified ? list[0].exponent : null;
      const major = (minor: number) => (verified ? stripeMajor(minor, "verified", exponent) : null);
      const collected = sum((r) => r.collected);
      const recurring = sum((r) => r.recurringCollected);
      const uncategorized = sum((r) => r.uncategorizedCollected);
      const lastRecordedAt = list.reduce<string | null>((max, r) => (r.lastRecordedAt && (!max || r.lastRecordedAt > max) ? r.lastRecordedAt : max), null);
      return {
        currency,
        verified,
        collected: major(collected),
        recurring: major(recurring),
        setup: major(collected - recurring - uncategorized),
        uncategorized: major(uncategorized),
        refunded: major(sum((r) => r.refunded)),
        failedAttemptedAmount: major(sum((r) => r.failedAttemptedAmount)),
        succeededPayments: sum((r) => r.succeededPayments),
        failedAttempts: sum((r) => r.failedAttempts),
        invoicesWithFailedAttempts: sum((r) => r.invoicesWithFailedAttempts),
        lastRecordedAt,
      };
    });
}

/** Manual income (received outside Stripe) in a period, per currency, split recurring vs everything else. Voided records never count. */
export function summarizeManualIncome(receipts: IncomeReceipt[], from: string, to: string): { total: CurrencyTotals; recurring: CurrencyTotals; count: number } {
  const total: CurrencyTotals = {};
  const recurring: CurrencyTotals = {};
  let count = 0;
  for (const r of receipts) {
    if (r.voidedAt || !inWindow(r.receivedOn, from, to)) continue;
    count += 1;
    addTo(total, r.currency, r.amount);
    if (r.kind === "recurring_fee") addTo(recurring, r.currency, r.amount);
  }
  return { total, recurring, count };
}

// --- expenses --------------------------------------------------------------------------------------

export type ExpenseSummary = {
  /** Paid in the period (cash basis), per currency. */
  paid: CurrencyTotals;
  paidCount: number;
  /** Recorded but not yet paid (any date), per currency. */
  unpaid: CurrencyTotals;
  unpaidCount: number;
  /** Unpaid with a due date before today. */
  overdue: Expense[];
  /** Paid in the period, per category, per currency. */
  byCategory: { category: ExpenseCategory; totals: CurrencyTotals }[];
};

export function summarizeExpenses(expenses: Expense[], from: string, to: string, todayKey: string): ExpenseSummary {
  const paid: CurrencyTotals = {};
  const unpaid: CurrencyTotals = {};
  const categories = new Map<ExpenseCategory, CurrencyTotals>();
  const overdue: Expense[] = [];
  let paidCount = 0;
  let unpaidCount = 0;
  for (const e of expenses) {
    if (e.voidedAt) continue;
    if (e.paidOn == null) {
      unpaidCount += 1;
      addTo(unpaid, e.currency, e.amount);
      if (e.dueOn && e.dueOn < todayKey) overdue.push(e);
      continue;
    }
    if (!inWindow(e.paidOn, from, to)) continue;
    paidCount += 1;
    addTo(paid, e.currency, e.amount);
    const totals = categories.get(e.category) ?? {};
    addTo(totals, e.currency, e.amount);
    categories.set(e.category, totals);
  }
  overdue.sort((a, b) => (a.dueOn ?? "").localeCompare(b.dueOn ?? ""));
  const byCategory = [...categories.entries()].map(([category, totals]) => ({ category, totals })).sort((a, b) => Math.max(...Object.values(b.totals)) - Math.max(...Object.values(a.totals)));
  return { paid, paidCount, unpaid, unpaidCount, overdue, byCategory };
}

/** A recurring cost is active today if it isn't voided, has started, and hasn't ended. */
export function isActiveCost(cost: RecurringCost, todayKey: string): boolean {
  return !cost.voidedAt && cost.startOn <= todayKey && (cost.endOn == null || cost.endOn >= todayKey);
}

/** Active recurring commitments per currency - monthly and annual kept apart (an annual cost isn't silently spread into a monthly figure). */
export function summarizeRecurring(costs: RecurringCost[], todayKey: string): { monthly: CurrencyTotals; annual: CurrencyTotals; activeCount: number } {
  const monthly: CurrencyTotals = {};
  const annual: CurrencyTotals = {};
  let activeCount = 0;
  for (const c of costs) {
    if (!isActiveCost(c, todayKey)) continue;
    activeCount += 1;
    addTo(c.cadence === "monthly" ? monthly : annual, c.currency, c.amount);
  }
  return { monthly, annual, activeCount };
}

/**
 * Monthly recurring costs active through all of last month with no live
 * payment recorded for it - the commitment exists but the expense record
 * doesn't, so paid expenses (and burn) may be understated.
 */
export function missingRecurringPayments(costs: RecurringCost[], expenses: Expense[], todayKey: string): { cost: RecurringCost; month: string }[] {
  const lastMonth = addMonthsKey(monthKeyOf(todayKey), -1);
  const lastMonthEnd = addDaysKey(monthKeyOf(todayKey), -1);
  return costs
    .filter((c) => !c.voidedAt && c.cadence === "monthly" && c.startOn <= lastMonth && (c.endOn == null || c.endOn >= lastMonthEnd))
    .filter((c) => !expenses.some((e) => !e.voidedAt && e.recurringCostId === c.id && e.coversMonth === lastMonth))
    .map((cost) => ({ cost, month: lastMonth }));
}

// --- net cash result -------------------------------------------------------------------------------

export type NetCashRow = {
  currency: string;
  /** Stripe gross collected minus refunds (verified currencies only) plus manual income, minus paid expenses. null when not supported. */
  net: number | null;
  inflow: number | null;
  outflow: number;
  status: "ok" | "unverified_stripe_format";
};

/**
 * Net cash result for a period, per currency: money in (Stripe gross
 * collected - refunds, plus income received outside Stripe) minus expenses
 * paid. A currency whose Stripe amount format isn't verified gets no figure
 * - adding an unknown-scale amount would be a guess.
 */
export function netCashResult(stripe: StripeCurrencySummary[], manualIncome: CurrencyTotals, paidExpenses: CurrencyTotals): NetCashRow[] {
  const currencies = new Set([...stripe.filter((s) => s.succeededPayments > 0 || (s.refunded ?? 0) > 0 || !s.verified).map((s) => s.currency), ...Object.keys(manualIncome), ...Object.keys(paidExpenses)]);
  return [...currencies].sort().map((currency) => {
    const s = stripe.find((row) => row.currency === currency);
    const outflow = paidExpenses[currency] ?? 0;
    if (s && !s.verified) return { currency, net: null, inflow: null, outflow, status: "unverified_stripe_format" as const };
    const precision = precisionOf(currency);
    const stripeNet = s ? addAmount(s.collected ?? 0, -(s.refunded ?? 0), precision) : 0;
    const inflow = addAmount(stripeNet, manualIncome[currency] ?? 0, precision);
    return { currency, net: addAmount(inflow, -outflow, precision), inflow, outflow, status: "ok" as const };
  });
}

// --- cash, burn, runway -------------------------------------------------------------------------------

export type CashAccount = { accountLabel: string; currency: string; balance: number; asOf: string; ageDays: number; stale: boolean; id: string };

function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86_400_000);
}

/** The latest live balance of each account (account + currency), newest statement date first, then newest entry. */
export function latestCashBalances(balances: CashBalance[], todayKey: string): CashAccount[] {
  const latest = new Map<string, CashBalance>();
  for (const b of balances) {
    if (b.voidedAt) continue;
    const key = `${b.accountLabel.toLowerCase()}\u0000${b.currency}`;
    const current = latest.get(key);
    if (!current || b.asOf > current.asOf || (b.asOf === current.asOf && b.createdAt > current.createdAt)) latest.set(key, b);
  }
  return [...latest.values()]
    .map((b) => {
      const ageDays = daysBetween(b.asOf, todayKey);
      return { id: b.id, accountLabel: b.accountLabel, currency: b.currency, balance: b.balance, asOf: b.asOf, ageDays, stale: isCashStale(ageDays) };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.accountLabel.localeCompare(b.accountLabel));
}

export type CashByCurrency = { currency: string; total: number; accounts: number; oldestAsOf: string; staleAccounts: number };

export function cashByCurrency(accounts: CashAccount[]): CashByCurrency[] {
  const by = new Map<string, CashByCurrency>();
  for (const a of accounts) {
    const row = by.get(a.currency) ?? { currency: a.currency, total: 0, accounts: 0, oldestAsOf: a.asOf, staleAccounts: 0 };
    row.total = addAmount(row.total, a.balance, precisionOf(a.currency));
    row.accounts += 1;
    if (a.asOf < row.oldestAsOf) row.oldestAsOf = a.asOf;
    if (a.stale) row.staleAccounts += 1;
    by.set(a.currency, row);
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export type BurnRow = {
  currency: string;
  /** Average monthly paid expenses over the window, or null when there isn't enough history to trust it. */
  monthlyBurn: number | null;
  windowTotal: number;
  /** The earliest expense date recorded IN THIS CURRENCY (paid or incurred, whichever is first). */
  recordsSince: string;
  status: "ok" | "insufficient_history" | "no_paid_expenses";
};

/**
 * Gross monthly burn per currency: expenses PAID in the last three complete
 * months, divided by three. Revenue isn't netted against it. Trusted only
 * when that currency's own expense records reach back to the start of the
 * window - otherwise a founder who started recording a currency last week
 * would see a burn a third of the real one. History is never borrowed from
 * another currency's older records.
 */
export function monthlyBurn(expenses: Expense[], todayKey: string): { window: { from: string; to: string }; rows: BurnRow[] } {
  const to = monthKeyOf(todayKey);
  const from = addMonthsKey(to, -BURN_WINDOW_MONTHS);
  const totals: CurrencyTotals = {};
  const since = new Map<string, string>();
  for (const e of expenses) {
    if (e.voidedAt) continue;
    const first = e.paidOn && e.paidOn < e.incurredOn ? e.paidOn : e.incurredOn;
    const current = since.get(e.currency);
    if (current == null || first < current) since.set(e.currency, first);
    if (inWindow(e.paidOn, from, to)) addTo(totals, e.currency, e.amount);
  }
  const rows = [...since.keys()].sort().map((currency): BurnRow => {
    const windowTotal = totals[currency] ?? 0;
    const recordsSince = since.get(currency) as string;
    if (recordsSince > from) return { currency, monthlyBurn: null, windowTotal, recordsSince, status: "insufficient_history" };
    if (windowTotal <= 0) return { currency, monthlyBurn: null, windowTotal, recordsSince, status: "no_paid_expenses" };
    return { currency, monthlyBurn: Math.round((windowTotal / BURN_WINDOW_MONTHS) * 10 ** precisionOf(currency)) / 10 ** precisionOf(currency), windowTotal, recordsSince, status: "ok" };
  });
  return { window: { from, to }, rows };
}

export type RunwayRow =
  | { currency: string; status: "ok"; months: number; cash: number; burn: number }
  | { currency: string; status: "overdrawn"; cash: number; burn: number }
  | { currency: string; status: "stale_cash" | "no_cash" | "no_burn"; reason: string };

/**
 * Runway per currency, only where a fresh cash total and a trusted burn are
 * in the SAME currency (Gate A decision 10 - no conversion). Everything else
 * says why there's no figure.
 */
export function runway(cash: CashByCurrency[], burn: BurnRow[]): RunwayRow[] {
  const currencies = new Set([...cash.map((c) => c.currency), ...burn.map((b) => b.currency)]);
  return [...currencies].sort().map((currency): RunwayRow => {
    const c = cash.find((row) => row.currency === currency);
    const b = burn.find((row) => row.currency === currency);
    if (!c) return { currency, status: "no_cash", reason: `No ${currency} cash balance is recorded.` };
    if (c.staleAccounts > 0) return { currency, status: "stale_cash", reason: `A ${currency} balance is ${CASH_STALE_AFTER_DAYS} or more days old - record a current balance.` };
    if (!b || b.monthlyBurn == null) {
      const why = b?.status === "insufficient_history" ? `${currency} expense records start on ${b.recordsSince}, so they don't cover the last ${BURN_WINDOW_MONTHS} complete months` : `no ${currency} expenses were paid in the last ${BURN_WINDOW_MONTHS} complete months`;
      return { currency, status: "no_burn", reason: `No trustworthy ${currency} burn: ${why}.` };
    }
    if (c.total <= 0) return { currency, status: "overdrawn", cash: c.total, burn: b.monthlyBurn };
    return { currency, status: "ok", months: Math.floor((c.total / b.monthlyBurn) * 10) / 10, cash: c.total, burn: b.monthlyBurn };
  });
}

// --- attention ----------------------------------------------------------------------------------------

export type AttentionItem = { id: string; tone: "danger" | "warning" | "info"; title: string; detail: string; href?: string };

export type AttentionInput = {
  todayKey: string;
  unrecovered: UnrecoveredRow[];
  stripe: StripeCurrencySummary[];
  cashAccounts: CashAccount[];
  hasAnyCashRecord: boolean;
  expenses: Expense[];
  overdue: Expense[];
  missingPayments: { cost: RecurringCost; month: string }[];
  burnRows: BurnRow[];
  burnWindowFrom: string;
};

/** What needs the founder's attention, most severe first. Pure - every source is passed in. */
export function attentionItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const u of input.unrecovered) {
    const amount = stripeMajor(u.amountDueLatestAttempt, u.exponentStatus, u.exponent);
    items.push({
      id: `unrecovered-${u.currency}`,
      tone: "danger",
      title: `${u.invoices} unpaid Stripe invoice${u.invoices === 1 ? "" : "s"} in ${u.currency}`,
      detail: `${amount != null ? `${formatFinanceMoney(amount, u.currency)} at the latest attempt. ` : "Amount format not verified. "}A payment failed and no successful payment has been recorded since.`,
    });
  }
  const failing = input.stripe.filter((s) => s.failedAttempts > 0);
  if (failing.length) {
    items.push({
      id: "failed-attempts",
      tone: "warning",
      title: "Failed payment attempts in this period",
      detail: `${failing.map((s) => `${s.failedAttempts} in ${s.currency} across ${s.invoicesWithFailedAttempts} invoice${s.invoicesWithFailedAttempts === 1 ? "" : "s"}`).join("; ")}. Invoices later paid aren't losses - only the unpaid ones above are.`,
    });
  }
  if (!input.hasAnyCashRecord) {
    items.push({ id: "no-cash", tone: "warning", title: "No cash balance recorded", detail: "Runway can't be calculated without a current balance.", href: "/founder/finance/records?tab=cash" });
  } else {
    for (const a of input.cashAccounts.filter((x) => x.stale)) {
      items.push({ id: `stale-${a.id}`, tone: "warning", title: `${a.accountLabel} balance is ${a.ageDays} days old`, detail: `${CASH_FRESHNESS_RULE}. Record the current statement balance.`, href: "/founder/finance/records?tab=cash" });
    }
  }
  if (input.overdue.length) {
    items.push({ id: "overdue", tone: "warning", title: `${input.overdue.length} unpaid expense${input.overdue.length === 1 ? " is" : "s are"} past due`, detail: input.overdue.slice(0, 3).map((e) => `${e.vendor} (due ${e.dueOn})`).join(", "), href: "/founder/finance/records?tab=expenses" });
  }
  for (const m of input.missingPayments) {
    items.push({ id: `missing-${m.cost.id}`, tone: "warning", title: `No ${m.cost.vendor} payment recorded for ${monthLabel(m.month)}`, detail: "The recurring cost was active all month, so paid expenses and burn may be understated.", href: "/founder/finance/records?tab=recurring" });
  }
  if (!input.expenses.some((e) => !e.voidedAt)) {
    items.push({ id: "no-expenses", tone: "warning", title: "No expenses recorded yet", detail: "Profit, net cash result and burn can't be trusted until expenses are recorded.", href: "/founder/finance/records?tab=expenses" });
  } else {
    // Checked per currency: one currency's older records never make another look complete.
    const short = input.burnRows.filter((r) => r.status === "insufficient_history");
    if (short.length) {
      items.push({
        id: "burn-history",
        tone: "info",
        title: `Expense history is shorter than three months: ${short.map((r) => r.currency).join(", ")}`,
        detail: `${short.map((r) => `${r.currency} records start on ${r.recordsSince}`).join("; ")}. Burn needs every paid expense in that currency since ${input.burnWindowFrom}.`,
        href: "/founder/finance/records?tab=expenses",
      });
    }
  }
  const unverified = input.stripe.filter((s) => !s.verified).map((s) => s.currency);
  for (const u of input.unrecovered) if (u.exponentStatus !== "verified" && !unverified.includes(u.currency)) unverified.push(u.currency);
  if (unverified.length) {
    items.push({ id: "unverified-format", tone: "info", title: `Stripe amount format not verified: ${unverified.sort().join(", ")}`, detail: "These amounts are left out of every total until the currency's format is verified in a reviewed migration." });
  }
  if (input.stripe.some((s) => s.succeededPayments > 0)) {
    items.push({ id: "gross", tone: "info", title: "Stripe revenue is gross", detail: "Tax isn't separated and Stripe fees aren't deducted. Record Stripe fees as a payment-processing expense." });
  }
  const order = { danger: 0, warning: 1, info: 2 } as const;
  return items.sort((a, b) => order[a.tone] - order[b.tone]);
}

// --- display ------------------------------------------------------------------------------------------

/** A major-unit amount at the currency's own precision ("$1,250.00", "¥5,000", "KWD 1.250"). */
export function formatFinanceMoney(value: number, currency: string): string {
  const decimals = currencyDecimals(currency) ?? 2;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  } catch {
    return `${value.toFixed(decimals)} ${currency}`;
  }
}

/** Per-currency totals as separate figures, never combined. */
export function totalsList(totals: CurrencyTotals): { currency: string; amount: number }[] {
  return Object.keys(totals)
    .sort()
    .map((currency) => ({ currency, amount: totals[currency] }));
}

export function monthLabel(monthKey: string): string {
  return new Date(`${monthKey}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
}
