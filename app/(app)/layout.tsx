import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { MobileNav } from "./_components/mobile-nav";
import { Sidebar } from "./_components/sidebar";

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

  return (
    <div className="flex flex-1 bg-slate-50">
      <Sidebar organizationName={organizationName} userEmail={user.email ?? ""} role={membership.role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav organizationName={organizationName} userEmail={user.email ?? ""} role={membership.role} />
        <main className="flex flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
