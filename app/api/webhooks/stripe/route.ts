import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripeClient } from "@/lib/billing/stripe";
import { activateOrganizationPayment, suspendOrganizationPayment, cancelOrganizationPayment } from "@/lib/billing/activation";
import { isTrackprSubscriptionCheckout } from "@/lib/billing/subscription-checkout";

/**
 * Payment Gate V1 + Subscription Lifecycle Hardening - Stripe's
 * server-to-server confirmation of checkout and ongoing subscription state.
 * This is the ONLY code path allowed to change an organization's
 * payment_status (enforced at the database level - see
 * 20260921120000_organization_payment_status.sql's guard trigger, which
 * rejects this exact write from anything but a service-role connection).
 *
 * Mirrors this codebase's existing webhook shape exactly (see
 * app/api/webhooks/sms/status/route.ts and
 * app/api/automation/n8n-callback/route.ts): no Trackpr session is
 * expected or checked - Stripe has no Trackpr session - so the signature
 * itself is the only authentication this route has or needs, verified via
 * Stripe's own SDK (stripe.webhooks.constructEvent), which fails closed
 * (throws) on a missing/invalid/tampered signature. The organization id is
 * always read from Stripe's own server-verified object/metadata - never
 * accepted from a query string, request body field a client could shape
 * freely, or any other client-controlled input, so a spoofed "?paid=true"
 * or a forged organization id in a hand-crafted request body can never
 * activate anything: only a request bearing a valid Stripe signature for
 * this specific webhook secret is ever processed at all.
 *
 * SUBSCRIPTION LIFECYCLE: createOrganizationCheckoutSession
 * (lib/billing/checkout.ts) already stamps organization_id into both the
 * Checkout Session's own metadata AND subscription_data.metadata, so the
 * resulting Stripe Subscription object carries organization_id in its own
 * metadata from the moment it's created - customer.subscription.updated/
 * deleted events (whose data.object IS that Subscription) can resolve the
 * organization the exact same way checkout.session.completed already does,
 * with no new schema column, no stored Stripe customer/subscription id, and
 * no second API call back to Stripe needed. Only these three event types
 * ever mutate payment_status; every other event type is acknowledged but
 * ignored for THAT purpose - the Subscription object's own `status` field,
 * delivered via customer.subscription.updated, already reflects a
 * failed/recovered renewal without needing a second, invoice-to-subscription
 * resolution step.
 *
 * REVENUE INTELLIGENCE (Phase 5D-1): invoice.payment_succeeded,
 * invoice.payment_failed, and charge.refunded are also handled below - but
 * only to append rows to revenue_events for reporting (lib/agency/revenue.ts).
 * They never read or write payment_status, and payment_status logic above is
 * unmodified by this addition.
 *
 * Each event type fires once per real state change; a replayed or
 * duplicated delivery (Stripe's own retry behavior, or an operator
 * resending it from the Stripe dashboard) re-runs the exact same
 * idempotent update (see lib/billing/activation.ts) - never a second
 * side effect.
 */

/** Statuses where Stripe has stopped collecting successfully but the subscription hasn't been confirmed cancelled - access should pause, but this organization may return to 'active' on its own if the subscription recovers. */
const NON_PAYING_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>(["past_due", "unpaid", "incomplete_expired", "paused"]);

/** The exact existing convention (see lib/billing/checkout.ts's subscription_data.metadata) - never a stored Stripe id, never trusted from anywhere but Stripe's own signed event payload. */
function organizationIdFromSubscription(subscription: Stripe.Subscription): string | undefined {
  return subscription.metadata?.organization_id;
}

// ---------------------------------------------------------------------------
// Phase 5D-1 - Revenue Intelligence. Everything below is additive: it never
// changes payment_status or any existing handler's own return value, it only
// (a) opportunistically persists the two Stripe identifiers that make
// invoice/refund attribution possible without a live Stripe API call, and
// (b) records revenue_events rows for invoice.payment_succeeded,
// invoice.payment_failed, and charge.refunded.
// ---------------------------------------------------------------------------

/** A Stripe expandable reference is either a plain id string or the expanded object - this app never expands, so it is always a string in practice, but this stays correct either way. */
function extractStripeId(value: string | { id: string } | null | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) return value.id;
  return undefined;
}

async function findOrganizationIdByStripeSubscription(service: SupabaseClient, subscriptionId: string): Promise<string | undefined> {
  const { data } = await service.from("organizations").select("id").eq("stripe_subscription_id", subscriptionId).maybeSingle();
  return data?.id;
}

async function findOrganizationIdByStripeCustomer(service: SupabaseClient, customerId: string): Promise<string | undefined> {
  const { data } = await service.from("organizations").select("id").eq("stripe_customer_id", customerId).maybeSingle();
  return data?.id;
}

async function organizationExists(service: SupabaseClient, organizationId: string): Promise<boolean> {
  const { data } = await service.from("organizations").select("id").eq("id", organizationId).maybeSingle();
  return data != null;
}

/**
 * Preferred path: the stored stripe_subscription_id (persisted at
 * checkout.session.completed below) - a direct, unambiguous local lookup,
 * never a live Stripe API call. Falls back to stripe_customer_id, then to
 * the invoice's own metadata.organization_id (verified to actually exist
 * before being trusted). Returns undefined - never a guess - when none of
 * these resolve, so the caller can acknowledge-and-skip.
 *
 * In Stripe API versions used by this SDK (stripe@22.x+), Invoice no longer
 * carries a flat `subscription` field - it is nested under
 * `invoice.parent.subscription_details.subscription`.
 */
async function resolveOrganizationIdForInvoice(service: SupabaseClient, invoice: Stripe.Invoice): Promise<string | undefined> {
  const subscriptionId = extractStripeId(invoice.parent?.subscription_details?.subscription);
  if (subscriptionId) {
    const found = await findOrganizationIdByStripeSubscription(service, subscriptionId);
    if (found) return found;
  }

  const customerId = extractStripeId(invoice.customer);
  if (customerId) {
    const found = await findOrganizationIdByStripeCustomer(service, customerId);
    if (found) return found;
  }

  const metadataOrganizationId = invoice.metadata?.organization_id;
  if (typeof metadataOrganizationId === "string" && metadataOrganizationId && (await organizationExists(service, metadataOrganizationId))) {
    return metadataOrganizationId;
  }

  return undefined;
}

/**
 * Charge objects in this SDK version carry no `invoice` field at all (see
 * the type definitions in node_modules/stripe/esm/resources/Charges.d.ts) -
 * so attribution here is customer-id lookup, then metadata fallback. No
 * subscription-id path exists for a bare Charge.
 */
async function resolveOrganizationIdForCharge(service: SupabaseClient, charge: Stripe.Charge): Promise<string | undefined> {
  const customerId = extractStripeId(charge.customer);
  if (customerId) {
    const found = await findOrganizationIdByStripeCustomer(service, customerId);
    if (found) return found;
  }

  const metadataOrganizationId = charge.metadata?.organization_id;
  if (typeof metadataOrganizationId === "string" && metadataOrganizationId && (await organizationExists(service, metadataOrganizationId))) {
    return metadataOrganizationId;
  }

  return undefined;
}

/**
 * Opportunistic only - called after an organization has already been
 * reliably resolved by other means (client_reference_id/metadata at
 * checkout, or an already-stored id at subscription lifecycle events),
 * never used itself to establish attribution. Never throws: the two partial
 * unique indexes on organizations.stripe_customer_id/stripe_subscription_id
 * (see the revenue_intelligence migration) are the actual safety net against
 * corrupting tenant linkage - a conflicting write is rejected by Postgres,
 * caught here, and logged, so a Stripe identifier already linked to a
 * DIFFERENT organization can never silently attach to this one.
 */
async function persistStripeIdentifiers(
  service: SupabaseClient,
  organizationId: string,
  customerId: string | undefined,
  subscriptionId: string | undefined,
): Promise<void> {
  const update: Record<string, string> = {};
  if (customerId) update.stripe_customer_id = customerId;
  if (subscriptionId) update.stripe_subscription_id = subscriptionId;
  if (Object.keys(update).length === 0) return;

  const { error } = await service.from("organizations").update(update).eq("id", organizationId);
  if (error) {
    console.error("[billing][webhook] failed to persist Stripe identifiers - possible cross-tenant conflict, linkage left unchanged", {
      organizationId,
      customerId,
      subscriptionId,
      error: error.message,
    });
  }
}

type RevenueEventInput = {
  organizationId: string;
  providerEventId: string;
  providerObjectId: string;
  eventType: "payment_succeeded" | "payment_failed" | "refund";
  revenueCategory: "setup" | "recurring" | null;
  amount: number;
  currency: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
};

/**
 * The one write path for revenue_events. Uses upsert with
 * ignoreDuplicates:true on the provider_event_id unique constraint - the
 * exact pattern already proven in app/api/automation/n8n-callback/route.ts
 * for ai_interactions - never a SELECT-then-INSERT, so a Stripe retry or an
 * operator's manual "resend" always resolves to exactly one row.
 */
async function recordRevenueEvent(service: SupabaseClient, input: RevenueEventInput): Promise<void> {
  const { error } = await service.from("revenue_events").upsert(
    {
      organization_id: input.organizationId,
      provider: "stripe",
      provider_event_id: input.providerEventId,
      provider_object_id: input.providerObjectId,
      event_type: input.eventType,
      revenue_category: input.revenueCategory,
      amount: input.amount,
      currency: input.currency,
      occurred_at: input.occurredAt,
      metadata: input.metadata,
    },
    { onConflict: "provider_event_id", ignoreDuplicates: true },
  );
  if (error) {
    console.error("[billing][webhook] failed to record revenue event", { providerEventId: input.providerEventId, error: error.message });
  }
}

/**
 * checkout.ts's subscription-mode Checkout Session always bills the
 * one-time setup price together with the first recurring price on the SAME
 * invoice (billing_reason=subscription_create) - a mixed invoice can never
 * be honestly labeled 100% setup or 100% recurring at this invoice-level
 * granularity, so it is left null rather than guessed. Only a
 * subscription_cycle renewal (which bills only the recurring price, the
 * setup price never recurs) is confidently "recurring".
 */
function classifyInvoiceRevenueCategory(invoice: Stripe.Invoice): "recurring" | null {
  return invoice.billing_reason === "subscription_cycle" ? "recurring" : null;
}

/** The latest refund on this charge, per this event's own payload - Stripe orders the embedded refunds list newest-first. */
function latestRefund(charge: Stripe.Charge): Stripe.Refund | undefined {
  return charge.refunds?.data?.[0];
}

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ ok: false, error: "Stripe webhooks are not configured." }, { status: 401 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ ok: false, error: "Missing signature." }, { status: 401 });
  }

  const rawBody = await request.text();

  let event;
  try {
    const stripe = getStripeClient();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error("[billing][webhook] signature verification failed", { error: error instanceof Error ? error.message : "unknown error" });
    return NextResponse.json({ ok: false, error: "Invalid signature." }, { status: 401 });
  }

  const service = createServiceRoleClient();

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    // Phase 1C, Step 1: only Trackpr's own subscription checkout (subscription
    // mode, platform account) may activate an organization. A payment-mode
    // session - e.g. a contractor's customer paying an invoice - or any event
    // from a connected account is acknowledged and ignored here, never
    // allowed to touch payment_status or the stored Stripe identifiers. See
    // lib/billing/subscription-checkout.ts.
    if (!isTrackprSubscriptionCheckout({ account: event.account, session })) {
      return NextResponse.json({ ok: true, ignored: "not_trackpr_subscription_checkout" }, { status: 200 });
    }

    const organizationId = session.client_reference_id ?? (session.metadata?.organization_id as string | undefined);

    if (!organizationId) {
      console.error("[billing][webhook] checkout.session.completed had no organization id", { sessionId: session.id });
      // Acknowledge (200) rather than error: Stripe retries a non-2xx
      // response, and a retry of this exact event would hit the exact same
      // missing-metadata problem every time - the safer failure mode is one
      // logged, unresolved activation (visible in server logs for manual
      // follow-up), not an unbounded Stripe retry loop.
      return NextResponse.json({ ok: false, reason: "missing_organization_id" }, { status: 200 });
    }

    const result = await activateOrganizationPayment(service, organizationId);

    // Opportunistic Stripe-identifier persistence: organizationId here is
    // already reliably resolved above via client_reference_id/metadata
    // (never via these ids), so this can never be the source of a wrong
    // attribution - only a convenience for later invoice/refund events.
    await persistStripeIdentifiers(service, organizationId, extractStripeId(session.customer), extractStripeId(session.subscription));

    return NextResponse.json({ ok: result.ok }, { status: 200 });
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const organizationId = organizationIdFromSubscription(subscription);

    if (!organizationId) {
      console.error("[billing][webhook] customer.subscription.deleted had no organization id", { subscriptionId: subscription.id });
      return NextResponse.json({ ok: false, reason: "missing_organization_id" }, { status: 200 });
    }

    const result = await cancelOrganizationPayment(service, organizationId);
    return NextResponse.json({ ok: result.ok }, { status: 200 });
  }

  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object;
    const organizationId = organizationIdFromSubscription(subscription);

    if (!organizationId) {
      console.error("[billing][webhook] customer.subscription.updated had no organization id", { subscriptionId: subscription.id });
      return NextResponse.json({ ok: false, reason: "missing_organization_id" }, { status: 200 });
    }

    const status = subscription.status;

    if (status === "active" || status === "trialing") {
      // Covers both the normal post-checkout confirmation and a subscription
      // recovering from a temporary payment issue (past_due/unpaid -> active)
      // - the same transition either way, and idempotent if payment_status
      // is already 'active'.
      const result = await activateOrganizationPayment(service, organizationId);
      return NextResponse.json({ ok: result.ok }, { status: 200 });
    }

    if (status === "canceled") {
      const result = await cancelOrganizationPayment(service, organizationId);
      return NextResponse.json({ ok: result.ok }, { status: 200 });
    }

    if (NON_PAYING_SUBSCRIPTION_STATUSES.has(status)) {
      const result = await suspendOrganizationPayment(service, organizationId);
      return NextResponse.json({ ok: result.ok }, { status: 200 });
    }

    // 'incomplete' (the transitional state before a subscription's first
    // payment is confirmed) and any other/future status Stripe might add:
    // never confidently mapped to a payment_status transition, so never
    // acted on - acknowledged and ignored rather than guessed at.
    return NextResponse.json({ ok: true, ignored: status }, { status: 200 });
  }

  // ---------------------------------------------------------------------
  // Phase 5D-1 - Revenue Intelligence. These three event types never touch
  // payment_status (the Subscription object's own status, delivered via
  // customer.subscription.updated above, remains the only thing that ever
  // does that) - they only append rows to revenue_events for reporting.
  // ---------------------------------------------------------------------

  if (event.type === "invoice.payment_succeeded" || event.type === "invoice.payment_failed") {
    const invoice = event.data.object;
    const organizationId = await resolveOrganizationIdForInvoice(service, invoice);

    if (!organizationId) {
      console.error(`[billing][webhook] ${event.type} could not be attributed to any organization`, { invoiceId: invoice.id });
      return NextResponse.json({ ok: false, reason: "missing_organization_id" }, { status: 200 });
    }

    const isSucceeded = event.type === "invoice.payment_succeeded";
    await recordRevenueEvent(service, {
      organizationId,
      providerEventId: event.id,
      providerObjectId: invoice.id,
      eventType: isSucceeded ? "payment_succeeded" : "payment_failed",
      revenueCategory: classifyInvoiceRevenueCategory(invoice),
      // A failed payment never contributes to collected revenue (see
      // lib/agency/revenue.ts reporting) - amount_due is recorded here only
      // so the failed-payments total can show what collection was
      // attempted, never combined into a collected figure.
      amount: isSucceeded ? invoice.amount_paid : invoice.amount_due,
      currency: invoice.currency,
      occurredAt: new Date(event.created * 1000).toISOString(),
      metadata: {
        billing_reason: invoice.billing_reason,
        customer: extractStripeId(invoice.customer) ?? null,
        subscription: extractStripeId(invoice.parent?.subscription_details?.subscription) ?? null,
      },
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  }

  if (event.type === "charge.refunded") {
    const charge = event.data.object;
    const refund = latestRefund(charge);

    if (!refund) {
      // charge.refunded with no embedded refund to attribute an amount to -
      // never guess an amount from the charge's own cumulative
      // amount_refunded (that field is the running total across ALL
      // refunds on this charge, not this specific refund - using it here
      // would double-count on a second partial refund).
      console.error("[billing][webhook] charge.refunded had no refund object to record", { chargeId: charge.id });
      return NextResponse.json({ ok: false, reason: "missing_refund_object" }, { status: 200 });
    }

    const organizationId = await resolveOrganizationIdForCharge(service, charge);
    if (!organizationId) {
      console.error("[billing][webhook] charge.refunded could not be attributed to any organization", { chargeId: charge.id, refundId: refund.id });
      return NextResponse.json({ ok: false, reason: "missing_organization_id" }, { status: 200 });
    }

    await recordRevenueEvent(service, {
      organizationId,
      providerEventId: event.id,
      // The individual refund's own id, not the parent charge's id - one
      // charge can have multiple distinct refund events over time.
      providerObjectId: refund.id,
      eventType: "refund",
      // Not confidently traceable to setup vs. recurring from a bare
      // Charge/Refund object alone - preserved as null rather than guessed.
      revenueCategory: null,
      amount: refund.amount,
      currency: refund.currency,
      occurredAt: new Date(event.created * 1000).toISOString(),
      metadata: { charge: charge.id, customer: extractStripeId(charge.customer) ?? null },
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // Every other event type is acknowledged but ignored - it can never
  // mutate payment_status or write a revenue_events row.
  return NextResponse.json({ ok: true, ignored: event.type }, { status: 200 });
}
