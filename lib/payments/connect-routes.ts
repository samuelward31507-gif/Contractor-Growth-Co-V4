import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import type { OrganizationPaymentStatus, OrganizationRole } from "@/lib/auth/organization";
import { createConnectOnboardingLink, describeConnectState, getOrganizationConnectStatus, refreshConnectOnboardingLink, syncConnectAccountStatus } from "./connect";

/**
 * Phase 1C, Step 4: the logic behind the two Stripe Connect onboarding routes
 * (app/api/payments/connect/start and /return). The route files only wire
 * real dependencies into these handlers, so every rule below is unit-tested
 * with fakes (connect-routes.test.ts). All Stripe work is delegated to
 * lib/payments/connect.ts - the guarded client, the Standard-style account,
 * the re-read-from-Stripe sync - nothing Stripe-specific is re-implemented
 * here.
 *
 * Identity: the organization is always the signed-in user's own membership,
 * resolved server-side (getUserOrganization via resolveSession). No
 * organization id, Stripe account id or onboarding status is ever read from
 * the request - query string, form body and headers other than Origin are
 * ignored. Only owners and admins may start onboarding or sync.
 *
 * start (POST only): it creates a Stripe account, so it is never reachable by
 * a plain link or GET. A cross-site POST is refused by an Origin /
 * Sec-Fetch-Site check (the session cookie is SameSite=Lax as well). The
 * organization's Trackpr subscription must be active - the same payment gate
 * as the rest of the app.
 *
 * refresh (GET - Stripe's refresh_url, when a link expired or was already
 * used): a NEW onboarding link for the organization's EXISTING account, then
 * straight back to Stripe. It never creates an account (an organization with
 * none is sent to Settings as not_connected), so it is the only GET with a
 * Stripe side effect, and that side effect is just a single-use link for the
 * caller's own account. Stripe navigates the browser here from
 * accounts.stripe.com, so the request is cross-site by nature and carries no
 * Origin - the same-origin POST check cannot apply. Instead it must be a
 * top-level document navigation (Sec-Fetch-Mode/Sec-Fetch-Dest, when the
 * browser sends them), and the usual admin + active-subscription checks hold.
 * The worst a forged request can do is open the signed-in admin's own
 * organization's Stripe onboarding.
 *
 * return (GET - Stripe redirects the browser here): re-reads the account
 * from Stripe for the signed-in admin's organization and stores its flags.
 * Nothing Stripe appends to the URL is trusted or even read.
 *
 * Every redirect back to Settings carries only a fixed-vocabulary indicator
 * (?payments=connected|incomplete|error&reason=...) - never an
 * account id, organization id, Stripe message or secret.
 */

export type ConnectRouteSession =
  | { kind: "unauthenticated" }
  | { kind: "no_organization" }
  | { kind: "member"; organizationId: string; role: OrganizationRole; paymentStatus: OrganizationPaymentStatus };

export type ConnectRouteDeps = {
  resolveSession: () => Promise<ConnectRouteSession>;
  /** The service-role client: the organizations Connect columns refuse writes from a user session. Called lazily, only after authorization. */
  createService: () => SupabaseClient;
  /** Test seam only; production uses the guarded client inside lib/payments/connect.ts. */
  stripe?: Stripe;
};

export type PaymentsNotice = "connected" | "incomplete" | "expired" | "error";
export type PaymentsErrorReason = "invalid_request" | "not_authorized" | "subscription_inactive" | "stripe_unavailable" | "not_connected" | "sync_failed";

export const CONNECT_RETURN_PATH = "/api/payments/connect/return";
export const CONNECT_REFRESH_PATH = "/api/payments/connect/refresh";

/** The origin the browser actually used, as the proxy reports it. */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : url.protocol.replace(":", ""));
  return `${proto}://${host}`;
}

/** A same-origin browser POST: Sec-Fetch-Site (when sent) must be same-origin, and Origin must be present and equal to this app's origin. */
export function isSameOriginPost(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin === requestOrigin(request) || origin === new URL(request.url).origin;
}

function settingsRedirect(request: Request, notice: PaymentsNotice, reason?: PaymentsErrorReason): NextResponse {
  const target = new URL("/settings", requestOrigin(request));
  target.searchParams.set("payments", notice);
  if (reason) target.searchParams.set("reason", reason);
  return NextResponse.redirect(target, 303);
}

function pathRedirect(request: Request, path: "/login" | "/onboarding"): NextResponse {
  return NextResponse.redirect(new URL(path, requestOrigin(request)), 303);
}

/** Onboarding links must point at Stripe over HTTPS - never follow anything else. */
function isStripeOnboardingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "stripe.com" || url.hostname.endsWith(".stripe.com"));
  } catch {
    return false;
  }
}

async function authorizeAdmin(request: Request, deps: ConnectRouteDeps): Promise<{ ok: true; organizationId: string; paymentStatus: OrganizationPaymentStatus } | { ok: false; response: NextResponse }> {
  const session = await deps.resolveSession();
  if (session.kind === "unauthenticated") return { ok: false, response: pathRedirect(request, "/login") };
  if (session.kind === "no_organization") return { ok: false, response: pathRedirect(request, "/onboarding") };
  if (session.role !== "owner" && session.role !== "admin") return { ok: false, response: settingsRedirect(request, "error", "not_authorized") };
  return { ok: true, organizationId: session.organizationId, paymentStatus: session.paymentStatus };
}

export async function handleConnectStart(request: Request, deps: ConnectRouteDeps): Promise<NextResponse> {
  if (request.method !== "POST" || !isSameOriginPost(request)) return settingsRedirect(request, "error", "invalid_request");

  const auth = await authorizeAdmin(request, deps);
  if (!auth.ok) return auth.response;
  if (auth.paymentStatus !== "active") return settingsRedirect(request, "error", "subscription_inactive");

  const origin = requestOrigin(request);
  const link = await createConnectOnboardingLink(
    deps.createService(),
    auth.organizationId,
    { returnUrl: `${origin}${CONNECT_RETURN_PATH}`, refreshUrl: `${origin}${CONNECT_REFRESH_PATH}` },
    { stripe: deps.stripe },
  );
  if (!link.ok) return settingsRedirect(request, "error", "stripe_unavailable");
  if (!isStripeOnboardingUrl(link.data.url)) {
    console.error("[payments][connect] refusing a non-Stripe onboarding URL", { organizationId: auth.organizationId });
    return settingsRedirect(request, "error", "stripe_unavailable");
  }

  return NextResponse.redirect(link.data.url, 303);
}

export async function handleConnectReturn(request: Request, deps: ConnectRouteDeps): Promise<NextResponse> {
  const auth = await authorizeAdmin(request, deps);
  if (!auth.ok) return auth.response;

  const service = deps.createService();
  const current = await getOrganizationConnectStatus(service, auth.organizationId);
  if (!current?.accountId) return settingsRedirect(request, "error", "not_connected");

  const synced = await syncConnectAccountStatus(service, auth.organizationId, { stripe: deps.stripe });
  if (!synced.ok) return settingsRedirect(request, "error", "sync_failed");

  return settingsRedirect(request, describeConnectState(synced.data) === "enabled" ? "connected" : "incomplete");
}

/** A top-level document navigation: when the browser sends Fetch Metadata, it must say so. Refuses fetch/XHR, iframes, images and scripts. */
export function isTopLevelNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode");
  const dest = request.headers.get("sec-fetch-dest");
  if (mode && mode !== "navigate") return false;
  if (dest && dest !== "document") return false;
  return true;
}

export async function handleConnectRefresh(request: Request, deps: ConnectRouteDeps): Promise<NextResponse> {
  if (request.method !== "GET" || !isTopLevelNavigation(request)) return settingsRedirect(request, "error", "invalid_request");

  const auth = await authorizeAdmin(request, deps);
  if (!auth.ok) return auth.response;
  if (auth.paymentStatus !== "active") return settingsRedirect(request, "error", "subscription_inactive");

  const origin = requestOrigin(request);
  const link = await refreshConnectOnboardingLink(
    deps.createService(),
    auth.organizationId,
    { returnUrl: `${origin}${CONNECT_RETURN_PATH}`, refreshUrl: `${origin}${CONNECT_REFRESH_PATH}` },
    { stripe: deps.stripe },
  );
  if (!link.ok) return settingsRedirect(request, "error", link.code === "not_connected" ? "not_connected" : "stripe_unavailable");
  if (!isStripeOnboardingUrl(link.data.url)) {
    console.error("[payments][connect] refusing a non-Stripe onboarding URL", { organizationId: auth.organizationId });
    return settingsRedirect(request, "error", "stripe_unavailable");
  }

  return NextResponse.redirect(link.data.url, 303);
}
