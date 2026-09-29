import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isSameOriginPost, requestOrigin } from "./connect-routes";
import { createInvoiceCheckoutSession } from "./invoice-checkout";
import { PAYMENT_TOKEN_PATTERN } from "./public-invoice";

/**
 * Phase 1C, Step 5: the logic behind POST /api/payments/[token]/checkout - the
 * public pay page's "Pay now" button. An untrusted, unauthenticated endpoint:
 * the unguessable payment token is the only authorization (the
 * lib/payments/public-invoice.ts trust model), and every decision about
 * money is delegated to lib/payments/invoice-checkout.ts (the guarded Stripe
 * client, the direct charge on the connected account, card only, the full
 * balance from the database, metadata, idempotency).
 *
 * What the request can influence: nothing but which token it names. The
 * body is never read - no amount, price, currency, organization or Stripe
 * account can be supplied - and only the Origin/Sec-Fetch-Site headers are
 * consulted, to refuse cross-site posts. The success/cancel URLs are built
 * from this app's own origin (which the same-origin check has just
 * confirmed) and the token itself.
 *
 * Responses: a 303 to Stripe Checkout (only ever an https *.stripe.com URL),
 * or a 303 back to the pay page carrying one fixed-vocabulary code
 * (?checkout=paid|unavailable|error). A malformed token is a plain 404. A
 * well-formed token that is unknown, a draft or void gets exactly the same
 * redirect as any other unavailable invoice - nothing distinguishes them.
 */

export type PayCheckoutNotice = "paid" | "unavailable" | "error";

export type PayRouteDeps = {
  /** Service-role client, created only after the request passes the method, origin and token checks. */
  createService: () => SupabaseClient;
  /** Test seams only. */
  stripe?: Stripe;
  now?: () => Date;
};

function payPageRedirect(request: Request, token: string, notice: PayCheckoutNotice): NextResponse {
  const target = new URL(`/pay/${token}`, requestOrigin(request));
  target.searchParams.set("checkout", notice);
  return NextResponse.redirect(target, 303);
}

/** Stripe Checkout lives on https *.stripe.com - never follow anything else. */
function isStripeCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "stripe.com" || url.hostname.endsWith(".stripe.com"));
  } catch {
    return false;
  }
}

export async function handleInvoiceCheckout(request: Request, token: string, deps: PayRouteDeps): Promise<NextResponse> {
  if (typeof token !== "string" || !PAYMENT_TOKEN_PATTERN.test(token)) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  if (request.method !== "POST" || !isSameOriginPost(request)) {
    return payPageRedirect(request, token, "error");
  }

  const outcome = await createInvoiceCheckoutSession(deps.createService(), { token, baseUrl: requestOrigin(request), now: deps.now?.() }, { stripe: deps.stripe });

  if (outcome.ok) {
    if (!isStripeCheckoutUrl(outcome.url)) {
      console.error("[payments][pay] refusing a non-Stripe checkout URL", { sessionId: outcome.sessionId });
      return payPageRedirect(request, token, "error");
    }
    return NextResponse.redirect(outcome.url, 303);
  }

  switch (outcome.reason) {
    case "already_paid":
      return payPageRedirect(request, token, "paid");
    case "not_found":
    case "not_accepting_online_payments":
      return payPageRedirect(request, token, "unavailable");
    default:
      return payPageRedirect(request, token, "error");
  }
}
