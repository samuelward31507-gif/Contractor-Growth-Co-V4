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
    // App-shell fix: this used to be `h-dvh` with no overflow containment,
    // so the whole document (sidebar included) scrolled together, and the
    // sidebar disappeared the moment any page's content ran past one
    // viewport. `overflow-hidden` here caps the shell at exactly the
    // viewport height; `overflow-y-auto` on <main> below is the one region
    // allowed to scroll, so the sidebar/mobile header/top bar - all siblings
    // of <main>, never inside it - simply never move. The bounded height
    // this produces is also what the Conversations route's own
    // internally-scrolling message thread relies on (see its layout.tsx).
    <div className="flex h-dvh overflow-hidden bg-white">
      <Sidebar organizationName={organizationName} userEmail={user.email ?? ""} role={membership.role} showAgencyLink={showAgencyLink} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MobileNav organizationName={organizationName} userEmail={user.email ?? ""} role={membership.role} showAgencyLink={showAgencyLink} />
        <TopBar supabase={supabase} organizationId={membership.organizationId} />
        {/* The only scrolling region in the shell - sidebar, mobile header,
            and top bar all sit outside this element, so they stay in place
            while a page's own content scrolls independently beneath them. */}
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
