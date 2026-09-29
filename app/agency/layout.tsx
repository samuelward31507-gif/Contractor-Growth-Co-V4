import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAgencyAdmin } from "@/lib/agency/queries";
import { AgencySidebar } from "./_components/agency-sidebar";
import { AgencyMobileNav } from "./_components/agency-mobile-nav";

/**
 * Agency Command Center UI review: this layout's authorization gate is
 * completely unchanged from before this task - it still only enforces the
 * baseline "must be signed in" check, matching app/(app)/layout.tsx's own
 * pattern, and still deliberately does NOT check agency-admin status itself.
 * That check still happens server-side, per page, via the real backend
 * (lib/agency/queries.ts's resolveAgencyOrganizations) - never reimplemented
 * or approximated here or in client JavaScript. A signed-in user who is not
 * an agency admin still reaches the page component inside this shell, which
 * renders a clean unauthorized state instead of any organization data - the
 * shell itself carries no organization data and is safe to render for
 * anyone merely signed in.
 *
 * What changed is purely visual: this surface previously had no sidebar at
 * all. It now uses the exact same dark-shell structure as
 * app/(app)/layout.tsx (Sidebar + MobileNav + one scrolling <main>), just
 * with Agency-specific content, so navigating here from the client CRM's own
 * "Agency Command Center" link no longer drops the visual shell.
 */
export default async function AgencyLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const userEmail = user.email ?? "";

  // Purely a display label - mirrors app/(app)/layout.tsx's own showAgencyLink
  // exactly (same isAgencyAdmin() read, same "never an authorization
  // boundary" caveat). A signed-in-but-not-agency-admin user must never see
  // "Agency admin" next to their own email, since they are not one - the
  // page they land on already tells them so via UnauthorizedState.
  const isAdmin = await isAgencyAdmin(supabase);

  return (
    // Trackpr 2.0 (step 2G): the same light canvas and skip link as the
    // client app's shell (app/(app)/layout.tsx).
    <div className="flex h-dvh overflow-hidden bg-canvas text-ink">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus:shadow-popover focus:outline-none focus:ring-2 focus:ring-accent/40"
      >
        Skip to content
      </a>
      <AgencySidebar userEmail={userEmail} isAdmin={isAdmin} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AgencyMobileNav userEmail={userEmail} isAdmin={isAdmin} />
        <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-y-auto focus:outline-none">{children}</main>
      </div>
    </div>
  );
}
