import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { GOOGLE_CALENDAR_OAUTH_SCOPES } from "@/lib/calendar/google";
import { resolveCalendarOAuthRedirectUri, OAUTH_STATE_COOKIE_NAME, OAUTH_STATE_COOKIE_MAX_AGE_SECONDS, OAUTH_STATE_COOKIE_PATH } from "@/lib/calendar/oauth";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Phase 1 Scheduling Foundation, Stage 3: begins the Google Calendar OAuth
 * flow. A real, session-authenticated browser navigation (the contractor
 * clicking "Connect Google Calendar" in Settings) - not a webhook, so this
 * uses the normal cookie-based createClient(), exactly like every other
 * authenticated route/action in this codebase, not the service-role/
 * shared-secret pattern the Stripe/n8n webhooks use (those have no
 * Trackpr session to check; this route always does).
 *
 * organization_id is NEVER read from a query string or any client-supplied
 * value here - it is resolved the same way every other organization-scoped
 * action in this codebase resolves it: auth.getUser() -> auth.uid() ->
 * organization_members, via getUserOrganization(). The `state` value sent
 * to Google carries no organization/user identity at all - it is a plain
 * cryptographically random nonce, bound to this request only via a
 * short-lived httpOnly cookie the callback route compares against. The
 * callback re-resolves organization fresh from the (still-authenticated)
 * session the same way this route does - never from `state`, never from
 * anything Google echoes back - so there is nothing for state to leak even
 * if it were somehow intercepted.
 */
export async function GET(request: NextRequest) {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ ok: false, error: "Google Calendar is not configured." }, { status: 501 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    return NextResponse.redirect(new URL("/onboarding", request.url));
  }

  if (membership.role !== "owner" && membership.role !== "admin") {
    return NextResponse.redirect(new URL("/settings?calendar=error&reason=not_authorized", request.url));
  }

  const state = randomBytes(32).toString("base64url");
  const redirectUri = resolveCalendarOAuthRedirectUri(request);

  const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", GOOGLE_CALENDAR_OAUTH_SCOPES.join(" "));
  authorizationUrl.searchParams.set("state", state);
  // access_type=offline + prompt=consent together guarantee Google returns
  // a refresh_token on every connection attempt, including a reconnect for
  // an account that already granted consent once before - without
  // prompt=consent, a reconnect could silently omit refresh_token, leaving
  // this connection unable to refresh once its short-lived access token
  // expires.
  authorizationUrl.searchParams.set("access_type", "offline");
  authorizationUrl.searchParams.set("prompt", "consent");

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
    path: OAUTH_STATE_COOKIE_PATH,
  });
  return response;
}
