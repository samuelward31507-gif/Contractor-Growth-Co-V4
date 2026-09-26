import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { syncOpportunities } from "@/lib/opportunities/detect";
import { getOpenOpportunities, summarizeOpportunities } from "@/lib/opportunities/queries";
import { formatCurrency } from "@/lib/dashboard/format";
import { PageHeader } from "@/lib/ui/page-header";
import { metaClass } from "@/lib/ui/typography";
import { OpportunitiesList } from "./_components/opportunities-list";

/**
 * Trackpr 2.0, Phase 3F: the real Opportunities surface, replacing the
 * Phase 1 "Coming soon" placeholder. This page owns zero opportunity
 * business logic of its own - it is a pure consumer of the existing
 * Opportunity Engine:
 *
 *   - syncOpportunities (lib/opportunities/detect.ts) is the exact same,
 *     unmodified function app/(app)/dashboard/page.tsx already calls before
 *     reading opportunities - reused here for the identical reason (a
 *     direct visit to this page, without having loaded Dashboard first,
 *     must not see stale detection results). This is invoking the existing
 *     Engine, not reimplementing it - the detection/dedup/resolve/dismiss-
 *     suppression logic inside it is completely untouched.
 *   - getOpenOpportunities/summarizeOpportunities (lib/opportunities/
 *     queries.ts) are the exact same reads Dashboard's own Business Glance
 *     and Attention Engine already use - no new query, no new table, no new
 *     column.
 *   - DismissOpportunityButton (reused directly from
 *     app/(app)/dashboard/_components/) calls the exact same, unmodified
 *     dismissOpportunity Server Action Dashboard already uses - dismissal
 *     persistence is not duplicated here.
 *
 * No search/filter/sort was added - per this phase's own instruction, none
 * of those capabilities exist for opportunities today, and grouping the
 * complete, already-loaded set by type (see OpportunitiesList) already
 * gives a long list real scannability without inventing query architecture
 * for a first version of this page.
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

  await syncOpportunities(supabase, membership.organizationId);
  const openOpportunities = await getOpenOpportunities(supabase, membership.organizationId);
  const summary = summarizeOpportunities(openOpportunities);

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Growth"
        title="Opportunities"
        description="Revenue opportunities and customer follow-up that need attention."
        badge={
          summary.count > 0 ? (
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-slate-600">{summary.count}</span>
          ) : undefined
        }
      />

      {/* A plain summary line, not a KPI card grid - the same two real,
          already-computed numbers Dashboard's own Business Glance already
          shows (summarizeOpportunities is a pure function over the same
          data this page already fetched), stated once in text rather than
          as a second set of boxed metrics competing with the queue below. */}
      {summary.count > 0 ? (
        <p className={metaClass}>
          {summary.knownEstimatedValue > 0 ? `${formatCurrency(summary.knownEstimatedValue)} in known value` : "No known dollar value yet"}
          {summary.unknownValueCount > 0 ? ` · ${summary.unknownValueCount} with unknown value` : ""}
        </p>
      ) : null}

      <OpportunitiesList opportunities={openOpportunities} />
    </div>
  );
}
