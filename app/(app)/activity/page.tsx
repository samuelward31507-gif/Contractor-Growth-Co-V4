import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import {
  ACTIVITY_PAGE_SIZE,
  getActivityEntries,
  getActivitySummary,
} from "@/lib/activity/queries";
import { ActivityEmptyState } from "./_components/activity-empty-state";
import { ActivitySummaryCards } from "./_components/activity-summary";
import { ActivityTimeline } from "./_components/activity-timeline";
import { ActivityToolbar } from "./_components/activity-toolbar";

export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const entityType = typeof params.entityType === "string" ? params.entityType : "all";
  const from = typeof params.from === "string" ? params.from : "";
  const to = typeof params.to === "string" ? params.to : "";
  const requestedLimit = typeof params.limit === "string" ? Number.parseInt(params.limit, 10) : NaN;
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, ACTIVITY_PAGE_SIZE * 10)
      : ACTIVITY_PAGE_SIZE;

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

  const [summary, activityPage] = await Promise.all([
    getActivitySummary(supabase, membership.organizationId),
    getActivityEntries(supabase, membership.organizationId, { query, entityType, from, to }, limit),
  ]);

  const hasActiveFilters = Boolean(query.trim()) || entityType !== "all" || Boolean(from) || Boolean(to);

  const loadMoreParams = new URLSearchParams();
  if (query.trim()) loadMoreParams.set("q", query.trim());
  if (entityType !== "all") loadMoreParams.set("entityType", entityType);
  if (from) loadMoreParams.set("from", from);
  if (to) loadMoreParams.set("to", to);
  loadMoreParams.set("limit", String(limit + ACTIVITY_PAGE_SIZE));
  const loadMoreHref = `/activity?${loadMoreParams.toString()}`;

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Activity</h1>
        <p className="mt-1 text-sm text-slate-500">
          A history of important actions and events across your business.
        </p>
      </div>

      <ActivitySummaryCards summary={summary} />

      {summary.total === 0 ? (
        <ActivityEmptyState />
      ) : (
        <>
          <ActivityToolbar
            initialQuery={query}
            initialEntityType={entityType}
            initialFrom={from}
            initialTo={to}
          />
          <ActivityTimeline
            entries={activityPage.entries}
            currentUserId={user.id}
            hasActiveFilters={hasActiveFilters}
            hasMore={activityPage.hasMore}
            loadMoreHref={loadMoreHref}
          />
        </>
      )}
    </div>
  );
}
