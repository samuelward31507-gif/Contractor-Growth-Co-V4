/**
 * Phase 1B (Close the Money Loop): the pure financial rules for invoices and
 * customer payments. This module mirrors the database triggers in
 * supabase/pending/invoice_foundation.sql one for one - the database is the
 * enforcement boundary, this module is what server actions and UI use to
 * validate before writing and to explain outcomes without a round trip.
 * No Next.js, Supabase, or Date-library imports so it runs under plain
 * node:test.
 *
 * Money is dollars with exactly two decimals (the numeric(12,2) columns).
 * Postgres silently rounds an over-precise value on assignment, so rejecting
 * sub-cent input is this module's job, not the database's. All arithmetic
 * goes through integer cents to avoid 0.1 + 0.2 style drift.
 *
 * Terminology: an invoice's total is "invoiced"; the sum of customer
 * payments is "collected"; jobs.amount stays "contracted"; estimates.amount
 * stays "quoted". Overdue is derived from due_date at read time and is
 * never a stored status.
 */

export type InvoiceStatus = "draft" | "sent" | "partially_paid" | "paid" | "void";

export const INVOICE_STATUSES: readonly InvoiceStatus[] = ["draft", "sent", "partially_paid", "paid", "void"];

export type PaymentMethod = "cash" | "check" | "card_elsewhere" | "bank_transfer" | "other" | "card_online";

/**
 * Phase 1C: `card_online` is recorded only by the Stripe Connect webhook
 * (lib/payments/online-payment.ts) - the database refuses it from anyone but
 * the service role (customer_payments_online_guard). Everything a contractor
 * can record by hand is a ManualPaymentMethod.
 */
export type ManualPaymentMethod = Exclude<PaymentMethod, "card_online">;

/** Every method, for labelling ledger rows (history, activity, reversal copy). */
export const PAYMENT_METHODS: readonly { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "card_elsewhere", label: "Card (processed elsewhere)" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "other", label: "Other" },
  { value: "card_online", label: "Card (paid online)" },
];

/** The methods the Record payment dialog offers and the manual record path accepts. */
export const MANUAL_PAYMENT_METHODS: readonly { value: ManualPaymentMethod; label: string }[] = PAYMENT_METHODS.filter(
  (method): method is { value: ManualPaymentMethod; label: string } => method.value !== "card_online",
);

export function isManualPaymentMethod(value: unknown): value is ManualPaymentMethod {
  return typeof value === "string" && MANUAL_PAYMENT_METHODS.some((method) => method.value === value);
}

/** Default payment terms: due 14 days after the issue date. */
export const DEFAULT_DUE_DAYS = 14;

/** Same ceiling as job amounts (lib/jobs/edit-input.ts): a typo, never stored. */
export const MAX_INVOICE_AMOUNT = 10_000_000;

// ---------------------------------------------------------------------------
// Payment client keys (Phase 1B-5 idempotency)
// ---------------------------------------------------------------------------

/**
 * Mirrors customer_payments_client_key_shape: 8-128 URL-safe characters.
 * A key is minted once per Record-payment submission in the browser and
 * reused on every retry of that same submission, so a replay resolves to
 * the row the first attempt created (customer_payments_org_client_key_unique).
 */
export const CLIENT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidClientKey(value: unknown): value is string {
  return typeof value === "string" && CLIENT_KEY_PATTERN.test(value);
}

/** A fresh key for one payment submission - crypto.randomUUID() where available (every supported browser and Node), a time-plus-random fallback otherwise. */
export function generatePaymentClientKey(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto?.randomUUID) return webCrypto.randomUUID();
  return `pk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ---------------------------------------------------------------------------
// Money precision
// ---------------------------------------------------------------------------

/** True when `value` is a finite number representable in whole cents. */
export function isTwoDecimalAmount(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

export function toCents(value: number): number {
  if (!isTwoDecimalAmount(value)) {
    throw new Error(`Amount ${value} is not a two-decimal dollar amount`);
  }
  return Math.round(value * 100);
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/** Cent-exact addition of two-decimal dollar amounts. */
export function addAmounts(a: number, b: number): number {
  return fromCents(toCents(a) + toCents(b));
}

/** Cent-exact subtraction of two-decimal dollar amounts. */
export function subtractAmounts(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}

export type ParsedAmount = { amount: number; error?: undefined } | { amount?: undefined; error: string };

/**
 * Parses a user-typed money field. Required (an invoice always has a total;
 * a payment always has an amount) - the caller decides whether an empty
 * field means "ask again" or "use the prefill". Rules match parseJobEditInput
 * so a contractor sees the same messages everywhere.
 */
export function parseAmountInput(raw: unknown, options: { allowZero?: boolean } = {}): ParsedAmount {
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (!text) return { error: "Enter an amount." };
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return { error: "Enter a valid amount." };
  if (parsed < 0) return { error: "Amount cannot be negative." };
  if (parsed === 0 && !options.allowZero) return { error: "Amount must be more than zero." };
  if (parsed > MAX_INVOICE_AMOUNT) return { error: "Enter a realistic amount." };
  if (!isTwoDecimalAmount(parsed)) return { error: "Enter the amount in dollars and cents (no more than two decimal places)." };
  return { amount: parsed };
}

// ---------------------------------------------------------------------------
// Numbering and dates
// ---------------------------------------------------------------------------

/** INV-000001. The integer is what the database stores and keeps unique per organization. */
export function formatInvoiceNumber(number: number): string {
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Invoice number must be a positive integer, got ${number}`);
  }
  return `INV-${String(number).padStart(6, "0")}`;
}

/** YYYY-MM-DD for `instant` as seen in `timeZone`, the same calendar the database trigger uses. */
export function calendarDateInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Adds whole days to a YYYY-MM-DD calendar date without any timezone involvement. */
export function addDaysToCalendarDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** The due date the database assigns when an invoice is issued without one: issue date in the org's timezone + 14 days. */
export function defaultDueDate(issuedAt: Date, timeZone: string, days: number = DEFAULT_DUE_DAYS): string {
  return addDaysToCalendarDate(calendarDateInTimeZone(issuedAt, timeZone), days);
}

// ---------------------------------------------------------------------------
// Invoice state
// ---------------------------------------------------------------------------

export type InvoiceMoney = {
  status: InvoiceStatus;
  total: number;
  amountPaid: number;
  dueDate: string | null;
};

export function computeBalanceDue(total: number, amountPaid: number): number {
  return subtractAmounts(total, amountPaid);
}

/** Overdue is a view over an open balance and a past due date, never a status of its own. */
export function isOverdue(invoice: Pick<InvoiceMoney, "status" | "dueDate">, today: string): boolean {
  if (invoice.status !== "sent" && invoice.status !== "partially_paid") return false;
  if (!invoice.dueDate) return false;
  return invoice.dueDate < today;
}

export type DerivedInvoiceState = {
  status: InvoiceStatus;
  balanceDue: number;
  isOverdue: boolean;
  /** Days past due when overdue, otherwise 0. */
  daysOverdue: number;
};

export function deriveInvoiceState(invoice: InvoiceMoney, today: string): DerivedInvoiceState {
  const overdue = isOverdue(invoice, today);
  let daysOverdue = 0;
  if (overdue && invoice.dueDate) {
    const due = Date.UTC(...(invoice.dueDate.split("-").map(Number) as [number, number, number]).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number]);
    const now = Date.UTC(...(today.split("-").map(Number) as [number, number, number]).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number]);
    daysOverdue = Math.round((now - due) / 86_400_000);
  }
  return { status: invoice.status, balanceDue: computeBalanceDue(invoice.total, invoice.amountPaid), isOverdue: overdue, daysOverdue };
}

/** The status the database assigns from a ledger sum, used to predict the outcome of a payment. */
export function statusForAmountPaid(total: number, amountPaid: number): "sent" | "partially_paid" | "paid" {
  const paid = toCents(amountPaid);
  if (paid >= toCents(total)) return "paid";
  if (paid > 0) return "partially_paid";
  return "sent";
}

// ---------------------------------------------------------------------------
// Transitions (the same table invoices_guard_update enforces)
// ---------------------------------------------------------------------------

export type ManualTransition = "issue" | "void";

export type TransitionResult = { ok: true; status: InvoiceStatus; error?: undefined } | { ok: false; error: string };

/**
 * Manual transitions a user can request. Payment-driven moves (sent ->
 * partially_paid -> paid and back on reversal) are not requestable; they are
 * outcomes of applyPayment / reversePayment below.
 */
export function transitionInvoice(invoice: Pick<InvoiceMoney, "status" | "amountPaid">, action: ManualTransition): TransitionResult {
  if (action === "issue") {
    if (invoice.status !== "draft") return { ok: false, error: `Only a draft can be issued (this invoice is ${labelStatus(invoice.status)}).` };
    return { ok: true, status: "sent" };
  }
  if (invoice.status === "void") return { ok: false, error: "This invoice is already void." };
  if (invoice.status === "paid" || invoice.status === "partially_paid" || toCents(invoice.amountPaid) !== 0) {
    return { ok: false, error: "An invoice with recorded payments cannot be voided. Reverse the payments first." };
  }
  return { ok: true, status: "void" };
}

export function canVoid(invoice: Pick<InvoiceMoney, "status" | "amountPaid">): boolean {
  return transitionInvoice(invoice, "void").ok;
}

export function canIssue(invoice: Pick<InvoiceMoney, "status">): boolean {
  return invoice.status === "draft";
}

/** Money columns may change only while the invoice is still a draft. */
export function assertTotalsEditable(invoice: Pick<InvoiceMoney, "status">): { ok: true; error?: undefined } | { ok: false; error: string } {
  if (invoice.status === "draft") return { ok: true };
  return { ok: false, error: "The total is frozen once an invoice has been issued. Void it and create a new one to change the amount." };
}

export function labelStatus(status: InvoiceStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "sent":
      return "Sent";
    case "partially_paid":
      return "Partially paid";
    case "paid":
      return "Paid";
    case "void":
      return "Void";
  }
}

// ---------------------------------------------------------------------------
// Payments (the same rules customer_payments_guard_insert enforces)
// ---------------------------------------------------------------------------

export type PaymentRecord = {
  id: string;
  amount: number;
  reversesPaymentId: string | null;
};

export type PaymentOutcome =
  | { ok: true; amountPaid: number; balanceDue: number; status: "sent" | "partially_paid" | "paid"; error?: undefined }
  | { ok: false; error: string };

/** Predicts the invoice after recording an ordinary (positive) payment. */
export function applyPayment(invoice: InvoiceMoney, amount: number): PaymentOutcome {
  if (!isTwoDecimalAmount(amount)) return { ok: false, error: "Enter the amount in dollars and cents (no more than two decimal places)." };
  if (amount <= 0) return { ok: false, error: "A payment must be a positive amount." };
  if (invoice.status !== "sent" && invoice.status !== "partially_paid") {
    return { ok: false, error: `Payments can only be recorded against an issued, unpaid invoice (this one is ${labelStatus(invoice.status)}).` };
  }
  const balance = computeBalanceDue(invoice.total, invoice.amountPaid);
  if (toCents(amount) > toCents(balance)) {
    return { ok: false, error: `That is more than the balance due of ${formatMoney(balance)}.` };
  }
  const amountPaid = addAmounts(invoice.amountPaid, amount);
  return { ok: true, amountPaid, balanceDue: computeBalanceDue(invoice.total, amountPaid), status: statusForAmountPaid(invoice.total, amountPaid) };
}

export type ReversalOutcome =
  | { ok: true; reversal: { amount: number; reversesPaymentId: string }; amountPaid: number; balanceDue: number; status: "sent" | "partially_paid" | "paid"; error?: undefined }
  | { ok: false; error: string };

/**
 * Predicts the reversal row and the invoice after it. The original payment is
 * never modified: a reversal is a new row whose amount is exactly the negative
 * of the original, and a payment can be reversed at most once.
 */
export function reversePayment(invoice: InvoiceMoney, payments: PaymentRecord[], paymentId: string): ReversalOutcome {
  const original = payments.find((payment) => payment.id === paymentId);
  if (!original) return { ok: false, error: "That payment could not be found on this invoice." };
  if (original.reversesPaymentId) return { ok: false, error: "A reversal cannot itself be reversed." };
  if (payments.some((payment) => payment.reversesPaymentId === paymentId)) return { ok: false, error: "This payment has already been reversed." };
  if (invoice.status !== "sent" && invoice.status !== "partially_paid" && invoice.status !== "paid") {
    return { ok: false, error: `Payments on a ${labelStatus(invoice.status)} invoice cannot be reversed.` };
  }
  const amountPaid = subtractAmounts(invoice.amountPaid, original.amount);
  if (toCents(amountPaid) < 0) return { ok: false, error: "Reversal would take the amount paid below zero." };
  return {
    ok: true,
    reversal: { amount: fromCents(-toCents(original.amount)), reversesPaymentId: paymentId },
    amountPaid,
    balanceDue: computeBalanceDue(invoice.total, amountPaid),
    status: statusForAmountPaid(invoice.total, amountPaid),
  };
}

/** Sum of a ledger (ordinary payments and reversals) in cent-exact dollars - "collected". */
export function sumCollected(payments: Pick<PaymentRecord, "amount">[]): number {
  return fromCents(payments.reduce((sum, payment) => sum + toCents(payment.amount), 0));
}

/** Whole dollars when the amount has none, cents otherwise - the Phase 1A quote-page rule. */
export function formatMoney(value: number): string {
  const hasCents = toCents(value) % 100 !== 0;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: hasCents ? 2 : 0, maximumFractionDigits: hasCents ? 2 : 0 }).format(value);
}
