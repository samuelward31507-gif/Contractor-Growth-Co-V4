"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import {
  createInvoiceFromJobForOrganization,
  issueInvoiceForOrganization,
  recordCustomerPaymentForOrganization,
  reverseCustomerPaymentForOrganization,
  voidInvoiceForOrganization,
  type CreateInvoiceFromJobInput,
  type CreatedInvoice,
  type InvoiceServiceResult,
  type IssuedInvoice,
  type RecordCustomerPaymentInput,
  type RecordedPayment,
  type ReversedPayment,
} from "@/lib/invoices/service";
import { deliverInvoiceToCustomer, type InvoiceDeliveryResult } from "@/lib/invoices/delivery";
import { resolveAppBaseUrl } from "@/lib/automation/sms";
import { canSimulateSmsDelivery } from "@/lib/messaging/simulated-delivery";

/**
 * Phase 1B-2 (Close the Money Loop): the Server Action surface for invoices
 * and customer payments. Each action resolves the organization from the
 * caller's own session (never from input), then delegates to the matching
 * *ForOrganization function in lib/invoices/service.ts, which is where the
 * behavior and its tests live. Mirrors app/(app)/jobs/actions.ts's shape;
 * the session client means RLS (is_org_member + the payment-active
 * restrictive policy) re-verifies every read and write at the database.
 *
 * Deliberately absent: n8n dispatch and Stripe calls. Phase 1B-5 adds
 * internal lifecycle markers only (invoice.issued/.paid/.voided,
 * payment.recorded on automation_events - see lib/automation/invoices.ts);
 * issuing an invoice still sends nothing. Phase 3G-2a: the one outbound
 * message is sendInvoiceToCustomer below - an explicit contractor action.
 */

async function requireOrganization() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  return { supabase, organizationId: membership.organizationId, userId: user.id, paymentStatus: membership.paymentStatus, organizationName: membership.organizationName };
}

function revalidateInvoiceSurfaces(invoiceId: string | null, jobId: string | null) {
  revalidatePath("/money");
  revalidatePath("/jobs");
  revalidatePath("/today");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  if (invoiceId) revalidatePath(`/invoices/${invoiceId}`);
}

export async function createInvoiceFromJob(input: CreateInvoiceFromJobInput): Promise<InvoiceServiceResult<CreatedInvoice>> {
  const { supabase, organizationId, userId } = await requireOrganization();
  const result = await createInvoiceFromJobForOrganization(supabase, organizationId, userId, input);
  if (result.ok) revalidateInvoiceSurfaces(result.data.id, input.jobId);
  return result;
}

export async function issueInvoice(invoiceId: string, options: { dueDate?: string | null } = {}): Promise<InvoiceServiceResult<IssuedInvoice>> {
  const { supabase, organizationId } = await requireOrganization();
  const result = await issueInvoiceForOrganization(supabase, organizationId, invoiceId, options);
  if (result.ok) revalidateInvoiceSurfaces(invoiceId, null);
  return result;
}

export async function voidInvoice(invoiceId: string, reason?: string | null): Promise<InvoiceServiceResult<{ id: string; status: "void" }>> {
  const { supabase, organizationId } = await requireOrganization();
  const result = await voidInvoiceForOrganization(supabase, organizationId, invoiceId, reason);
  if (result.ok) revalidateInvoiceSurfaces(invoiceId, null);
  return result;
}

export async function recordCustomerPayment(input: RecordCustomerPaymentInput): Promise<InvoiceServiceResult<RecordedPayment>> {
  const { supabase, organizationId, userId } = await requireOrganization();
  const result = await recordCustomerPaymentForOrganization(supabase, organizationId, userId, input);
  if (result.ok) revalidateInvoiceSurfaces(input.invoiceId, null);
  return result;
}

export async function reverseCustomerPayment(paymentId: string, notes?: string | null): Promise<InvoiceServiceResult<ReversedPayment>> {
  const { supabase, organizationId, userId } = await requireOrganization();
  const result = await reverseCustomerPaymentForOrganization(supabase, organizationId, userId, { paymentId, notes });
  if (result.ok) revalidateInvoiceSurfaces(result.data.invoice.id, null);
  return result;
}

/**
 * Phase 3G-2a: "Send to customer" / "Send again" - one SMS with the payment
 * link to the invoice's own customer. The session client means RLS and the
 * payment gate apply; lib/invoices/delivery.ts re-checks everything right
 * before sending and records invoice.delivered only on success.
 */
export async function sendInvoiceToCustomer(invoiceId: string): Promise<InvoiceDeliveryResult> {
  const { supabase, organizationId, paymentStatus, organizationName } = await requireOrganization();
  const result = await deliverInvoiceToCustomer(supabase, organizationId, invoiceId, { paymentStatus, baseUrl: resolveAppBaseUrl(), businessName: organizationName });
  if (result.ok) revalidateInvoiceSurfaces(invoiceId, null);
  return result;
}

/**
 * Test environments only: the same "Send to customer" checks and message,
 * recorded on the customer's thread as SIMULATED - no SMS is sent, no phone
 * is contacted and nothing counts as delivered (lib/messaging/
 * simulated-delivery.ts). Refused unless canSimulateSmsDelivery()
 * (non-production deployment with no SMS provider configured); the outbound
 * path re-checks the same rule. A separate, explicit action - the normal send
 * never falls back to it.
 */
export async function simulateInvoiceSendToCustomer(invoiceId: string): Promise<InvoiceDeliveryResult> {
  if (!canSimulateSmsDelivery()) return { ok: false, error: "Simulated sending is only available in a test environment without SMS configured." };
  const { supabase, organizationId, paymentStatus, organizationName } = await requireOrganization();
  const result = await deliverInvoiceToCustomer(supabase, organizationId, invoiceId, { paymentStatus, baseUrl: resolveAppBaseUrl(), businessName: organizationName, simulate: true });
  if (result.ok) revalidateInvoiceSurfaces(invoiceId, null);
  return result;
}
