import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { isAgencyAdmin } from "@/lib/agency/queries";
import { MobileTabBar } from "./_components/mobile-tab-bar";
import { Sidebar } from "./_components/sidebar";
import { TopBar } from "./_components/top-bar";
import { getNavGroupsForVertical } from "./_components/nav-items";
import { CommandMenu } from "@/lib/ui/command-menu";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await getRequestSupabase();
  // Performance Pass B: the agency-admin check (a read-only RPC on the
  // session) doesn't depend on the membership, so it runs alongside it
  // instead of after it. Its result is still only used once the user,
  // membership and payment checks below have passed.
  const agencyAdminCheck = isAgencyAdmin(supabase).catch(() => false);
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  // Payment Gate V1: an organization existing is not the same as an
  // organization being usable. /onboarding is where the payment-required
  // state is actually explained and resolved (see its own page.tsx); this
  // is the one server-side chokepoint every route under (app)/ passes
  // through, so no individual page needs its own payment check.
  if (membership.paymentStatus !== "active") {
    redirect("/onboarding");
  }

  const organizationName = membership.organizationName ?? "Your business";

  // Resolved once, here, for the whole authenticated shell - the Agency nav
  // link is only ever shown to a session-verified agency admin (never
  // unconditionally), and /agency itself independently re-verifies this on
  // every request regardless of what the nav shows.
  const showAgencyLink = await agencyAdminCheck;

  return (
    // App-shell fix: this used to be `h-dvh` with no overflow containment,
    // so the whole document (sidebar included) scrolled together, and the
    // sidebar disappeared the moment any page's content ran past one
    // viewport. `overflow-hidden` here caps the shell at exactly the
    // viewport height; `overflow-y-auto` on <main> below is the one region
    // allowed to scroll, so the sidebar/mobile header/top bar - all siblings
    // of <main>, never inside it - simply never move. The bounded height
    // this produces is also what the Conversations route's own
    // internally-scrolling message thread relies on (see its layout.tsx).
    <div className="flex h-dvh overflow-hidden bg-canvas text-ink">
      {/* Trackpr 2.0 (step 2B): the first focusable element in the shell -
          visible only on keyboard focus - so keyboard and screen-reader users
          can jump past the navigation straight to the page. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus:shadow-popover focus:outline-none focus:ring-2 focus:ring-accent/40"
      >
        Skip to content
      </a>
      <Sidebar
        organizationName={organizationName}
        userEmail={user.email ?? ""}
        role={membership.role}
        vertical={membership.vertical}
        showAgencyLink={showAgencyLink}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar supabase={supabase} organizationId={membership.organizationId} organizationName={organizationName} />
        {/* The only scrolling region in the shell - sidebar, top bar (also
            the mobile header, step 2D) and the mobile tab bar all sit outside this element, so
            they stay in place while a page's own content scrolls
            independently beneath them. */}
        <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-y-auto focus:outline-none">
          {children}
        </main>
        <MobileTabBar vertical={membership.vertical} showAgencyLink={showAgencyLink} userEmail={user.email ?? ""} />
      </div>
      <CommandMenu navGroups={getNavGroupsForVertical(membership.vertical, showAgencyLink)} />
    </div>
  );
}
