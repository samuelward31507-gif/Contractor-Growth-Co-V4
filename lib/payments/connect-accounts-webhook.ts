import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { CONNECT_ACCOUNT_ID_PATTERN, paymentsStripe, stripeErrorMessage, syncConnectAccountById } from "./connect";

/**
 * Phase 1C (W2): the Accounts v2 thin-event webhook - POST
 * /api/webhooks/stripe-connect/accounts. The primary way a connected
 * account's status reaches Trackpr: Stripe emits v2 events for every
 * capability and requirements change on a v2 Account, but does NOT always
 * emit the v1 account.updated snapshot event (observed in the sandbox: the
 * final card_payments activation produced only
 * v2.core.account[configuration.merchant].capability_status_updated and
 * v2.core.account[requirements].updated). The v1 account.updated handling in
 * lib/payments/connect-webhook.ts stays as an additional path.
 *
 * Delivery: a Stripe "thin" event notification (object "v2.core.event"),
 * from an event destination scoped to "Your account" - Stripe sends v2
 * events about the platform's own connected accounts with context null and
 * the account in related_object ({ id: "acct_...", type: "v2.core.account" }).
 * It has its own signing secret, STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET.
 *
 * Handling: the signature is verified and the notification parsed by
 * Stripe's own stripe.parseEventNotification (the guarded client - a live
 * key outside Vercel Production refuses first). The payload carries no
 * status at all; the account id from related_object is looked up against
 * the stored, unique stripe_connect_account_id (never metadata or request
 * input), and syncConnectAccountById re-fetches the account through Accounts
 * v2 and stores statusFromV2Account's mapping - the same ownership checks,
 * the same fail-closed storage as every other sync. Re-running it for a
 * duplicate delivery just stores the same fresh state again.
 *
 * Status codes - non-2xx only when a Stripe retry can help:
 *   400 invalid or missing signature
 *   500 not configured (missing secret, guard refused the key), Stripe
 *       unreachable during the re-fetch, storage failure
 *   200 synced; ignored (unhandled event type, not an account event, a
 *       connected-account context, an unknown account, a signed payload that
 *       is not a thin event); not_applied (ownership mismatch - logged, no
 *       retry can fix it)
 * Response bodies carry an outcome word and a reason code only.
 */

export const HANDLED_V2_ACCOUNT_EVENT_TYPES = [
  "v2.core.account[configuration.merchant].capability_status_updated",
  "v2.core.account[requirements].updated",
] as const;

export type ConnectAccountsWebhookDeps = {
  /** Service-role client, created only after a handled, well-formed, signed event. */
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

function isSignatureError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { type?: unknown }).type === "StripeSignatureVerificationError");
}

export async function handleConnectAccountsWebhook(request: Request, deps: ConnectAccountsWebhookDeps): Promise<NextResponse> {
  if (request.method !== "POST") return respond(405, { ok: false, outcome: "method_not_allowed" });

  const secret = (deps.env ?? process.env).STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[payments][connect-accounts-webhook] STRIPE_CONNECT_ACCOUNTS_WEBHOOK_SECRET is not configured");
    return respond(500, { ok: false, outcome: "not_configured" });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return respond(400, { ok: false, outcome: "invalid_signature" });

  let stripe: Stripe;
  try {
    stripe = paymentsStripe({ stripe: deps.stripe });
  } catch (error) {
    console.error("[payments][connect-accounts-webhook] payments Stripe client refused", { error: stripeErrorMessage(error) });
    return respond(500, { ok: false, outcome: "not_configured" });
  }

  const rawBody = await request.text();
  let notification: Stripe.V2.Core.EventNotification;
  try {
    notification = stripe.parseEventNotification(rawBody, signature, secret);
  } catch (error) {
    if (isSignatureError(error)) {
      console.error("[payments][connect-accounts-webhook] signature verification failed");
      return respond(400, { ok: false, outcome: "invalid_signature" });
    }
    // Signed by Stripe but not a thin event (e.g. a v1 snapshot event sent to
    // this endpoint by misconfiguration) - no retry can change that.
    console.error("[payments][connect-accounts-webhook] signed payload is not a v2 event notification", { error: error instanceof Error ? error.message : String(error) });
    return respond(200, { ok: true, outcome: "ignored", reason: "not_a_thin_event" });
  }

  if (!(HANDLED_V2_ACCOUNT_EVENT_TYPES as readonly string[]).includes(notification.type)) {
    return respond(200, { ok: true, outcome: "ignored", reason: "unhandled_event_type" });
  }

  // Events about the platform's own connected accounts arrive with no context;
  // one with a context was raised inside some other account's scope.
  if (notification.context) return respond(200, { ok: true, outcome: "ignored", reason: "not_platform_event" });

  // The SDK's V2.Core.Events.RelatedObject shape: { id, type, url }.
  const related = (notification as { related_object?: { id?: unknown; type?: unknown; url?: unknown } | null }).related_object;
  const accountId = related?.type === "v2.core.account" && typeof related.id === "string" ? related.id : "";
  if (!CONNECT_ACCOUNT_ID_PATTERN.test(accountId)) return respond(200, { ok: true, outcome: "ignored", reason: "invalid_related_object" });

  const synced = await syncConnectAccountById(deps.createService(), accountId, { stripe: deps.stripe });
  if (synced.ok) return respond(200, { ok: true, outcome: "synced" });
  if (synced.code === "unknown_account") return respond(200, { ok: true, outcome: "ignored", reason: "unknown_account" });
  if (synced.code === "stripe_unavailable" || synced.code === "storage_failed") return respond(500, { ok: false, outcome: "retry", reason: synced.code });
  console.error("[payments][connect-accounts-webhook] account event could not be applied", { eventId: notification.id, accountId, code: synced.code });
  return respond(200, { ok: false, outcome: "not_applied", reason: synced.code });
}
