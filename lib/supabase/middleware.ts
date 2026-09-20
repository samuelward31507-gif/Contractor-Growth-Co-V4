import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getUserOrganization } from "@/lib/auth/organization";

const AUTH_PATHS = new Set(["/login", "/signup"]);

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

  // Refreshes the auth session if it has expired. Required so Server
  // Components can read a valid session via cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // The public marketing site (home + its sub-pages), the email-confirmation
  // callback, and API routes stay public and untouched regardless of auth
  // state. API routes (e.g. the n8n callback) authenticate themselves - n8n
  // never presents a Supabase session, so redirecting them to /login would
  // make those routes unreachable by design rather than by any check they
  // actually perform.
  const PUBLIC_MARKETING_PATHS = new Set(["/", "/how-it-works", "/services", "/get-started"]);
  if (PUBLIC_MARKETING_PATHS.has(pathname) || pathname.startsWith("/auth") || pathname.startsWith("/api/")) {
    return supabaseResponse;
  }

  if (!user) {
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
  // verified auth.uid(). No business authorization logic lives here.
  const membership = await getUserOrganization(supabase, user.id);

  if (AUTH_PATHS.has(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = membership ? "/dashboard" : "/onboarding";
    return NextResponse.redirect(url);
  }

  if (pathname === "/onboarding") {
    if (membership) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }
    return supabaseResponse;
  }

  if (!membership) {
    const url = request.nextUrl.clone();
    url.pathname = "/onboarding";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
