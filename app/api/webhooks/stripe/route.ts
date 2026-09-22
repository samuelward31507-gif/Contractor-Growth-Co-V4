import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripeClient } from "@/lib/billing/stripe";
import { activateOrganizationPayment, suspendOrganizationPayment, cancelOrganizationPayment } from "@/lib/billing/activation";

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
 * are ever acted on; every other event type (including invoice.* events,
 * which are deliberately NOT handled - the Subscription object's own
 * `status` field, delivered via customer.subscription.updated, already
 * reflects a failed/recovered renewal without needing a second,
 * invoice-to-subscription resolution step) is acknowledged but ignored, so
 * an unrelated Stripe event can never mutate payment_status.
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

  // Every other event type (including invoice.* events - see this file's own
  // module comment for why those are deliberately not handled) is
  // acknowledged but ignored - it can never mutate payment_status.
  return NextResponse.json({ ok: true, ignored: event.type }, { status: 200 });
}
