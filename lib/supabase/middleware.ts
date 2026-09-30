import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getUserOrganization } from "@/lib/auth/organization";

const AUTH_PATHS = new Set(["/login", "/signup", "/forgot-password"]);

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the auth session if it has expired (getClaims reads the session
  // through getSession, which refreshes and rewrites the cookies exactly as
  // getUser did). Required so Server Components can read a valid session via
  // cookies.
  //
  // getClaims verifies the access token's signature and expiry locally
  // against the project's cached JWKS for asymmetric keys (production signs
  // with ES256), so the middleware no longer makes its own /auth/v1/user
  // round trip on every request. For a symmetric (HS*) token, a token
  // without a kid, or an unknown kid, auth-js falls back to getUser(), so
  // those still get the network check. This routing layer is not the
  // authorization boundary: every protected page tree, server action and
  // API route still resolves the user with the revocation-aware getUser()
  // itself (lib/auth/request-context.ts and friends), and RLS verifies the
  // JWT on every query.
  const { data: claimsData } = await supabase.auth.getClaims();
  const sub = claimsData?.claims?.sub;
  const userId = typeof sub === "string" && sub.length > 0 ? sub : null;

  const { pathname } = request.nextUrl;

  // The public marketing site (home + its sub-pages), its SEO-facing
  // metadata routes (robots.txt/sitemap.xml - anonymous crawlers never
  // present a Supabase session either, same reasoning as the API-routes
  // exemption below), the email-confirmation callback, and API routes stay
  // public and untouched regardless of auth state. API routes (e.g. the n8n
  // callback) authenticate themselves - n8n never presents a Supabase
  // session, so redirecting them to /login would make those routes
  // unreachable by design rather than by any check they actually perform.
  // /demo is the public, read-only interactive sales demo (app/demo/page.tsx)
  // - a startsWith check like /auth and /api/, not a PUBLIC_MARKETING_PATHS
  // entry, since it is its own self-contained public route family, not part
  // of the marketing site. It requires no session, touches no backend/
  // Supabase data, and must be reachable by a prospect who has never logged
  // in - without this, every demo link would silently redirect to /login.
  // /quote is the public estimate-approval surface (app/quote/[token]) - the
  // customer opening it from a follow-up text has no session by definition,
  // and the page authorizes itself by resolving the unguessable
  // approval_token (see lib/estimates/approval.ts), the same trust model as
  // the /api/leads/capture/[token] intake route this block already exempts
  // via the /api/ prefix.
  // /pay/ is the public invoice payment page (app/pay/[token], Phase 1C) -
  // the same trust model as /quote: the customer has no session, and the
  // page authorizes itself by resolving the unguessable payment_token (see
  // lib/payments/public-invoice.ts). "/pay/" with the slash, so no other
  // path that merely starts with "pay" becomes public.
  const PUBLIC_MARKETING_PATHS = new Set(["/", "/how-it-works", "/services", "/get-started", "/privacy", "/terms", "/robots.txt", "/sitemap.xml"]);
  if (PUBLIC_MARKETING_PATHS.has(pathname) || pathname.startsWith("/auth") || pathname.startsWith("/api/") || pathname.startsWith("/demo") || pathname.startsWith("/quote") || pathname.startsWith("/pay/")) {
    return supabaseResponse;
  }

  if (!userId) {
    if (AUTH_PATHS.has(pathname)) {
      return supabaseResponse;
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Authenticated from here on. Routing below only reflects onboarding stage
  // (auth vs. no-org vs. has-org) - never trust a client-supplied
  // organization id; it is always resolved from organization_members via the
  // verified auth.uid() (the verified JWT sub). No business authorization
  // logic lives here.
  //
  // Performance Pass B: the membership lookup is no longer run for every
  // authenticated request (including every background prefetch) - only on
  // the two branches below that actually decide something with it. Every
  // (app) route resolves membership itself and sends a user without an
  // organization to /onboarding: the (app) layout on a full load, the page
  // (or its segment layout) on every client-side navigation - enforced for
  // every (app) page by lib/supabase/middleware.membership.test.ts.
  //
  // The auth pages are the one branch that redirects a signed-in user AWAY,
  // so they keep the authoritative getUser(): a token whose session was
  // revoked (signed out elsewhere) still has a valid signature, and without
  // this check /login would send it to /today, whose layout's getUser()
  // sends it back to /login - a loop until the token expires. getUser()
  // also clears the revoked session's cookies, as the middleware always did.
  // Signed-in visits to the auth pages are rare, so this costs nothing on
  // the hot path.
  if (AUTH_PATHS.has(pathname)) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return supabaseResponse;
    }
    const membership = await getUserOrganization(supabase, user.id);
    const url = request.nextUrl.clone();
    url.pathname = membership ? "/today" : "/onboarding";
    return NextResponse.redirect(url);
  }

  // First Client Onboarding V1: /onboarding is no longer a one-shot,
  // org-creation-only page that becomes unreachable once an org exists -
  // it's now a persistent, resumable readiness hub (Steps 2-7) for an
  // organization that already exists too. The only thing that still needs
  // enforcing at this layer is auth vs. no-auth; which of the two states
  // /onboarding itself renders (the Step 1 form, or the hub) is decided by
  // app/onboarding/page.tsx from the same membership lookup, not here.
  if (pathname === "/onboarding") {
    return supabaseResponse;
  }

  // /agency is outside the (app) route group and its layout checks only the
  // session and the agency-admin flag, not an organization membership - so
  // this is still the place that sends an authenticated user without an
  // organization from /agency to /onboarding, exactly as before.
  if (pathname === "/agency" || pathname.startsWith("/agency/")) {
    const membership = await getUserOrganization(supabase, userId);
    if (!membership) {
      const url = request.nextUrl.clone();
      url.pathname = "/onboarding";
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}
