import { redirect } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { filterEstimates, getEstimatesResult, summarizeEstimates, ESTIMATE_STATUSES, type EstimateStatus } from "@/lib/estimates/queries";
import { filterJobs, getJobsResult, summarizeJobs, JOB_STATUSES, type JobStatus } from "@/lib/jobs/queries";
import { getReviewRequestsResult, getReferralRequestsResult, summarizeReviewRequests, summarizeReferralRequests } from "@/lib/reviews-referrals/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { Panel } from "@/lib/ui/section-card";
import { sectionLabelClass } from "@/lib/ui/typography";
import { AddEstimateButton } from "../estimates/_components/add-estimate-button";
import { EstimatesEmptyState } from "../estimates/_components/estimates-empty-state";
import { EstimatesSummary } from "../estimates/_components/estimates-summary";
import { EstimatesTable } from "../estimates/_components/estimates-table";
import { EstimatesToolbar } from "../estimates/_components/estimates-toolbar";
import { AddJobButton } from "../jobs/_components/add-job-button";
import { JobsEmptyState } from "../jobs/_components/jobs-empty-state";
import { JobsSummary } from "../jobs/_components/jobs-summary";
import { JobsTable } from "../jobs/_components/jobs-table";
import { JobsToolbar } from "../jobs/_components/jobs-toolbar";
import { ReviewReferralSummaryRow } from "../jobs/_components/review-referral-summary";
import { WorkTabs, type WorkTab } from "./_components/work-tabs";
import { NeedsToMoveQueue, buildNeedsToMoveQueue } from "./_components/needs-to-move-queue";

function normalizeTab(value: string | undefined): WorkTab {
  if (value === "jobs") return "jobs";
  if (value === "estimates") return "estimates";
  return "needs-to-move";
}

function normalizeEstimateStatus(value: string | undefined): EstimateStatus | "all" {
  return value && ESTIMATE_STATUSES.some((s) => s.value === value) ? (value as EstimateStatus) : "all";
}

function normalizeJobStatus(value: string | undefined): JobStatus | "all" {
  return value && JOB_STATUSES.some((s) => s.value === value) ? (value as JobStatus) : "all";
}

/**
 * Usability audit fix (#5, Work real tabs + Needs-to-move): replaces the
 * former Phase-0 dispatcher (which rendered either the old standalone
 * EstimatesPage or JobsPage component depending on a `type` param, each
 * with its own header identity, auth check, and data fetch) with one real
 * page - a single auth check, a single data fetch, and a real in-page tab
 * control (WorkTabs) under one persistent "Estimates & Jobs" header. Every
 * table/toolbar/summary/empty-state/add-button below is the exact existing
 * component the old EstimatesPage/JobsPage already used, unchanged - only
 * composition moved. `type=estimates` / `type=jobs` (the legacy redirect
 * targets from next.config.ts's /estimates and /jobs rules) keep working
 * exactly as before, now selecting a tab instead of a whole different page.
 */
export default async function WorkPage({ searchParams }: PageProps<"/work">) {
  const params = await searchParams;
  const tab = normalizeTab(typeof params.type === "string" ? params.type : undefined);
  const query = typeof params.q === "string" ? params.q : "";
  const estimateStatus = normalizeEstimateStatus(typeof params.status === "string" ? params.status : undefined);
  const jobStatus = normalizeJobStatus(typeof params.status === "string" ? params.status : undefined);

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

  const [estimatesResult, jobsResult, reviewRequestsResult, referralRequestsResult, contacts, leads] = await Promise.all([
    getEstimatesResult(supabase, membership.organizationId),
    getJobsResult(supabase, membership.organizationId),
    getReviewRequestsResult(supabase, membership.organizationId),
    getReferralRequestsResult(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
  ]);
  const allEstimates = estimatesResult.data;
  const allJobs = jobsResult.data;
  const failed = estimatesResult.failed || jobsResult.failed || reviewRequestsResult.failed || referralRequestsResult.failed;

  const estimateSummary = summarizeEstimates(allEstimates);
  const jobSummary = summarizeJobs(allJobs);
  const reviewReferralSummary = { ...summarizeReviewRequests(reviewRequestsResult.data), ...summarizeReferralRequests(referralRequestsResult.data) };

  const filteredEstimates = filterEstimates(allEstimates, { query, status: estimateStatus });
  const hasActiveEstimateFilters = Boolean(query.trim()) || estimateStatus !== "all";

  const filteredJobs = filterJobs(allJobs, { query, status: jobStatus });
  const hasActiveJobFilters = Boolean(query.trim()) || jobStatus !== "all";

  const needsToMoveItems = buildNeedsToMoveQueue(allEstimates, allJobs, reviewRequestsResult.data);

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Operate"
        title="Estimates & Jobs"
        description="What needs to move, and the full estimate and job record behind it."
        action={tab === "jobs" ? <AddJobButton contacts={contacts} leads={leads} /> : <AddEstimateButton contacts={contacts} leads={leads} />}
      />

      {failed ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some information is temporarily unavailable. Please try again.</p>
        </div>
      ) : null}

      <WorkTabs active={tab} needsToMoveCount={needsToMoveItems.length} />

      {tab === "needs-to-move" ? (
        <div>
          <p className={sectionLabelClass}>What needs to move</p>
          <Panel className="mt-3 p-0">
            <NeedsToMoveQueue items={needsToMoveItems} />
          </Panel>
        </div>
      ) : null}

      {tab === "estimates" ? (
        <>
          <EstimatesSummary summary={estimateSummary} />
          {allEstimates.length === 0 ? (
            <EstimatesEmptyState contacts={contacts} leads={leads} />
          ) : (
            <Panel>
              <EstimatesToolbar initialQuery={query} initialStatus={estimateStatus} extraParams={{ type: "estimates" }} />
              <div className="mt-5">
                <EstimatesTable estimates={filteredEstimates} hasActiveFilters={hasActiveEstimateFilters} />
              </div>
            </Panel>
          )}
        </>
      ) : null}

      {tab === "jobs" ? (
        <>
          <JobsSummary summary={jobSummary} />
          <ReviewReferralSummaryRow summary={reviewReferralSummary} />
          {allJobs.length === 0 ? (
            <JobsEmptyState contacts={contacts} leads={leads} />
          ) : (
            <Panel>
              <JobsToolbar initialQuery={query} initialStatus={jobStatus} extraParams={{ type: "jobs" }} />
              <div className="mt-5">
                <JobsTable jobs={filteredJobs} hasActiveFilters={hasActiveJobFilters} />
              </div>
            </Panel>
          )}
        </>
      ) : null}
    </div>
  );
}
