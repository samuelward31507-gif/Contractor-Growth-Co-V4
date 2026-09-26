import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { filterJobs, getJobs, summarizeJobs, type JobStatus } from "@/lib/jobs/queries";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { getReviewRequests, getReferralRequests, summarizeReviewRequests, summarizeReferralRequests } from "@/lib/reviews-referrals/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { Panel } from "@/lib/ui/section-card";
import { JobsEmptyState } from "./_components/jobs-empty-state";
import { JobsSummary } from "./_components/jobs-summary";
import { ReviewReferralSummaryRow } from "./_components/review-referral-summary";
import { JobsTable } from "./_components/jobs-table";
import { JobsToolbar } from "./_components/jobs-toolbar";
import { AddJobButton } from "./_components/add-job-button";

const VALID_STATUSES = new Set<string>(["scheduled", "in_progress", "completed", "cancelled"]);

function normalizeStatus(value: string | undefined): JobStatus | "all" {
  return value && VALID_STATUSES.has(value) ? (value as JobStatus) : "all";
}

/**
 * Trackpr 2.0, Phase 3E: the header now reads "Estimates & Jobs" with a
 * "Jobs" badge - the literal /jobs URL permanently redirects to
 * /work?type=jobs (next.config.ts) before Next.js would ever resolve this
 * file directly, so this component is only ever rendered through the
 * /work dispatcher now. See estimates/page.tsx's own comment for the full
 * reasoning shared by both.
 */
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

  const [allJobs, reviewRequests, referralRequests, contacts, leads] = await Promise.all([
    getJobs(supabase, membership.organizationId),
    getReviewRequests(supabase, membership.organizationId),
    getReferralRequests(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
  ]);

  const summary = summarizeJobs(allJobs);
  const reviewReferralSummary = { ...summarizeReviewRequests(reviewRequests), ...summarizeReferralRequests(referralRequests) };
  const filtered = filterJobs(allJobs, { query, status });
  const hasActiveFilters = Boolean(query.trim()) || status !== "all";

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Operate"
        title="Estimates & Jobs"
        description="Track work from an accepted estimate through completion."
        badge={<span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">Jobs</span>}
        action={
          <div className="flex items-center gap-4">
            <Link
              href="/work"
              className="rounded text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              View estimates
            </Link>
            <AddJobButton contacts={contacts} leads={leads} />
          </div>
        }
      />

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
