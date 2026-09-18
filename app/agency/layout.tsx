import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Agency Command Center - a separate, agency-only surface, deliberately not
 * nested under app/(app)/ - it monitors client organizations, it is not a
 * client workspace, so it does not use the client sidebar/nav shell.
 *
 * This layout only enforces the baseline "must be signed in" gate, matching
 * app/(app)/layout.tsx's own pattern. It deliberately does NOT check agency
 * -admin status itself: that check happens server-side, per page, via the
 * real backend (lib/agency/queries.ts's resolveAgencyOrganizations, the same
 * function every agency data read goes through) - never reimplemented or
 * approximated here or in client JavaScript. A signed-in user who is not an
 * agency admin still reaches the page component, which renders a clean
 * unauthorized state instead of any organization data.
 */
export default async function AgencyLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <div className="min-h-full flex-1 bg-white">{children}</div>;
}
