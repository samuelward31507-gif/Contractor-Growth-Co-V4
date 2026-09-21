import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripeClient } from "@/lib/billing/stripe";
import { activateOrganizationPayment } from "@/lib/billing/activation";

/**
 * Payment Gate V1 - Stripe's server-to-server confirmation of a completed
 * checkout. This is the ONLY code path allowed to mark an organization as
 * paid (enforced at the database level - see
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
 * read from Stripe's own server-verified session/metadata - it is never
 * accepted from a query string, request body field a client could shape
 * freely, or any other client-controlled input, so a spoofed "?paid=true"
 * or a forged organization id in a hand-crafted request body can never
 * activate anything: only a request bearing a valid Stripe signature for
 * this specific webhook secret is ever processed at all.
 *
 * checkout.session.completed fires once per completed checkout; a replayed
 * or duplicated delivery of the same event (Stripe's own retry behavior,
 * or an operator resending it from the Stripe dashboard) re-runs the exact
 * same idempotent update (see activateOrganizationPayment) - never a
 * second activation, never a duplicate side effect.
 */
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

  if (event.type !== "checkout.session.completed") {
    // Every other event type is acknowledged but ignored - this pass only
    // ever needs to know "a checkout completed"; subscription lifecycle
    // events (renewals, cancellations, payment failures) are explicitly out
    // of scope for this gate and are not read or acted on here.
    return NextResponse.json({ ok: true, ignored: event.type }, { status: 200 });
  }

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

  const service = createServiceRoleClient();
  const result = await activateOrganizationPayment(service, organizationId);

  return NextResponse.json({ ok: result.ok }, { status: 200 });
}
