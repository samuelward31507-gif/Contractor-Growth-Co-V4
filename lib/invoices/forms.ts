import { applyPayment, isTwoDecimalAmount, parseAmountInput, PAYMENT_METHODS, type InvoiceMoney, type PaymentMethod } from "./domain";
import type { CreateInvoiceFromJobInput, RecordCustomerPaymentInput } from "./service";

/**
 * Phase 1B-3: the pure, client-side half of the invoice dialogs - turns raw
 * form values into the exact input the server actions take, or a message
 * the user can act on before a round trip. The server and database remain
 * authoritative; these exist so the dialogs can show the same wording
 * instantly and so the logic is testable without React.
 */

export type CreateInvoiceFormValues = {
  title: string;
  amountRaw: string;
  dueDate: string;
  notes: string;
  alsoSetJobAmount: boolean;
};

export type CreateInvoiceJobContext = { id: string; title: string; amount: number | null; status: string };

export function defaultCreateInvoiceForm(job: CreateInvoiceJobContext): CreateInvoiceFormValues {
  return {
    title: job.title,
    amountRaw: job.amount != null ? String(job.amount) : "",
    dueDate: "",
    notes: "",
    // The audit's recommendation: default ON only when the job has no
    // amount, so a real contracted figure is never touched by an invoice.
    alsoSetJobAmount: job.amount == null,
  };
}

export type BuildResult<T> = { input: T; error?: undefined } | { input?: undefined; error: string };

export function buildCreateInvoiceInput(values: CreateInvoiceFormValues, job: CreateInvoiceJobContext): BuildResult<CreateInvoiceFromJobInput> {
  if (job.status === "cancelled") return { error: "A cancelled job cannot receive a new invoice." };

  const amountRaw = values.amountRaw.trim();
  if (!amountRaw) {
    return { error: job.amount == null ? "This job has no contracted amount yet. Enter the invoice total." : "Enter the invoice total." };
  }
  const parsed = parseAmountInput(amountRaw);
  if (parsed.error !== undefined) return { error: parsed.error };

  const dueDate = values.dueDate.trim();
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { error: "Enter a valid due date." };

  return {
    input: {
      jobId: job.id,
      amount: parsed.amount,
      title: values.title.trim() || null,
      dueDate: dueDate || null,
      notes: values.notes.trim() || null,
      // Only meaningful when the job has no amount; the service re-checks.
      alsoSetJobAmount: job.amount == null && values.alsoSetJobAmount,
    },
  };
}

export type RecordPaymentFormValues = {
  amountRaw: string;
  method: string;
  reference: string;
  /** Value of an <input type="datetime-local">, e.g. 2026-10-02T14:30. */
  receivedAtLocal: string;
  notes: string;
};

export function defaultRecordPaymentForm(invoice: Pick<InvoiceMoney, "total" | "amountPaid">, now: Date = new Date()): RecordPaymentFormValues {
  const balance = Math.round((invoice.total - invoice.amountPaid) * 100) / 100;
  return { amountRaw: balance > 0 ? String(balance) : "", method: "", reference: "", receivedAtLocal: toDateTimeLocalValue(now), notes: "" };
}

/** YYYY-MM-DDTHH:MM in the browser's local time, the format datetime-local expects. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parses a datetime-local value as local time and returns an ISO instant, or null when invalid. */
export function dateTimeLocalToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const METHOD_VALUES = new Set<string>(PAYMENT_METHODS.map((method) => method.value));

export function buildRecordPaymentInput(values: RecordPaymentFormValues, invoice: InvoiceMoney & { id: string }, now: Date = new Date()): BuildResult<RecordCustomerPaymentInput> {
  if (!METHOD_VALUES.has(values.method)) return { error: "Choose how this payment was received." };

  const parsed = parseAmountInput(values.amountRaw);
  if (parsed.error !== undefined) return { error: parsed.error };

  // The same check the service and the trigger make - answered here so an
  // obvious overpayment never leaves the dialog. Not relied upon.
  const preview = applyPayment(invoice, parsed.amount);
  if (!preview.ok) return { error: preview.error };

  const receivedAt = values.receivedAtLocal.trim() ? dateTimeLocalToIso(values.receivedAtLocal) : now.toISOString();
  if (!receivedAt) return { error: "Enter a valid received date." };
  if (new Date(receivedAt).getTime() > now.getTime() + 5 * 60 * 1000) return { error: "The received date can't be in the future." };

  return {
    input: {
      invoiceId: invoice.id,
      amount: parsed.amount,
      method: values.method as PaymentMethod,
      reference: values.reference.trim() || null,
      receivedAt,
      notes: values.notes.trim() || null,
    },
  };
}

/** What the confirmation dialog states before a reversal is submitted. */
export function describeReversal(payment: { amount: number; method: string; received_at: string }): { reversalAmount: number; methodLabel: string } {
  const methodLabel = PAYMENT_METHODS.find((method) => method.value === payment.method)?.label ?? payment.method;
  return { reversalAmount: isTwoDecimalAmount(payment.amount) ? -payment.amount : Number.NaN, methodLabel };
}
