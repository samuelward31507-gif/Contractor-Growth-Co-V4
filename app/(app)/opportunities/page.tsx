import { redirect } from "next/navigation";
import { Target } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/lib/ui/page-header";
import { EmptyState } from "@/lib/ui/empty-state";

/**
 * Trackpr 2.0, Phase 1 (navigation/IA): the smallest safe placeholder for
 * the new Opportunities destination the locked navigation now points to.
 * Unlike Phase 0's dispatcher pages (Customers/Schedule/Work), there is no
 * existing real page to delegate to here - the Opportunity Engine's data
 * (lib/opportunities/queries.ts's getOpenOpportunities) is real and
 * production-tested, but no dedicated UI for it has ever existed; building
 * that real UI is explicitly Phase 6's job (Master Product Specification
 * Part 12/26), not Phase 1's. This page deliberately fetches nothing and
 * fabricates nothing - it exists only so the new, visible nav item does not
 * 404, matching the exact "smallest possible safe placeholder, do not
 * introduce fake data, do not make a fake polished page" standard Phase 0
 * already established and was audited/approved under.
 */
export default async function OpportunitiesPage() {
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

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader eyebrow="Growth" title="Opportunities" description="Recoverable revenue Trackpr has detected across your business." />
      <EmptyState
        icon={Target}
        title="Coming soon"
        description="A dedicated view of every open opportunity - uncontacted leads, stale estimates, dormant customers, and more - is on its way. In the meantime, open opportunities are still visible on your Dashboard and on each customer's own page."
      />
    </div>
  );
}
