import { redirect } from "next/navigation";
import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getJobs } from "@/lib/jobs/queries";
import { getReviewRequestsResult, getReferralRequestsResult, summarizeReviewRequests, summarizeReferralRequests } from "@/lib/reviews-referrals/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { metaClass } from "@/lib/ui/typography";
import { buildReviewRows, buildReferralRows, isReviewResolvable, isReferralResolvable } from "./_components/rows";
import { ReviewsSection } from "./_components/reviews-section";
import { ReferralsSection } from "./_components/referrals-section";

/**
 * Trackpr 2.0, Phase 3G: the real Growth surface, replacing the Phase 1
 * "Coming soon" placeholder. This page owns zero review/referral business
 * logic of its own - it is a pure consumer of the existing, already
 * production-tested lib/reviews-referrals data layer and the same
 * markReviewCompleted/markReviewDeclined/markReferralConverted/
 * markReferralDeclined Server Actions app/(app)/jobs/[id]/_components/
 * review-referral-panel.tsx already calls from the job detail page. No new
 * table, no new column, no new automation, no new AI behavior - this page
 * answers "how is Trackpr turning completed work into reviews, referrals,
 * and repeat business" by composing reads/actions that already exist.
 *
 * getJobs already embeds each job's contact (see lib/jobs/queries.ts's own
 * JOB_COLUMNS), so the in-memory join against review/referral requests
 * (both job_id-keyed) needs no separate getContacts call - the same
 * "join over already-fetched data" pattern app/(app)/jobs/page.tsx already
 * uses for these same two tables.
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

  const [jobs, reviewsResult, referralsResult] = await Promise.all([
    getJobs(supabase, membership.organizationId),
    getReviewRequestsResult(supabase, membership.organizationId),
    getReferralRequestsResult(supabase, membership.organizationId),
  ]);

  const reviewRows = buildReviewRows(reviewsResult.data, jobs);
  const referralRows = buildReferralRows(referralsResult.data, jobs);
  const dataUnavailable = reviewsResult.failed || referralsResult.failed;

  const reviewSummary = summarizeReviewRequests(reviewsResult.data);
  const referralSummary = summarizeReferralRequests(referralsResult.data);
  const needsAttentionCount = reviewRows.filter((row) => isReviewResolvable(row.request.status)).length + referralRows.filter((row) => isReferralResolvable(row.request.status)).length;
  const hasActivity = reviewSummary.reviewsRequested > 0 || referralSummary.referralsRequested > 0;

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Growth"
        title="Growth"
        description="Turn completed jobs into reviews, referrals, and repeat business."
        badge={
          needsAttentionCount > 0 ? (
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-slate-600">{needsAttentionCount}</span>
          ) : undefined
        }
      />

      {/* Same calm, non-alarming notice as Dashboard's own partialData banner
          (app/(app)/dashboard/page.tsx) - a failed review/referral read must
          never be presented as "no activity." */}
      {dataUnavailable ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            Some growth information may be temporarily unavailable.{" "}
            <Link href="/growth" className="font-medium underline decoration-warning-text/40 underline-offset-2 hover:decoration-warning-text">
              Refresh to try again
            </Link>
            .
          </p>
        </div>
      ) : null}

      {/* A plain summary line, not a KPI card grid - matches
          app/(app)/opportunities/page.tsx's own restrained precedent. Only
          shown once both reads succeeded, so it's never a confidently wrong
          number next to a real error. */}
      {!dataUnavailable && hasActivity ? (
        <p className={metaClass}>
          {reviewSummary.reviewsRequested > 0 ? `${reviewSummary.reviewsRequested} review${reviewSummary.reviewsRequested === 1 ? "" : "s"} requested, ${reviewSummary.reviewsCompleted} left` : "No reviews requested yet"}
          {referralSummary.referralsRequested > 0
            ? ` · ${referralSummary.referralsRequested} referral${referralSummary.referralsRequested === 1 ? "" : "s"} requested, ${referralSummary.referralsConverted} converted`
            : ""}
        </p>
      ) : null}

      <ReviewsSection rows={reviewRows} failed={reviewsResult.failed} />
      <ReferralsSection rows={referralRows} failed={referralsResult.failed} />
    </div>
  );
}
