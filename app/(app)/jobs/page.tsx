import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { AlertCircle } from "lucide-react";
import { filterJobs, getJobsResult, summarizeJobs, type JobStatus } from "@/lib/jobs/queries";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { getReviewRequestsResult, getReferralRequestsResult, summarizeReviewRequests, summarizeReferralRequests } from "@/lib/reviews-referrals/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { Panel } from "@/lib/ui/section-card";
import { JobsEmptyState } from "./_components/jobs-empty-state";
import { JobsSummary } from "./_components/jobs-summary";
import { ReviewReferralSummaryRow } from "./_components/review-referral-summary";
import { JobsTable } from "./_components/jobs-table";
import { JobsToolbar } from "./_components/jobs-toolbar";
import { AddJobButton } from "./_components/add-job-button";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

const VALID_STATUSES = new Set<string>(["scheduled", "in_progress", "completed", "cancelled"]);

function normalizeStatus(value: string | undefined): JobStatus | "all" {
  return value && VALID_STATUSES.has(value) ? (value as JobStatus) : "all";
}

/**
 * Nav-restructure pass: Jobs is a real, independent nav destination again
 * (see app/(app)/_components/nav-items.ts's own header comment) - the
 * literal /jobs URL is no longer redirected anywhere, so this file renders
 * directly, under its own name. See estimates/page.tsx's own comment for
 * the full reasoning shared by both.
 */
export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const status = normalizeStatus(typeof params.status === "string" ? params.status : undefined);

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  const [jobsResult, reviewRequestsResult, referralRequestsResult, contacts, leads] = await Promise.all([
    getJobsResult(supabase, membership.organizationId),
    getReviewRequestsResult(supabase, membership.organizationId),
    getReferralRequestsResult(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
  ]);
  const allJobs = jobsResult.data;
  // Trackpr 2.0, Phase 4C (P2 #1 + P2 #2): a real Postgrest error on any of
  // these three reads must never render as "no jobs yet" / a zeroed review
  // & referral summary row - see getJobsResult's own comment in
  // lib/jobs/queries.ts and getReviewRequestsResult's in
  // lib/reviews-referrals/queries.ts.
  const failed = jobsResult.failed || reviewRequestsResult.failed || referralRequestsResult.failed;

  const summary = summarizeJobs(allJobs);
  const reviewReferralSummary = { ...summarizeReviewRequests(reviewRequestsResult.data), ...summarizeReferralRequests(referralRequestsResult.data) };
  const filtered = filterJobs(allJobs, { query, status });
  const hasActiveFilters = Boolean(query.trim()) || status !== "all";

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader
        eyebrow="Money"
        title="Jobs"
        description="Track work from an accepted estimate through completion."
        action={
          <div className="flex items-center gap-4">
            <Link
              href="/estimates"
              className="inline-flex min-h-11 items-center rounded text-sm font-medium text-ink-3 transition-colors hover:text-ink sm:min-h-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              View estimates
            </Link>
            <AddJobButton contacts={contacts} leads={leads} />
          </div>
        }
      />

      {failed ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some information is temporarily unavailable. Please try again.</p>
        </div>
      ) : null}

      <JobsSummary summary={summary} />
      <ReviewReferralSummaryRow summary={reviewReferralSummary} />

      {allJobs.length === 0 ? (
        <JobsEmptyState contacts={contacts} leads={leads} />
      ) : (
        <Panel>
          <JobsToolbar initialQuery={query} initialStatus={status} />
          <div className="mt-5">
            <JobsTable jobs={filtered} hasActiveFilters={hasActiveFilters} />
          </div>
        </Panel>
      )}
    </div>
  );
}
