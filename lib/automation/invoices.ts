import type { SupabaseClient } from "@supabase/supabase-js";
import { createAutomationEvent, createAutomationEventAsService } from "./events";
import { startWorkflowExecution, completeWorkflowExecution, startWorkflowExecutionAsService, completeWorkflowExecutionAsService } from "./executions";

/**
 * Phase 1B-5 (Close the Money Loop - Lifecycle Signals): internal lifecycle
 * markers for the invoice/payment ledger, recorded on automation_events the
 * exact same way lead.stage_changed, job.completed and estimate.accepted
 * already are - created, started, immediately completed with
 * lifecycle_only: true, so the row lands in a real terminal status and the
 * Activity/automation surfaces can read it.
 *
 * What these are NOT: no catalog automation claims any of these event
 * types (lib/automation/catalog.ts), so createAutomationEvent never gates
 * them on an enable toggle or automation_paused - an audit trail is always
 * recorded - and nothing here dispatches to n8n, drafts a message, sends
 * SMS or email, or touches Stripe. Contractor-initiated transitions come
 * from a Server Action with a real user session (app/(app)/invoices/
 * actions.ts via lib/invoices/service.ts) and use the plain helpers;
 * Phase 1C's online card payments are recorded by the Stripe Connect webhook
 * with no user session, so they use emitInvoiceLifecycleEventAsService below
 * - same events, same idempotency keys, same payloads.
 *
 * Idempotency keys are derived from the business fact, never from time:
 *   invoice.issued   invoice.issued:<invoice_id>
 *   invoice.voided   invoice.voided:<invoice_id>
 *   invoice.paid     invoice.paid:<invoice_id>:<completing payment id>
 *                    (an invoice reopened by a reversal and paid again is a
 *                    genuinely new fact, keyed by the payment that closed it)
 *   payment.recorded payment.recorded:<payment_id>
 *
 * Payloads carry ids, amounts, statuses and dates only - never notes,
 * references or anything written for internal eyes. Never throws: the
 * ledger write already committed and is the source of truth; a failure to
 * record the marker is logged, never surfaced as a failure to the user.
 */

export type InvoiceLifecycleEventType = "invoice.issued" | "invoice.paid" | "invoice.voided" | "payment.recorded";

export const INVOICE_LIFECYCLE_EVENT_TYPES: readonly InvoiceLifecycleEventType[] = ["invoice.issued", "invoice.paid", "invoice.voided", "payment.recorded"];

export type InvoiceLifecycleEventInput =
  | { eventType: "invoice.issued"; invoiceId: string; payload: { invoice_id: string; number: number; job_id: string; contact_id: string | null; total: number; issued_at: string | null; due_date: string | null } }
  | { eventType: "invoice.voided"; invoiceId: string; payload: { invoice_id: string; number: number; job_id: string; contact_id: string | null; total: number; previous_status: string } }
  | { eventType: "invoice.paid"; invoiceId: string; completingPaymentId: string; payload: { invoice_id: string; number: number; job_id: string; contact_id: string | null; total: number; amount_paid: number; paid_at: string | null; completing_payment_id: string } }
  | { eventType: "payment.recorded"; paymentId: string; payload: { payment_id: string; invoice_id: string; number: number; job_id: string; contact_id: string | null; amount: number; method: string; received_at: string; invoice_status_after: string; amount_paid_after: number } };

export function invoiceLifecycleIdempotencyKey(input: InvoiceLifecycleEventInput): string {
  switch (input.eventType) {
    case "invoice.issued":
    case "invoice.voided":
      return `${input.eventType}:${input.invoiceId}`;
    case "invoice.paid":
      return `invoice.paid:${input.invoiceId}:${input.completingPaymentId}`;
    case "payment.recorded":
      return `payment.recorded:${input.paymentId}`;
  }
}

function entityOf(input: InvoiceLifecycleEventInput): { entityType: "invoice" | "customer_payment"; entityId: string } {
  return input.eventType === "payment.recorded" ? { entityType: "customer_payment", entityId: input.paymentId } : { entityType: "invoice", entityId: input.invoiceId };
}

export type EmitInvoiceLifecycleEvent = (supabase: SupabaseClient, input: InvoiceLifecycleEventInput) => Promise<void>;

export const emitInvoiceLifecycleEvent: EmitInvoiceLifecycleEvent = async (supabase, input) => {
  const { entityType, entityId } = entityOf(input);
  const idempotencyKey = invoiceLifecycleIdempotencyKey(input);

  try {
    const eventResult = await createAutomationEvent(supabase, {
      eventType: input.eventType,
      entityType,
      entityId,
      payload: input.payload,
      idempotencyKey,
    });

    if (!eventResult.ok) {
      console.error(`[automation] failed to create ${input.eventType} event`, { entityId, error: eventResult.error });
      return;
    }
    if (eventResult.duplicate) return;
    if (eventResult.skipped) return;

    const executionResult = await startWorkflowExecution(supabase, eventResult.event.id, `${input.eventType.replace(".", "_")}_lifecycle`);
    if (!executionResult.ok) {
      console.error(`[automation] failed to start ${input.eventType} execution`, { entityId, error: executionResult.error });
      return;
    }

    const completed = await completeWorkflowExecution(supabase, executionResult.execution.id, { lifecycle_only: true, [entityType === "invoice" ? "invoice_id" : "payment_id"]: entityId });
    if (!completed.ok) {
      console.error(`[automation] failed to complete ${input.eventType} execution`, { entityId, error: completed.error });
    }
  } catch (error) {
    console.error(`[automation] ${input.eventType} lifecycle marker threw`, { entityId, error: error instanceof Error ? error.message : String(error) });
  }
};

/**
 * Phase 1C: the service-role twin of emitInvoiceLifecycleEvent for the Stripe
 * Connect webhook (lib/payments/online-payment.ts), which has no Supabase Auth
 * session - the same shape as emitJobCreatedFromEstimateAsService. The event,
 * idempotency key and payload are exactly what the session path records, so
 * an online payment and a manually recorded one read identically downstream.
 *
 * `organizationId` must already be trusted: the caller derives it from the
 * signed Stripe event's connected account and the invoice row it verified,
 * never from input. Never throws - the ledger row already committed.
 */
export async function emitInvoiceLifecycleEventAsService(supabase: SupabaseClient, organizationId: string, input: InvoiceLifecycleEventInput): Promise<void> {
  const { entityType, entityId } = entityOf(input);
  const idempotencyKey = invoiceLifecycleIdempotencyKey(input);

  try {
    const eventResult = await createAutomationEventAsService(supabase, organizationId, {
      eventType: input.eventType,
      entityType,
      entityId,
      payload: input.payload,
      idempotencyKey,
    });

    if (!eventResult.ok) {
      console.error(`[automation] failed to create ${input.eventType} event (service)`, { entityId, error: eventResult.error });
      return;
    }
    if (eventResult.duplicate) return;
    if (eventResult.skipped) return;

    const executionResult = await startWorkflowExecutionAsService(supabase, eventResult.event.id, `${input.eventType.replace(".", "_")}_lifecycle`);
    if (!executionResult.ok) {
      console.error(`[automation] failed to start ${input.eventType} execution (service)`, { entityId, error: executionResult.error });
      return;
    }

    const completed = await completeWorkflowExecutionAsService(supabase, executionResult.execution.id, { lifecycle_only: true, [entityType === "invoice" ? "invoice_id" : "payment_id"]: entityId });
    if (!completed.ok) {
      console.error(`[automation] failed to complete ${input.eventType} execution (service)`, { entityId, error: completed.error });
    }
  } catch (error) {
    console.error(`[automation] ${input.eventType} lifecycle marker threw (service)`, { entityId, error: error instanceof Error ? error.message : String(error) });
  }
}
