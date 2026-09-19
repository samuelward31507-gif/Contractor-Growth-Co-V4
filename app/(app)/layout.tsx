import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { isAgencyAdmin } from "@/lib/agency/queries";
import { MobileNav } from "./_components/mobile-nav";
import { Sidebar } from "./_components/sidebar";
import { TopBar } from "./_components/top-bar";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  const organizationName = membership.organizationName ?? "Your business";

  // Resolved once, here, for the whole authenticated shell - the Agency nav
  // link is only ever shown to a session-verified agency admin (never
  // unconditionally), and /agency itself independently re-verifies this on
  // every request regardless of what the nav shows.
  const showAgencyLink = await isAgencyAdmin(supabase);

  return (
    // Release-audit fix: the root layout's <body> only has min-h-full (a
    // minimum, not a definite height), so nothing in the flex-1/min-h-0
    // chain below it ever resolved to a real, bounded height - most pages
    // never needed one (plain document flow, verified fine), but the
    // Conversations route's internally-scrolling message thread does. Its
    // own layout.tsx wraps that chain in overflow-hidden, so instead of
    // "no scroll, page just grows" (harmless), an unresolved height there
    // silently collapsed the whole thread + composer to zero visible
    // height - real DOM content, completely invisible. h-dvh here gives
    // the whole authenticated shell one real, viewport-bound height to
    // compute against, scoped to just this layout (not the public/auth
    // routes) - other pages are unaffected since nothing else in their
    // ancestor chain clips overflow, so a page taller than the viewport
    // still scrolls normally at the document level.
    <div className="flex h-dvh bg-white">
      <Sidebar organizationName={organizationName} userEmail={user.email ?? ""} role={membership.role} showAgencyLink={showAgencyLink} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MobileNav organizationName={organizationName} userEmail={user.email ?? ""} role={membership.role} showAgencyLink={showAgencyLink} />
        <TopBar supabase={supabase} organizationId={membership.organizationId} />
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
