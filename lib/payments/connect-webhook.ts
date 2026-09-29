import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { paymentsStripe, stripeErrorMessage, syncConnectAccountById } from "./connect";
import { recordOnlineInvoicePayment, recordOnlinePaymentFollowUp, type OnlinePaymentHooks } from "./online-payment";

/**
 * Phase 1C, Step 6: the logic behind POST /api/webhooks/stripe-connect - the
 * Stripe Connect webhook for events that happen ON contractors' connected
 * accounts. Separate from Trackpr's own subscription webhook
 * (app/api/webhooks/stripe), with its own signing secret
 * (STRIPE_CONNECT_WEBHOOK_SECRET); it can never touch an organization's
 * payment_status.
 *
 * Authentication is the Stripe signature alone, verified through the guarded
 * client (getPaymentsStripeClient via paymentsStripe) - a live key outside
 * Vercel Production refuses before anything is read. The connected
 * organization is always derived from the signed event's `account` (matched
 * against the stored, unique stripe_connect_account_id); an event without
 * `account` is not a connected-account event and is ignored. Metadata never
 * selects an organization - online-payment.ts only cross-checks it.
 *
 * Handled events - everything else is acknowledged and ignored:
 *   account.updated             re-read the account from Stripe and store its
 *                               flags (connect.ts; the payload is not trusted)
 *   checkout.session.completed  record the invoice payment through the
 *                               online-payment.ts accounting boundary
 *   charge.refunded,            raise an online_payment_reconciliation
 *   charge.dispute.created      incident for Trackpr's own payment; the ledger
 *                               is never changed (approved decision 3)
 *
 * Status codes (approved): non-2xx ONLY when a Stripe retry can actually
 * help - the webhook is misconfigured, Stripe was unreachable while we
 * verified, storage failed, or a reconciliation incident could not be
 * written. Recorded, duplicate and ignored events are 200 { ok: true }. A
 * mismatch that no retry can fix is 200 { ok: false } once its incident is
 * recorded (or, with no organization to attach it to, once it is logged) -
 * so Stripe does not retry forever. Response bodies carry an outcome word and
 * a reason code only, never ids, amounts or secrets.
 */

export type ConnectWebhookDeps = OnlinePaymentHooks & {
  /** Service-role client, created only after the signature is verified. */
  createService: () => SupabaseClient;
  /** Test seam only; production uses the guarded client. */
  stripe?: Stripe;
  /** Test seam only; production reads process.env. */
  env?: NodeJS.ProcessEnv;
};

type Body = { ok: boolean; outcome: string; reason?: string };

function respond(status: number, body: Body): NextResponse {
  return NextResponse.json(body, { status });
}

function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

export async function handleConnectWebhook(request: Request, deps: ConnectWebhookDeps): Promise<NextResponse> {
  if (request.method !== "POST") return respond(405, { ok: false, outcome: "method_not_allowed" });

  const secret = (deps.env ?? process.env).STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[payments][connect-webhook] STRIPE_CONNECT_WEBHOOK_SECRET is not configured");
    return respond(500, { ok: false, outcome: "not_configured" });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return respond(400, { ok: false, outcome: "invalid_signature" });

  let stripe: Stripe;
  try {
    stripe = paymentsStripe({ stripe: deps.stripe });
  } catch (error) {
    // The live-key guard (or a missing key): nothing is verified or read.
    console.error("[payments][connect-webhook] payments Stripe client refused", { error: stripeErrorMessage(error) });
    return respond(500, { ok: false, outcome: "not_configured" });
  }

  const rawBody = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    console.error("[payments][connect-webhook] signature verification failed", { error: error instanceof Error ? error.message : "unknown error" });
    return respond(400, { ok: false, outcome: "invalid_signature" });
  }

  const account = typeof event.account === "string" && event.account ? event.account : null;
  if (!account) return respond(200, { ok: true, outcome: "ignored", reason: "no_connected_account" });

  const service = deps.createService();

  switch (event.type) {
    case "account.updated": {
      const synced = await syncConnectAccountById(service, account, { stripe: deps.stripe });
      if (synced.ok) return respond(200, { ok: true, outcome: "synced" });
      if (synced.code === "unknown_account") return respond(200, { ok: true, outcome: "ignored", reason: "unknown_account" });
      if (synced.code === "stripe_unavailable" || synced.code === "storage_failed") return respond(500, { ok: false, outcome: "retry", reason: synced.code });
      console.error("[payments][connect-webhook] account.updated could not be applied", { eventId: event.id, account, code: synced.code });
      return respond(200, { ok: false, outcome: "not_applied", reason: synced.code });
    }

    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode !== "payment") return respond(200, { ok: true, outcome: "ignored", reason: "not_payment_mode" });
      const result = await recordOnlineInvoicePayment(service, { eventId: event.id, account, created: event.created, session }, { stripe: deps.stripe, emitLifecycleEvent: deps.emitLifecycleEvent });
      switch (result.kind) {
        case "recorded":
          return respond(200, { ok: true, outcome: "recorded" });
        case "duplicate":
          return respond(200, { ok: true, outcome: "duplicate" });
        case "ignored":
          return respond(200, { ok: true, outcome: "ignored", reason: result.reason });
        case "reconciliation_required":
          return respond(200, { ok: false, outcome: "reconciliation_required", reason: result.reason });
        case "failed":
          if (result.reason === "unattributable") {
            // No organization owns this account: no incident can be attached,
            // and no retry can create the link. Logged by online-payment.ts.
            return respond(200, { ok: false, outcome: "unattributable" });
          }
          return respond(500, { ok: false, outcome: "retry", reason: result.reason });
      }
      break;
    }

    case "charge.refunded":
    case "charge.dispute.created": {
      const followUp =
        event.type === "charge.refunded"
          ? (() => {
              const charge = event.data.object;
              const refund = charge.refunds?.data?.[0];
              return { kind: "refunded" as const, objectId: refund?.id ?? charge.id, paymentIntentId: stripeId(charge.payment_intent), amountCents: refund?.amount ?? charge.amount_refunded ?? null, currency: refund?.currency ?? charge.currency ?? null };
            })()
          : (() => {
              const dispute = event.data.object;
              return { kind: "disputed" as const, objectId: dispute.id, paymentIntentId: stripeId(dispute.payment_intent), amountCents: dispute.amount ?? null, currency: dispute.currency ?? null };
            })();
      const result = await recordOnlinePaymentFollowUp(service, { eventId: event.id, account, ...followUp });
      if (result.kind === "ignored") return respond(200, { ok: true, outcome: "ignored", reason: result.reason });
      if (result.kind === "reconciliation_required") return respond(200, { ok: false, outcome: "reconciliation_required", reason: result.reason });
      return respond(500, { ok: false, outcome: "retry", reason: result.reason });
    }
  }

  return respond(200, { ok: true, outcome: "ignored", reason: "unhandled_event_type" });
}
