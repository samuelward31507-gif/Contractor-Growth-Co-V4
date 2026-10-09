import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAgencyAdmin } from "@/lib/agency/queries";
import { getFounderContext } from "@/lib/founder/access";
import { OperatorShell } from "@/lib/ui/operator-shell/operator-shell";
import { AGENCY_NAV_GROUP, FOUNDER_NAV_GROUP } from "@/lib/ui/operator-shell/nav";

export const metadata: Metadata = {
  title: "Founder Command Center",
  robots: { index: false, follow: false },
};

/**
 * Founder Command Center: a private workspace for the founder, outside the
 * (app) route group (it is not organization data) and outside /agency (an
 * agency admin is not automatically a founder).
 *
 * Access is enforced here AND on every page AND in every server action AND
 * by RLS (see lib/founder/access.ts). Anyone who is not an allow-listed
 * founder - including every contractor user and every agency admin not on
 * the list - gets a 404, so the area's existence isn't confirmed. Signed-out
 * visitors are sent to /login (the middleware already does this too).
 */
export default async function FounderLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const founder = await getFounderContext();
  if (!founder) notFound();

  const agencyAdmin = await isAgencyAdmin(supabase).catch(() => false);
  const groups = agencyAdmin ? [FOUNDER_NAV_GROUP, AGENCY_NAV_GROUP] : [FOUNDER_NAV_GROUP];

  return (
    <OperatorShell title="Founder Command Center" groups={groups} userEmail={founder.email} roleLabel="Founder">
      {children}
    </OperatorShell>
  );
}
