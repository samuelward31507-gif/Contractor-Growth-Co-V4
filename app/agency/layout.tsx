import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAgencyAdmin } from "@/lib/agency/queries";
import { isFounder } from "@/lib/founder/access";
import { OperatorShell } from "@/lib/ui/operator-shell/operator-shell";
import { AGENCY_NAV_GROUP, FOUNDER_NAV_GROUP } from "@/lib/ui/operator-shell/nav";

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
 * Root cause of "the old UI still appears here": /agency sits outside the
 * (app) route group, so it never inherited the client app's final shell
 * (the dark pine-ink sidebar, the workspace-gray header, the mobile menu) -
 * it kept its own earlier light sidebar. It now renders the shared
 * OperatorShell (lib/ui/operator-shell), built from the same tokens and
 * row treatment as app/(app)/_components/sidebar-content.tsx, so the two
 * shells can't drift apart again.
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

  // A founder also sees the Founder Command Center group - a display
  // convenience only; /founder enforces founder access on every request.
  const founder = await isFounder(supabase);
  const groups = founder ? [AGENCY_NAV_GROUP, FOUNDER_NAV_GROUP] : [AGENCY_NAV_GROUP];

  return (
    <OperatorShell title="Agency Command Center" groups={groups} userEmail={userEmail} roleLabel={isAdmin ? "Agency admin" : "Not an agency admin"}>
      {children}
    </OperatorShell>
  );
}
