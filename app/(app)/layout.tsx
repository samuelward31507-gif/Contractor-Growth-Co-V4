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
    <div className="flex flex-1 bg-white">
      <Sidebar organizationName={organizationName} userEmail={user.email ?? ""} role={membership.role} showAgencyLink={showAgencyLink} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MobileNav organizationName={organizationName} userEmail={user.email ?? ""} role={membership.role} showAgencyLink={showAgencyLink} />
        <TopBar supabase={supabase} organizationId={membership.organizationId} />
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
