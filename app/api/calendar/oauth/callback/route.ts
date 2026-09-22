import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { googleCalendarProvider } from "@/lib/calendar/google";
import { storeGoogleConnection } from "@/lib/calendar/connection";
import { resolveCalendarOAuthRedirectUri, OAUTH_STATE_COOKIE_NAME, OAUTH_STATE_COOKIE_PATH } from "@/lib/calendar/oauth";

/**
 * Phase 1 Scheduling Foundation, Stage 3: completes the Google Calendar
 * OAuth flow. Every redirect back to Settings carries only a safe,
 * fixed-vocabulary indicator (?calendar=connected|error&reason=...) - never
 * a token, never a code, never anything Google returned verbatim. Nothing
 * in this route is ever logged with the authorization code or a token
 * value included.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const settingsUrl = (params: Record<string, string>) => {
    const target = new URL("/settings", request.url);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    return target;
  };

  const response = (redirectTarget: URL) => {
    const res = NextResponse.redirect(redirectTarget);
    // One-time use - cleared on every outcome, not just success.
    res.cookies.set(OAUTH_STATE_COOKIE_NAME, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 0, path: OAUTH_STATE_COOKIE_PATH });
    return res;
  };

  const googleError = url.searchParams.get("error");
  if (googleError) {
    // The contractor declined consent, or Google itself rejected the
    // request - never surfaced verbatim (Google's own `error` values are
    // short fixed codes like "access_denied", but this route still never
    // forwards arbitrary query-string content into a redirect target).
    return response(settingsUrl({ calendar: "error", reason: "access_denied" }));
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const cookieState = request.cookies.get(OAUTH_STATE_COOKIE_NAME)?.value;

  if (!code || !returnedState || !cookieState) {
    return response(settingsUrl({ calendar: "error", reason: "invalid_state" }));
  }

  const returnedStateBuffer = Buffer.from(returnedState);
  const cookieStateBuffer = Buffer.from(cookieState);
  const stateMatches = returnedStateBuffer.length === cookieStateBuffer.length && timingSafeEqual(returnedStateBuffer, cookieStateBuffer);
  if (!stateMatches) {
    return response(settingsUrl({ calendar: "error", reason: "invalid_state" }));
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return response(new URL("/login", request.url));
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    return response(new URL("/onboarding", request.url));
  }
  if (membership.role !== "owner" && membership.role !== "admin") {
    return response(settingsUrl({ calendar: "error", reason: "not_authorized" }));
  }

  const redirectUri = resolveCalendarOAuthRedirectUri(request);
  const exchangeResult = await googleCalendarProvider.exchangeCode(code, redirectUri);
  if (!exchangeResult.ok) {
    console.error("[calendar][oauth] code exchange failed", { organizationId: membership.organizationId, error: exchangeResult.error });
    return response(settingsUrl({ calendar: "error", reason: "exchange_failed" }));
  }

  const storeResult = await storeGoogleConnection(supabase, membership.organizationId, exchangeResult.value.account, exchangeResult.value.tokens);
  if (!storeResult.ok) {
    console.error("[calendar][oauth] failed to store connection", { organizationId: membership.organizationId, error: storeResult.error });
    return response(settingsUrl({ calendar: "error", reason: "storage_failed" }));
  }

  return response(settingsUrl({ calendar: "connected" }));
}
