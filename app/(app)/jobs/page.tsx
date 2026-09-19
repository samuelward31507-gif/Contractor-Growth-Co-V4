import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { filterJobs, getJobs, summarizeJobs, type JobStatus } from "@/lib/jobs/queries";
import { getReviewRequests, getReferralRequests, summarizeReviewRequests, summarizeReferralRequests } from "@/lib/reviews-referrals/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { JobsEmptyState } from "./_components/jobs-empty-state";
import { JobsSummary } from "./_components/jobs-summary";
import { ReviewReferralSummaryRow } from "./_components/review-referral-summary";
import { JobsTable } from "./_components/jobs-table";
import { JobsToolbar } from "./_components/jobs-toolbar";

const VALID_STATUSES = new Set<string>(["scheduled", "in_progress", "completed", "cancelled"]);

function normalizeStatus(value: string | undefined): JobStatus | "all" {
  return value && VALID_STATUSES.has(value) ? (value as JobStatus) : "all";
}

export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const status = normalizeStatus(typeof params.status === "string" ? params.status : undefined);

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

  const [allJobs, reviewRequests, referralRequests] = await Promise.all([
    getJobs(supabase, membership.organizationId),
    getReviewRequests(supabase, membership.organizationId),
    getReferralRequests(supabase, membership.organizationId),
  ]);

  const summary = summarizeJobs(allJobs);
  const reviewReferralSummary = { ...summarizeReviewRequests(reviewRequests), ...summarizeReferralRequests(referralRequests) };
  const filtered = filterJobs(allJobs, { query, status });
  const hasActiveFilters = Boolean(query.trim()) || status !== "all";

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader title="Jobs" description="Track work from an accepted estimate through completion." />

      <JobsSummary summary={summary} />
      <ReviewReferralSummaryRow summary={reviewReferralSummary} />

      {allJobs.length === 0 ? (
        <JobsEmptyState />
      ) : (
        <div className="border-t border-slate-200 pt-8">
          <JobsToolbar initialQuery={query} initialStatus={status} />
          <div className="mt-5">
            <JobsTable jobs={filtered} hasActiveFilters={hasActiveFilters} />
          </div>
        </div>
      )}
    </div>
  );
}
