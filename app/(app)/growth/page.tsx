import { redirect } from "next/navigation";
import { Star } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/lib/ui/page-header";
import { EmptyState } from "@/lib/ui/empty-state";

/**
 * Trackpr 2.0, Phase 1 (navigation/IA): the smallest safe placeholder for
 * the new Reviews & Referrals destination - see app/(app)/opportunities/page.tsx's
 * own header comment for the identical reasoning. The real review/referral
 * lifecycle data (lib/reviews-referrals/queries.ts) is real and
 * production-tested and already visible today inside Contact Detail and
 * Analytics; a dedicated, actionable Growth surface for it is Phase 7's job
 * (Master Product Specification Part 13/26), not Phase 1's. This page
 * fetches nothing and fabricates nothing.
 */
export default async function GrowthPage() {
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
      <PageHeader eyebrow="Growth" title="Reviews & Referrals" description="Who to ask for a review or referral right now, and who's due for reactivation." />
      <EmptyState
        icon={Star}
        title="Coming soon"
        description="A dedicated view of pending review requests, referral opportunities, and dormant customers to reactivate is on its way. In the meantime, review/referral status is still visible on each customer's own page and in Analytics."
      />
    </div>
  );
}
