import type { SupabaseClient } from "@supabase/supabase-js";
import { getJob } from "@/lib/jobs/queries";
import {
  applyPayment,
  canIssue,
  formatInvoiceNumber,
  isTwoDecimalAmount,
  isValidClientKey,
  labelStatus,
  parseAmountInput,
  PAYMENT_METHODS,
  reversePayment,
  transitionInvoice,
  type PaymentMethod,
} from "./domain";
import { getCustomerPayment, getCustomerPaymentByClientKey, getInvoice, getInvoicePayments, getLiveInvoiceForJob, type CustomerPayment, type Invoice } from "./queries";

/**
 * Phase 1B-2 (Close the Money Loop): the testable core behind
 * app/(app)/invoices/actions.ts. Every function takes an already-resolved
 * session client + organizationId (+ userId where a record is attributed),
 * exactly the shape requireOrganization() produces in the Server Action
 * wrappers - the same split app/(app)/jobs/actions.ts uses for
 * createLeadFromReferralForOrganization, so behavior is identical whether
 * called from a request or from a node test with a fake client.
 *
 * Authority: the database. Numbering, draft shape, frozen totals,
 * amount_paid, paid_at, balance_due, status moves, overpayment, append-only
 * payments and reversal rules are all enforced by the triggers and
 * constraints in 20260928162500_invoice_foundation.sql. This module
 * (1) scopes every read and write to the caller's organization,
 * (2) pre-checks with lib/invoices/domain.ts so a user gets a clear message
 *     without a round trip when the outcome is already knowable, and
 * (3) maps the database's own rejections into the same plain language
 *     rather than swallowing them. It never recomputes money.
 */

export type InvoiceServiceResult<T> = { ok: true; data: T; error?: undefined } | { ok: false; error: string; data?: undefined };

type DatabaseError = { code?: string; message?: string; details?: string | null };

/**
 * Turns a Postgrest/Postgres error into something a contractor can act on.
 * Trigger RAISEs (P0001) already carry plain-English text written for this
 * purpose, so they pass through; the two unique violations and the RLS case
 * get their own wording; anything else is logged and generalized.
 */
export function describeDatabaseError(error: DatabaseError | null | undefined, fallback: string): string {
  if (!error) return fallback;
  const message = error.message ?? "";
  if (error.code === "23505") {
    if (message.includes("invoices_one_live_per_job")) return "This job already has a live invoice. Void it first to issue a new one.";
    if (message.includes("invoices_org_number_unique")) return "Two invoices were created at the same moment. Please try again.";
    if (message.includes("customer_payments_reversal_unique")) return "This payment has already been reversed.";
    if (message.includes("customer_payments_org_client_key_unique")) return "This payment was already recorded. Refresh to see it.";
  }
  if (error.code === "23503") return "This record is linked to another that no longer exists.";
  if (error.code === "42501" || /row-level security/i.test(message)) return "You don't have access to that record.";
  if (error.code === "P0001" && message) return message;
  console.error("[invoices] database error", { code: error.code, message, details: error.details ?? null });
  return fallback;
}

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

async function recordAudit(
  supabase: SupabaseClient,
  organizationId: string,
  action: "invoice_created" | "invoice_issued" | "invoice_voided" | "payment_recorded" | "payment_reversed",
  entityType: "invoice" | "customer_payment",
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.rpc("create_invoice_audit_event", {
    p_organization_id: organizationId,
    p_action: action,
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_metadata: metadata,
  });
  if (error) {
    // The state change already committed and is the source of truth; a
    // missing Activity entry is logged, never surfaced as a failure.
    console.error("[invoices] failed to record audit event", { organizationId, action, entityId, error: error.message });
  }
}

// ---------------------------------------------------------------------------
// Create draft from job
// ---------------------------------------------------------------------------

export type CreateInvoiceFromJobInput = {
  jobId: string;
  /** Required when the job has no contracted amount; otherwise overrides the prefill. */
  amount?: number | string | null;
  title?: string | null;
  /** YYYY-MM-DD. Optional; the database assigns issue date + 14 at issue time when absent. */
  dueDate?: string | null;
  notes?: string | null;
  /** When the job has no amount and one is supplied, also write it to jobs.amount (the Phase 1B audit's checkbox). Default false here; the UI decides. */
  alsoSetJobAmount?: boolean;
};

export type CreatedInvoice = { id: string; number: number; label: string; total: number; jobAmountUpdated: boolean };

export async function createInvoiceFromJobForOrganization(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
  input: CreateInvoiceFromJobInput,
): Promise<InvoiceServiceResult<CreatedInvoice>> {
  const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
  if (!jobId) return { ok: false, error: "Missing job." };

  // Org-scoped read: a job id from another organization resolves to null.
  const job = await getJob(supabase, organizationId, jobId);
  if (!job) return { ok: false, error: "This job could not be found." };
  if (job.status === "cancelled") return { ok: false, error: "A cancelled job cannot receive a new invoice." };

  const existing = await getLiveInvoiceForJob(supabase, organizationId, jobId);
  if (existing) {
    return { ok: false, error: `This job already has invoice ${formatInvoiceNumber(existing.number)} (${labelStatus(existing.status)}). Void it first to issue a new one.` };
  }

  // Amount: an explicit value wins; otherwise the job's contracted amount
  // prefills; a job with neither needs the user to type one.
  let total: number;
  const explicit = input.amount;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    const parsed = parseAmountInput(explicit);
    if (parsed.error !== undefined) return { ok: false, error: parsed.error };
    total = parsed.amount;
  } else if (job.amount != null) {
    if (!isTwoDecimalAmount(job.amount) || job.amount < 0) {
      return { ok: false, error: "This job's contracted amount isn't a valid dollars-and-cents figure. Enter the invoice total." };
    }
    total = job.amount;
  } else {
    return { ok: false, error: "This job has no contracted amount yet. Enter the invoice total." };
  }

  const title = (input.title ?? "").trim() || job.title;
  const dueDate = (input.dueDate ?? "").trim() || null;
  if (dueDate && !isCalendarDate(dueDate)) return { ok: false, error: "Enter a valid due date." };
  const notes = (input.notes ?? "").trim() || null;

  const { data, error } = await supabase
    .from("invoices")
    .insert({
      organization_id: organizationId,
      job_id: jobId,
      title,
      subtotal: total,
      tax_amount: 0,
      total,
      due_date: dueDate,
      notes,
      created_by: userId,
      // status, number, amount_paid, contact_id and estimate_id are set by
      // invoices_guard_insert from the job row - never from here.
    })
    .select("id, number, total")
    .single();

  if (error || !data) {
    return { ok: false, error: describeDatabaseError(error, "We couldn't create this invoice. Please try again.") };
  }

  // The one deliberate side effect on the job, opt-in and only when the job
  // had no amount: creating an invoice must never overwrite a real figure.
  let jobAmountUpdated = false;
  if (input.alsoSetJobAmount && job.amount == null) {
    const { data: updatedJob, error: jobError } = await supabase
      .from("jobs")
      .update({ amount: total })
      .eq("id", jobId)
      .eq("organization_id", organizationId)
      .is("amount", null)
      .select("id")
      .maybeSingle();
    if (jobError) {
      console.error("[invoices] invoice created but job amount write-back failed", { jobId, error: jobError.message });
    }
    jobAmountUpdated = Boolean(updatedJob);
  }

  await recordAudit(supabase, organizationId, "invoice_created", "invoice", data.id, { number: data.number, total: data.total, job_id: jobId, job_amount_updated: jobAmountUpdated });

  return { ok: true, data: { id: data.id, number: data.number, label: formatInvoiceNumber(data.number), total: Number(data.total), jobAmountUpdated } };
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export type IssuedInvoice = { id: string; status: "sent"; issuedAt: string; dueDate: string };

export async function issueInvoiceForOrganization(
  supabase: SupabaseClient,
  organizationId: string,
  invoiceId: string,
  options: { dueDate?: string | null } = {},
): Promise<InvoiceServiceResult<IssuedInvoice>> {
  const invoice = await getInvoice(supabase, organizationId, invoiceId);
  if (!invoice) return { ok: false, error: "This invoice could not be found." };
  if (!canIssue(invoice)) return { ok: false, error: `Only a draft can be issued. This invoice is ${labelStatus(invoice.status)}.` };
  if (invoice.total <= 0) return { ok: false, error: "Set a total greater than zero before issuing this invoice." };

  const dueDate = (options.dueDate ?? "").trim() || null;
  if (dueDate && !isCalendarDate(dueDate)) return { ok: false, error: "Enter a valid due date." };

  // The trigger stamps issued_at, sent_at and (when absent) due_date =
  // issue date + 14 in the organization's timezone. The status filter makes
  // this a compare-and-swap: a concurrent issue or void loses cleanly.
  const patch: Record<string, unknown> = { status: "sent" };
  if (dueDate) patch.due_date = dueDate;

  const { data, error } = await supabase
    .from("invoices")
    .update(patch)
    .eq("id", invoiceId)
    .eq("organization_id", organizationId)
    .eq("status", "draft")
    .select("id, status, issued_at, due_date")
    .maybeSingle();

  if (error) return { ok: false, error: describeDatabaseError(error, "We couldn't issue this invoice. Please try again.") };
  if (!data) return { ok: false, error: "This invoice is no longer a draft." };

  await recordAudit(supabase, organizationId, "invoice_issued", "invoice", invoiceId, { number: invoice.number, total: invoice.total, due_date: data.due_date });

  return { ok: true, data: { id: data.id, status: "sent", issuedAt: data.issued_at, dueDate: data.due_date } };
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

export async function voidInvoiceForOrganization(
  supabase: SupabaseClient,
  organizationId: string,
  invoiceId: string,
  reason?: string | null,
): Promise<InvoiceServiceResult<{ id: string; status: "void" }>> {
  const invoice = await getInvoice(supabase, organizationId, invoiceId);
  if (!invoice) return { ok: false, error: "This invoice could not be found." };

  const transition = transitionInvoice({ status: invoice.status, amountPaid: invoice.amount_paid }, "void");
  if (!transition.ok) return { ok: false, error: transition.error };

  const voidReason = (reason ?? "").trim() || null;

  // Never a delete. The trigger re-checks amount_paid = 0 and stamps
  // voided_at; the status filter keeps this a compare-and-swap.
  const { data, error } = await supabase
    .from("invoices")
    .update({ status: "void", void_reason: voidReason })
    .eq("id", invoiceId)
    .eq("organization_id", organizationId)
    .in("status", ["draft", "sent"])
    .select("id, status")
    .maybeSingle();

  if (error) return { ok: false, error: describeDatabaseError(error, "We couldn't void this invoice. Please try again.") };
  if (!data) return { ok: false, error: "This invoice can no longer be voided." };

  await recordAudit(supabase, organizationId, "invoice_voided", "invoice", invoiceId, { number: invoice.number, total: invoice.total, previous_status: invoice.status, reason: voidReason });

  return { ok: true, data: { id: data.id, status: "void" } };
}

// ---------------------------------------------------------------------------
// Record payment
// ---------------------------------------------------------------------------

export type RecordCustomerPaymentInput = {
  invoiceId: string;
  amount: number | string;
  method: PaymentMethod | string;
  reference?: string | null;
  /** ISO timestamp; defaults to now in the database. */
  receivedAt?: string | null;
  notes?: string | null;
  /**
   * Phase 1B-5: the browser-minted submission key (lib/invoices/forms.ts).
   * When present, a second call carrying the same key for the same invoice
   * resolves to the payment the first call recorded instead of inserting a
   * second row - see recordCustomerPaymentForOrganization. Optional so an
   * older client without a key still records normally (with no replay
   * protection beyond the dialog's own submit lock).
   */
  clientKey?: string | null;
};

export type RecordedPayment = {
  paymentId: string;
  /** Read back from the database after the trigger applied the payment - never computed here. */
  invoice: Pick<Invoice, "id" | "status" | "amount_paid" | "balance_due" | "paid_at">;
  /** True when this call did not insert anything because the same client key had already recorded this payment. */
  replayed: boolean;
};

const METHOD_VALUES = new Set<string>(PAYMENT_METHODS.map((method) => method.value));

export async function recordCustomerPaymentForOrganization(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
  input: RecordCustomerPaymentInput,
): Promise<InvoiceServiceResult<RecordedPayment>> {
  const invoiceId = typeof input.invoiceId === "string" ? input.invoiceId.trim() : "";
  if (!invoiceId) return { ok: false, error: "Missing invoice." };

  const method = typeof input.method === "string" ? input.method.trim() : "";
  if (!METHOD_VALUES.has(method)) return { ok: false, error: "Choose how this payment was received." };

  const parsed = parseAmountInput(input.amount);
  if (parsed.error !== undefined) return { ok: false, error: parsed.error };

  const receivedAt = (input.receivedAt ?? "").trim() || null;
  if (receivedAt && !isIsoTimestamp(receivedAt)) return { ok: false, error: "Enter a valid received date." };

  const clientKey = typeof input.clientKey === "string" && input.clientKey.trim() ? input.clientKey.trim() : null;
  if (clientKey && !isValidClientKey(clientKey)) return { ok: false, error: "This payment form is out of date. Close it and try again." };

  const invoice = await getInvoice(supabase, organizationId, invoiceId);
  if (!invoice) return { ok: false, error: "This invoice could not be found." };

  // Idempotency, step 1: a key this organization has already used means the
  // first attempt (a double tap, a retried request) already recorded the
  // money - return that row instead of touching the ledger again. Checked
  // BEFORE the overpayment pre-check on purpose: after the first attempt
  // the invoice may already be paid, which would otherwise turn a harmless
  // replay into a misleading "would exceed the balance" error.
  if (clientKey) {
    const existing = await getCustomerPaymentByClientKey(supabase, organizationId, clientKey);
    if (existing) return replayRecordedPayment(supabase, organizationId, existing, invoiceId);
  }

  // Same rules the trigger enforces, answered without a round trip.
  const preview = applyPayment({ status: invoice.status, total: invoice.total, amountPaid: invoice.amount_paid, dueDate: invoice.due_date }, parsed.amount);
  if (!preview.ok) return { ok: false, error: preview.error };

  const { data, error } = await supabase
    .from("customer_payments")
    .insert({
      organization_id: organizationId,
      invoice_id: invoiceId,
      // job_id and contact_id are copied from the invoice by the trigger;
      // they are sent only because the columns are NOT NULL at parse time.
      job_id: invoice.job_id,
      contact_id: invoice.contact_id,
      amount: parsed.amount,
      method,
      reference: (input.reference ?? "").trim() || null,
      received_at: receivedAt ?? new Date().toISOString(),
      notes: (input.notes ?? "").trim() || null,
      recorded_by: userId,
      ...(clientKey ? { client_key: clientKey } : {}),
    })
    .select("id")
    .single();

  if (error || !data) {
    // Idempotency, step 2: two identical requests raced past the lookup
    // above; the partial unique index let exactly one through. Resolve to
    // that row - the database, not this process, decided the winner.
    if (clientKey && error?.code === "23505" && (error.message ?? "").includes("customer_payments_org_client_key_unique")) {
      const winner = await getCustomerPaymentByClientKey(supabase, organizationId, clientKey);
      if (winner) return replayRecordedPayment(supabase, organizationId, winner, invoiceId);
    }
    return { ok: false, error: describeDatabaseError(error, "We couldn't record this payment. Please try again.") };
  }

  const after = await getInvoice(supabase, organizationId, invoiceId);
  if (!after) return { ok: false, error: "The payment was recorded, but the invoice could not be re-read. Refresh to see the current balance." };

  await recordAudit(supabase, organizationId, "payment_recorded", "customer_payment", data.id, {
    invoice_id: invoiceId,
    number: invoice.number,
    amount: parsed.amount,
    method,
    reference: (input.reference ?? "").trim() || null,
    invoice_status_after: after.status,
    amount_paid_after: after.amount_paid,
  });

  return { ok: true, data: { paymentId: data.id, invoice: { id: after.id, status: after.status, amount_paid: after.amount_paid, balance_due: after.balance_due, paid_at: after.paid_at }, replayed: false } };
}

/**
 * The idempotent outcome: the payment a client key already produced, with
 * the invoice's current state read back. No insert, no audit entry (the
 * first attempt wrote it), no side effect of any kind. A key reused against
 * a DIFFERENT invoice is a client bug, not a replay, and is refused rather
 * than silently answered with someone else's payment.
 */
async function replayRecordedPayment(supabase: SupabaseClient, organizationId: string, existing: CustomerPayment, invoiceId: string): Promise<InvoiceServiceResult<RecordedPayment>> {
  if (existing.invoice_id !== invoiceId) return { ok: false, error: "This payment form was already used for a different invoice. Close it and try again." };
  const after = await getInvoice(supabase, organizationId, invoiceId);
  if (!after) return { ok: false, error: "This invoice could not be found." };
  return { ok: true, data: { paymentId: existing.id, invoice: { id: after.id, status: after.status, amount_paid: after.amount_paid, balance_due: after.balance_due, paid_at: after.paid_at }, replayed: true } };
}

// ---------------------------------------------------------------------------
// Reverse payment
// ---------------------------------------------------------------------------

export type ReversedPayment = {
  reversalId: string;
  original: Pick<CustomerPayment, "id" | "amount" | "method">;
  invoice: Pick<Invoice, "id" | "status" | "amount_paid" | "balance_due" | "paid_at">;
};

export async function reverseCustomerPaymentForOrganization(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
  input: { paymentId: string; notes?: string | null },
): Promise<InvoiceServiceResult<ReversedPayment>> {
  const paymentId = typeof input.paymentId === "string" ? input.paymentId.trim() : "";
  if (!paymentId) return { ok: false, error: "Missing payment." };

  const original = await getCustomerPayment(supabase, organizationId, paymentId);
  if (!original) return { ok: false, error: "This payment could not be found." };

  const invoice = await getInvoice(supabase, organizationId, original.invoice_id);
  if (!invoice) return { ok: false, error: "This payment's invoice could not be found." };

  const ledger = await getInvoicePayments(supabase, organizationId, invoice.id);
  const preview = reversePayment(
    { status: invoice.status, total: invoice.total, amountPaid: invoice.amount_paid, dueDate: invoice.due_date },
    ledger.map((payment) => ({ id: payment.id, amount: payment.amount, reversesPaymentId: payment.reverses_payment_id })),
    paymentId,
  );
  if (!preview.ok) return { ok: false, error: preview.error };

  // A reversal is a NEW row. The original is never updated or deleted -
  // there is no code path in this module (or any policy) that could.
  const { data, error } = await supabase
    .from("customer_payments")
    .insert({
      organization_id: organizationId,
      invoice_id: invoice.id,
      job_id: invoice.job_id,
      contact_id: invoice.contact_id,
      amount: preview.reversal.amount,
      method: original.method,
      reference: original.reference,
      received_at: new Date().toISOString(),
      reverses_payment_id: paymentId,
      notes: (input.notes ?? "").trim() || null,
      recorded_by: userId,
    })
    .select("id")
    .single();

  if (error || !data) return { ok: false, error: describeDatabaseError(error, "We couldn't reverse this payment. Please try again.") };

  const after = await getInvoice(supabase, organizationId, invoice.id);
  if (!after) return { ok: false, error: "The reversal was recorded, but the invoice could not be re-read. Refresh to see the current balance." };

  await recordAudit(supabase, organizationId, "payment_reversed", "customer_payment", data.id, {
    invoice_id: invoice.id,
    number: invoice.number,
    reverses_payment_id: paymentId,
    amount: preview.reversal.amount,
    invoice_status_after: after.status,
    amount_paid_after: after.amount_paid,
  });

  return {
    ok: true,
    data: {
      reversalId: data.id,
      original: { id: original.id, amount: original.amount, method: original.method },
      invoice: { id: after.id, status: after.status, amount_paid: after.amount_paid, balance_due: after.balance_due, paid_at: after.paid_at },
    },
  };
}
