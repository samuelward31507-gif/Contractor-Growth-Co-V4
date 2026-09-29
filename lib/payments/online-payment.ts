import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAutomationHealthSignal } from "@/lib/automation-health/service";
import { emitInvoiceLifecycleEventAsService } from "@/lib/automation/invoices";
import { formatInvoiceNumber, formatMoney, fromCents } from "@/lib/invoices/domain";
import { CONNECT_ACCOUNT_ID_PATTERN, paymentsStripe, stripeErrorMessage, type PaymentsDeps } from "./connect";
import { INVOICE_PAYMENT_KIND } from "./invoice-checkout";

/**
 * Phase 1C: records a customer's successful online card payment - a
 * checkout.session.completed event from a contractor's connected account -
 * as one customer_payments row.
 *
 * THE ACCOUNTING BOUNDARY. Stripe has already taken the customer's money when
 * this runs. The ledger is changed ONLY by inserting one `card_online` row
 * through the existing path: customer_payments_guard_insert (locks the
 * invoice, rejects overpayment and non-issued invoices),
 * customer_payments_online_guard (service role only, connected account must
 * match), and customer_payments_apply (the only thing that moves amount_paid,
 * status and paid_at). Nothing here updates an invoice, computes its status,
 * or retries with different values to make an insert succeed.
 *
 * Verified before the insert, in order:
 *   1. it is Trackpr's own invoice-payment session (mode payment,
 *      metadata.trackpr_kind) and Stripe reports it paid - anything else is
 *      ignored, never recorded;
 *   2. the signed event's connected account belongs to an organization (the
 *      organization is resolved from THAT, never from metadata);
 *   3. the session's organization_id metadata names that organization;
 *   4. session, payment intent and account ids have the expected shape;
 *   5. the amount is a positive USD amount equal to the session's
 *      expected_amount_cents;
 *   6. the PaymentIntent, re-read from Stripe on the connected account,
 *      succeeded for exactly that amount and currency, with the same
 *      invoice_id and organization_id metadata;
 *   7. the invoice exists in that organization, is still payable, and the
 *      amount does not exceed its current balance.
 *
 * Idempotent: a session already recorded resolves to its existing row
 * (checked first, and again via the unique indexes if two deliveries race).
 * Only a real, database-committed insert emits lifecycle events.
 *
 * When Stripe succeeded but the ledger cannot be written - any check from 3
 * on fails, or the database rejects the insert - an
 * online_payment_reconciliation incident (critical, one per Checkout Session)
 * records everything needed to reconcile by hand. The outcome is never
 * reported as recorded. If even the incident cannot be written, the outcome
 * is `failed`, so the webhook answers non-2xx and Stripe retries.
 */

export type OnlinePaymentEvent = {
  eventId: string;
  /** The signed event's `account` - set by Stripe for connected-account events. */
  account: string | null | undefined;
  /** Stripe's event.created (seconds). Used as the payment's received_at. */
  created: number;
  session: Stripe.Checkout.Session;
};

export type ReconciliationReason =
  | "organization_mismatch"
  | "invalid_identifiers"
  | "amount_mismatch"
  | "payment_intent_mismatch"
  | "invoice_not_found"
  | "invoice_not_payable"
  | "exceeds_balance"
  | "database_rejected";

export type OnlinePaymentOutcome =
  | { kind: "ignored"; reason: "not_invoice_payment" | "not_paid" }
  | { kind: "recorded"; organizationId: string; invoiceId: string; paymentId: string; invoiceStatus: string }
  | { kind: "duplicate"; organizationId: string; invoiceId: string; paymentId: string }
  | { kind: "reconciliation_required"; organizationId: string; reason: ReconciliationReason; incidentId: string }
  | { kind: "failed"; reason: "unattributable" | "stripe_unavailable" | "incident_not_recorded"; detail: string };

export type OnlinePaymentHooks = {
  /** Test seam; defaults to the real service-role lifecycle emitter. */
  emitLifecycleEvent?: typeof emitInvoiceLifecycleEventAsService;
};

const SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{1,255}$/;
const PAYMENT_INTENT_ID_PATTERN = /^pi_[A-Za-z0-9]{1,255}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRIPE_UNIQUE_INDEXES = ["customer_payments_stripe_checkout_session_unique", "customer_payments_stripe_payment_intent_unique"];

type InvoiceRow = {
  id: string;
  organization_id: string;
  job_id: string;
  contact_id: string | null;
  number: number;
  status: string;
  total: number | string;
  amount_paid: number | string;
  balance_due: number | string;
  paid_at: string | null;
};

const INVOICE_COLUMNS = "id, organization_id, job_id, contact_id, number, status, total, amount_paid, balance_due, paid_at";

function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

async function readInvoice(service: SupabaseClient, organizationId: string, invoiceId: string): Promise<InvoiceRow | null> {
  const { data, error } = await service.from("invoices").select(INVOICE_COLUMNS).eq("id", invoiceId).eq("organization_id", organizationId).maybeSingle();
  if (error || !data) return null;
  return data as InvoiceRow;
}

async function findRecordedPayment(service: SupabaseClient, column: "stripe_checkout_session_id" | "stripe_payment_intent_id", value: string): Promise<{ id: string; organization_id: string; invoice_id: string } | null> {
  const { data, error } = await service.from("customer_payments").select("id, organization_id, invoice_id").eq(column, value).maybeSingle();
  if (error || !data) return null;
  return data as { id: string; organization_id: string; invoice_id: string };
}

export async function recordOnlineInvoicePayment(service: SupabaseClient, event: OnlinePaymentEvent, deps: PaymentsDeps & OnlinePaymentHooks = {}): Promise<OnlinePaymentOutcome> {
  const { session } = event;
  const metadata = session.metadata ?? {};

  // 1. Only Trackpr's own invoice-payment sessions, and only when paid.
  if (session.mode !== "payment" || metadata.trackpr_kind !== INVOICE_PAYMENT_KIND) return { kind: "ignored", reason: "not_invoice_payment" };
  if (session.payment_status !== "paid") return { kind: "ignored", reason: "not_paid" };

  // 2. The organization comes from the signed event's connected account.
  const account = typeof event.account === "string" ? event.account : "";
  if (!CONNECT_ACCOUNT_ID_PATTERN.test(account)) {
    console.error("[payments][online] paid invoice session without a connected account", { eventId: event.eventId, sessionId: session.id });
    return { kind: "failed", reason: "unattributable", detail: "missing_connected_account" };
  }
  const { data: orgRow, error: orgError } = await service.from("organizations").select("id").eq("stripe_connect_account_id", account).maybeSingle();
  if (orgError || !orgRow) {
    console.error("[payments][online] paid invoice session from an account no organization owns", { eventId: event.eventId, sessionId: session.id, account });
    return { kind: "failed", reason: "unattributable", detail: orgError ? "organization_lookup_failed" : "unknown_connected_account" };
  }
  const organizationId = (orgRow as { id: string }).id;

  const paymentIntentId = stripeId(session.payment_intent);
  const invoiceId = typeof metadata.invoice_id === "string" ? metadata.invoice_id : "";
  const amountCents = session.amount_total;
  const currency = (session.currency ?? "").toLowerCase();

  const context = {
    eventId: event.eventId,
    account,
    organizationId,
    sessionId: session.id,
    paymentIntentId,
    invoiceId: invoiceId || null,
    amountCents: typeof amountCents === "number" ? amountCents : null,
    currency: currency || null,
  };
  const reconcile = (reason: ReconciliationReason, detail: string, invoice?: InvoiceRow | null) => raiseReconciliationIncident(service, context, reason, detail, invoice ?? null);

  // 3. The metadata must name the organization that owns the account.
  if (metadata.organization_id !== organizationId) return reconcile("organization_mismatch", `session metadata organization_id ${String(metadata.organization_id ?? "(missing)")} does not own ${account}`);

  // 4. Identifier shapes - the same shapes the database CHECK enforces.
  if (!SESSION_ID_PATTERN.test(session.id ?? "") || !paymentIntentId || !PAYMENT_INTENT_ID_PATTERN.test(paymentIntentId) || !UUID_PATTERN.test(invoiceId)) {
    return reconcile("invalid_identifiers", "session, payment intent or invoice id is missing or malformed");
  }

  // 5. Amount: positive whole cents, USD, exactly what the session asked for.
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0 || currency !== "usd" || String(amountCents) !== metadata.expected_amount_cents) {
    return reconcile("amount_mismatch", `amount_total ${String(amountCents)} ${currency || "(no currency)"} vs expected ${String(metadata.expected_amount_cents ?? "(missing)")} usd`);
  }

  // Idempotency, step 1: this session was already recorded.
  const already = await findRecordedPayment(service, "stripe_checkout_session_id", session.id);
  if (already) return { kind: "duplicate", organizationId: already.organization_id, invoiceId: already.invoice_id, paymentId: already.id };

  // 6. The PaymentIntent itself, re-read from Stripe on the connected account.
  let intent: Stripe.PaymentIntent;
  try {
    intent = await paymentsStripe(deps).paymentIntents.retrieve(paymentIntentId, {}, { stripeAccount: account });
  } catch (error) {
    console.error("[payments][online] could not retrieve the payment intent - Stripe will retry", { ...context, error: stripeErrorMessage(error) });
    return { kind: "failed", reason: "stripe_unavailable", detail: stripeErrorMessage(error) };
  }
  if (
    intent.id !== paymentIntentId ||
    intent.status !== "succeeded" ||
    intent.amount_received !== amountCents ||
    (intent.currency ?? "").toLowerCase() !== "usd" ||
    intent.metadata?.invoice_id !== invoiceId ||
    intent.metadata?.organization_id !== organizationId
  ) {
    return reconcile("payment_intent_mismatch", `payment intent ${intent.id} status ${intent.status}, amount_received ${intent.amount_received} ${intent.currency}, metadata invoice ${String(intent.metadata?.invoice_id ?? "(missing)")}`);
  }

  // 7. The invoice, as the database holds it now.
  const invoice = await readInvoice(service, organizationId, invoiceId);
  if (!invoice) return reconcile("invoice_not_found", `invoice ${invoiceId} not found in organization ${organizationId}`);
  if (invoice.status !== "sent" && invoice.status !== "partially_paid") return reconcile("invoice_not_payable", `invoice is ${invoice.status}`, invoice);
  const balanceCents = Math.round(Number(invoice.balance_due) * 100);
  if (amountCents > balanceCents) return reconcile("exceeds_balance", `paid ${amountCents} cents but the balance due is ${balanceCents} cents`, invoice);

  const amount = fromCents(amountCents);
  const receivedAt = new Date(event.created * 1000).toISOString();
  const { data: inserted, error: insertError } = await service
    .from("customer_payments")
    .insert({
      organization_id: organizationId,
      invoice_id: invoice.id,
      // Copied from the invoice by the insert trigger; sent because NOT NULL.
      job_id: invoice.job_id,
      contact_id: invoice.contact_id,
      amount,
      method: "card_online",
      reference: null,
      received_at: receivedAt,
      notes: null,
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: paymentIntentId,
      stripe_account_id: account,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    // Idempotency, step 2: a concurrent delivery won the race; the unique
    // index decided. Resolve to the row that exists.
    if (insertError?.code === "23505" && STRIPE_UNIQUE_INDEXES.some((index) => (insertError.message ?? "").includes(index))) {
      const winner = (await findRecordedPayment(service, "stripe_checkout_session_id", session.id)) ?? (await findRecordedPayment(service, "stripe_payment_intent_id", paymentIntentId));
      if (winner) return { kind: "duplicate", organizationId: winner.organization_id, invoiceId: winner.invoice_id, paymentId: winner.id };
    }
    return reconcile("database_rejected", insertError?.message ?? "insert returned no row", invoice);
  }

  const paymentId = (inserted as { id: string }).id;
  const after = await readInvoice(service, organizationId, invoice.id);
  const statusAfter = after?.status ?? invoice.status;
  const amountPaidAfter = Number(after?.amount_paid ?? invoice.amount_paid);

  const emit = deps.emitLifecycleEvent ?? emitInvoiceLifecycleEventAsService;
  await emit(service, organizationId, {
    eventType: "payment.recorded",
    paymentId,
    payload: {
      payment_id: paymentId,
      invoice_id: invoice.id,
      number: invoice.number,
      job_id: invoice.job_id,
      contact_id: invoice.contact_id,
      amount,
      method: "card_online",
      received_at: receivedAt,
      invoice_status_after: statusAfter,
      amount_paid_after: amountPaidAfter,
    },
  });
  // The database decided whether this payment settled the invoice.
  if (statusAfter === "paid") {
    await emit(service, organizationId, {
      eventType: "invoice.paid",
      invoiceId: invoice.id,
      completingPaymentId: paymentId,
      payload: {
        invoice_id: invoice.id,
        number: invoice.number,
        job_id: invoice.job_id,
        contact_id: invoice.contact_id,
        total: Number(invoice.total),
        amount_paid: amountPaidAfter,
        paid_at: after?.paid_at ?? null,
        completing_payment_id: paymentId,
      },
    });
  }

  return { kind: "recorded", organizationId, invoiceId: invoice.id, paymentId, invoiceStatus: statusAfter };
}

const REASON_TEXT: Record<ReconciliationReason, string> = {
  organization_mismatch: "the payment's details don't match this business",
  invalid_identifiers: "the payment's Stripe details are incomplete",
  amount_mismatch: "the amount doesn't match what was requested",
  payment_intent_mismatch: "Stripe's payment record doesn't match the checkout",
  invoice_not_found: "the invoice could not be found",
  invoice_not_payable: "the invoice is no longer open for payment",
  exceeds_balance: "the payment is more than the invoice's balance due",
  database_rejected: "the invoice ledger refused the payment",
};

async function raiseReconciliationIncident(
  service: SupabaseClient,
  context: { eventId: string; account: string; organizationId: string; sessionId: string; paymentIntentId: string | null; invoiceId: string | null; amountCents: number | null; currency: string | null },
  reason: ReconciliationReason,
  detail: string,
  invoice: InvoiceRow | null,
): Promise<OnlinePaymentOutcome> {
  const label = invoice ? formatInvoiceNumber(invoice.number) : null;
  const amountText = context.amountCents !== null && context.currency === "usd" ? formatMoney(fromCents(context.amountCents)) : "a payment";
  const description = `Stripe collected ${amountText}${label ? ` for ${label}` : ""}, but Trackpr could not record it because ${REASON_TEXT[reason]}. Find this payment in your Stripe dashboard, then record it on the invoice or refund it.`;

  console.error("[payments][online] Stripe payment could not be recorded - raising a reconciliation incident", { ...context, reason, detail });

  const incident = await recordAutomationHealthSignal(service, {
    organizationId: context.organizationId,
    category: "online_payment_reconciliation",
    severity: "critical",
    // record_automation_incident_signal caps fingerprints at 300 characters.
    fingerprintContext: (context.sessionId || context.paymentIntentId || context.eventId).slice(0, 255),
    title: label ? `Online payment for ${label} needs reconciliation` : "Online payment needs reconciliation",
    description,
    metadata: {
      reason,
      detail: detail.slice(0, 500),
      stripe_event_id: context.eventId,
      stripe_account_id: context.account,
      stripe_checkout_session_id: context.sessionId,
      stripe_payment_intent_id: context.paymentIntentId,
      invoice_id: invoice?.id ?? context.invoiceId,
      invoice_number: label,
      invoice_status: invoice?.status ?? null,
      invoice_balance_due: invoice ? Number(invoice.balance_due) : null,
      amount_cents: context.amountCents,
      currency: context.currency,
    },
  });

  if (!incident) {
    return { kind: "failed", reason: "incident_not_recorded", detail: `${reason}: ${detail}`.slice(0, 500) };
  }
  return { kind: "reconciliation_required", organizationId: context.organizationId, reason, incidentId: incident.id };
}

// ---------------------------------------------------------------------------
// Refunds and disputes (approved decision 3): raise a reconciliation incident,
// never change the ledger.
// ---------------------------------------------------------------------------

export type OnlinePaymentFollowUpKind = "refunded" | "disputed";

export type OnlinePaymentFollowUpEvent = {
  eventId: string;
  /** The signed event's `account`. */
  account: string | null | undefined;
  kind: OnlinePaymentFollowUpKind;
  /** The refund (or charge, if Stripe sent no refund object) / dispute id - the incident's dedup key. */
  objectId: string;
  paymentIntentId: string | null;
  amountCents: number | null;
  currency: string | null;
};

export type OnlinePaymentFollowUpOutcome =
  | { kind: "ignored"; reason: "unknown_connected_account" | "not_trackpr_payment" }
  | { kind: "reconciliation_required"; organizationId: string; reason: OnlinePaymentFollowUpKind; incidentId: string }
  | { kind: "failed"; reason: "incident_not_recorded"; detail: string };

/**
 * A refund or dispute on a connected account. Only one of Trackpr's own
 * recorded card_online payments is followed up - found by its PaymentIntent,
 * and only when that payment belongs to the organization that owns the
 * signed event's account and was taken on that same account. Anything else
 * (a charge the contractor took outside Trackpr, an account no organization
 * owns) is ignored. The customer_payments row and the invoice are never
 * touched: the incident tells a person the ledger may now overstate what was
 * collected, and they reconcile it.
 */
export async function recordOnlinePaymentFollowUp(service: SupabaseClient, event: OnlinePaymentFollowUpEvent): Promise<OnlinePaymentFollowUpOutcome> {
  const account = typeof event.account === "string" ? event.account : "";
  if (!CONNECT_ACCOUNT_ID_PATTERN.test(account)) return { kind: "ignored", reason: "unknown_connected_account" };
  const { data: orgRow } = await service.from("organizations").select("id").eq("stripe_connect_account_id", account).maybeSingle();
  if (!orgRow) return { kind: "ignored", reason: "unknown_connected_account" };
  const organizationId = (orgRow as { id: string }).id;

  if (!event.paymentIntentId || !PAYMENT_INTENT_ID_PATTERN.test(event.paymentIntentId)) return { kind: "ignored", reason: "not_trackpr_payment" };
  const { data: paymentRow } = await service
    .from("customer_payments")
    .select("id, organization_id, invoice_id, amount, stripe_account_id, stripe_checkout_session_id")
    .eq("stripe_payment_intent_id", event.paymentIntentId)
    .maybeSingle();
  const payment = paymentRow as { id: string; organization_id: string; invoice_id: string; amount: number | string; stripe_account_id: string | null; stripe_checkout_session_id: string | null } | null;
  if (!payment || payment.organization_id !== organizationId || payment.stripe_account_id !== account) {
    if (payment) console.error("[payments][online] refund/dispute for a payment on a different organization or account - ignored", { eventId: event.eventId, account, paymentId: payment.id });
    return { kind: "ignored", reason: "not_trackpr_payment" };
  }

  const invoice = await readInvoice(service, organizationId, payment.invoice_id);
  const label = invoice ? formatInvoiceNumber(invoice.number) : "the invoice";
  const amountText = event.amountCents !== null && (event.currency ?? "").toLowerCase() === "usd" ? formatMoney(fromCents(event.amountCents)) : "an amount";
  const refunded = event.kind === "refunded";

  const incident = await recordAutomationHealthSignal(service, {
    organizationId,
    category: "online_payment_reconciliation",
    severity: refunded ? "warning" : "critical",
    fingerprintContext: `${event.kind}:${event.objectId}`.slice(0, 255),
    title: refunded ? `Refund issued for ${label}` : `Card payment disputed for ${label}`,
    description: refunded
      ? `A refund of ${amountText} was issued in Stripe for the online payment on ${label}. Trackpr still shows that payment as received - review the invoice and its payments.`
      : `The customer disputed ${amountText} of the online payment on ${label}. Respond to the dispute in your Stripe dashboard. Trackpr still shows that payment as received.`,
    metadata: {
      reason: event.kind,
      stripe_event_id: event.eventId,
      stripe_account_id: account,
      stripe_object_id: event.objectId,
      stripe_payment_intent_id: event.paymentIntentId,
      stripe_checkout_session_id: payment.stripe_checkout_session_id,
      customer_payment_id: payment.id,
      payment_amount: Number(payment.amount),
      invoice_id: payment.invoice_id,
      invoice_number: invoice ? formatInvoiceNumber(invoice.number) : null,
      amount_cents: event.amountCents,
      currency: event.currency,
    },
  });

  if (!incident) return { kind: "failed", reason: "incident_not_recorded", detail: `${event.kind}: ${event.objectId}` };
  return { kind: "reconciliation_required", organizationId, reason: event.kind, incidentId: incident.id };
}
