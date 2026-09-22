import type { NextRequest } from "next/server";
import { resolveAppBaseUrl } from "@/lib/automation/sms";

/**
 * Shared between app/api/calendar/oauth/start and .../callback so the
 * redirect_uri sent to Google's authorization request and the one sent
 * during the subsequent token exchange can never drift apart - Google
 * rejects an authorization code exchange whose redirect_uri doesn't
 * exactly match the one used to obtain that code, so this MUST be one
 * shared function, not two independent implementations that happen to
 * agree today.
 *
 * Reuses resolveAppBaseUrl() (the same "what's our own URL" convention
 * every other outbound-URL-needing feature in this codebase already
 * uses - Stripe checkout success/cancel URLs, Twilio status callbacks) -
 * no new environment variable, no second URL mechanism. Falls back to the
 * incoming request's own Host header only when resolveAppBaseUrl() returns
 * null (local development, matching lib/billing/checkout.ts's own
 * resolveCheckoutBaseUrl() fallback), which never happens in the real
 * Vercel deployment this app actually runs in.
 */
export function resolveCalendarOAuthRedirectUri(request: NextRequest): string {
  const configured = resolveAppBaseUrl();
  const baseUrl =
    configured ??
    (() => {
      const host = request.headers.get("host") ?? "localhost:3000";
      const proto = request.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
      return `${proto}://${host}`;
    })();

  return `${baseUrl}/api/calendar/oauth/callback`;
}

/** Short-lived, httpOnly, scoped to only the two routes that ever read/write it - a CSRF nonce, never anything organization- or user-identifying (organization is always re-resolved fresh from the session at both ends, never from this cookie or from Google's state round-trip). */
export const OAUTH_STATE_COOKIE_NAME = "calendar_oauth_state";
export const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 600;
export const OAUTH_STATE_COOKIE_PATH = "/api/calendar/oauth";
