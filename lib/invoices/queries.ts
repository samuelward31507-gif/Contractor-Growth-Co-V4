import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "@/lib/contacts/queries";
import type { EstimateStatus } from "@/lib/estimates/queries";
import type { JobStatus } from "@/lib/jobs/queries";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { calendarDateInTimeZone, deriveInvoiceState, type DerivedInvoiceState, type InvoiceStatus, type PaymentMethod } from "./domain";

/**
 * Phase 1B-2 (Close the Money Loop): typed reads over public.invoices and
 * public.customer_payments, following lib/estimates/queries.ts and
 * lib/jobs/queries.ts exactly - org-scoped at the query level (RLS is the
 * backstop, the explicit filter keeps intent obvious), capped list reads,
 * embedded relationships normalized from Supabase's one-or-array shape,
 * `failed` distinguishing a real Postgrest error from a genuine empty set.
 *
 * The database owns every financial fact here: amount_paid is maintained by
 * the customer_payments_apply trigger, balance_due is a generated column,
 * status moves only through the guarded transitions. Nothing in this module
 * recomputes money; deriveInvoiceState only adds the read-time view
 * (overdue) that the schema deliberately does not store.
 */

export type InvoiceContact = Pick<Contact, "id" | "first_name" | "last_name" | "company_name" | "phone" | "email">;

export type InvoiceJob = { id: string; title: string; status: JobStatus; amount: number | null };

export type InvoiceEstimate = { id: string; title: string; status: EstimateStatus; amount: number | null };

export type Invoice = {
  id: string;
  organization_id: string;
  job_id: string;
  contact_id: string | null;
  estimate_id: string | null;
  number: number;
  status: InvoiceStatus;
  title: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  amount_paid: number;
  balance_due: number;
  issued_at: string | null;
  sent_at: string | null;
  due_date: string | null;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  /** Internal only - never rendered on any customer-facing surface. */
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  job: InvoiceJob | null;
  contact: InvoiceContact | null;
  estimate: InvoiceEstimate | null;
};

export type CustomerPayment = {
  id: string;
  organization_id: string;
  invoice_id: string;
  job_id: string;
  contact_id: string | null;
  amount: number;
  method: PaymentMethod;
  reference: string | null;
  received_at: string;
  reverses_payment_id: string | null;
  recorded_by: string | null;
  notes: string | null;
  created_at: string;
};

// A single string literal - Supabase's type-level select parser needs the
// literal type to infer typed columns (same note as ESTIMATE_COLUMNS).
const INVOICE_COLUMNS =
  "id, organization_id, job_id, contact_id, estimate_id, number, status, title, subtotal, tax_amount, total, amount_paid, balance_due, issued_at, sent_at, due_date, paid_at, voided_at, void_reason, notes, created_by, created_at, updated_at, job:jobs(id, title, status, amount), contact:contacts(id, first_name, last_name, company_name, phone, email), estimate:estimates(id, title, status, amount)";

const PAYMENT_COLUMNS =
  "id, organization_id, invoice_id, job_id, contact_id, amount, method, reference, received_at, reverses_payment_id, recorded_by, notes, created_at";

type Embedded<T> = T | T[] | null;

function one<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

type RawInvoiceRow = Omit<Invoice, "job" | "contact" | "estimate"> & {
  job: Embedded<InvoiceJob>;
  contact: Embedded<InvoiceContact>;
  estimate: Embedded<InvoiceEstimate>;
};

function normalizeInvoice(row: RawInvoiceRow): Invoice {
  return { ...row, job: one(row.job), contact: one(row.contact), estimate: one(row.estimate) };
}

export type InvoicesResult = { data: Invoice[]; failed: boolean };

/** Every invoice for the org (capped, newest first). `failed` is true only on a real Postgrest error, never on a genuine empty org. */
export async function getInvoicesResult(supabase: SupabaseClient, organizationId: string): Promise<InvoicesResult> {
  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1000);

  return { data: ((data ?? []) as RawInvoiceRow[]).map(normalizeInvoice), failed: error != null };
}

export async function getInvoices(supabase: SupabaseClient, organizationId: string): Promise<Invoice[]> {
  return (await getInvoicesResult(supabase, organizationId)).data;
}

/** One invoice scoped to the org. Any error (invalid id, not found, wrong org) resolves to null - getEstimate's exact contract. */
export async function getInvoice(supabase: SupabaseClient, organizationId: string, id: string): Promise<Invoice | null> {
  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_COLUMNS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return normalizeInvoice(data as RawInvoiceRow);
}

/**
 * The job's one live (non-void) invoice, if any - the same row
 * invoices_one_live_per_job guarantees is unique, read through the org
 * scope so a job id from another organization resolves to null.
 */
export async function getLiveInvoiceForJob(supabase: SupabaseClient, organizationId: string, jobId: string): Promise<Invoice | null> {
  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("job_id", jobId)
    .neq("status", "void")
    .maybeSingle();

  if (error || !data) return null;
  return normalizeInvoice(data as RawInvoiceRow);
}

/** Contact-scoped invoices for surfaces that only need one person's own (mirrors getContactEstimates). */
export async function getContactInvoices(supabase: SupabaseClient, organizationId: string, contactId: string): Promise<Invoice[]> {
  const { data } = await supabase
    .from("invoices")
    .select(INVOICE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(50);

  return ((data ?? []) as RawInvoiceRow[]).map(normalizeInvoice);
}

/** The full append-only ledger for one invoice, oldest first, reversals included. */
export async function getInvoicePayments(supabase: SupabaseClient, organizationId: string, invoiceId: string): Promise<CustomerPayment[]> {
  const { data } = await supabase
    .from("customer_payments")
    .select(PAYMENT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("invoice_id", invoiceId)
    .order("received_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(500);

  return (data ?? []) as CustomerPayment[];
}

export type CustomerPaymentsResult = { data: CustomerPayment[]; failed: boolean };

/** Every payment row for the org (capped) - the "collected" ledger for Money. `failed` distinguishes a read error from a genuinely empty ledger. */
export async function getCustomerPaymentsResult(supabase: SupabaseClient, organizationId: string): Promise<CustomerPaymentsResult> {
  const { data, error } = await supabase
    .from("customer_payments")
    .select(PAYMENT_COLUMNS)
    .eq("organization_id", organizationId)
    .order("received_at", { ascending: false })
    .limit(5000);

  return { data: (data ?? []) as CustomerPayment[], failed: error != null };
}

/**
 * Phase 1B-5: the payment a client key already produced, if any - the
 * idempotency lookup recordCustomerPaymentForOrganization makes before
 * inserting and again after a 23505 on customer_payments_org_client_key_unique.
 * Scoped to the organization exactly like the index is, so a key from
 * another organization can never resolve here.
 */
export async function getCustomerPaymentByClientKey(supabase: SupabaseClient, organizationId: string, clientKey: string): Promise<CustomerPayment | null> {
  const { data, error } = await supabase
    .from("customer_payments")
    .select(PAYMENT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("client_key", clientKey)
    .maybeSingle();

  if (error || !data) return null;
  return data as CustomerPayment;
}

/** One payment scoped to the org; null on any error or miss. */
export async function getCustomerPayment(supabase: SupabaseClient, organizationId: string, paymentId: string): Promise<CustomerPayment | null> {
  const { data, error } = await supabase
    .from("customer_payments")
    .select(PAYMENT_COLUMNS)
    .eq("id", paymentId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return data as CustomerPayment;
}

export type InvoiceWithContext = {
  invoice: Invoice;
  payments: CustomerPayment[];
  /** The database's own status/balance plus the read-time overdue view. */
  state: DerivedInvoiceState;
  /** Today's calendar date in the organization's timezone - what "overdue" was judged against. */
  today: string;
};

/**
 * Invoice + ledger + derived state in one read. The organization's own
 * timezone decides what "today" is, the same calendar the issue trigger
 * used to set the default due date.
 */
export async function getInvoiceWithContext(
  supabase: SupabaseClient,
  organizationId: string,
  invoiceId: string,
  now: Date = new Date(),
): Promise<InvoiceWithContext | null> {
  const invoice = await getInvoice(supabase, organizationId, invoiceId);
  if (!invoice) return null;

  const [payments, timeZone] = await Promise.all([
    getInvoicePayments(supabase, organizationId, invoiceId),
    getOrganizationTimezone(supabase, organizationId),
  ]);
  const today = calendarDateInTimeZone(now, timeZone ?? "UTC");

  return {
    invoice,
    payments,
    state: deriveInvoiceState({ status: invoice.status, total: invoice.total, amountPaid: invoice.amount_paid, dueDate: invoice.due_date }, today),
    today,
  };
}
