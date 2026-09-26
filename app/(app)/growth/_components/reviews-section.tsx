import Link from "next/link";
import { ArrowRight, Star } from "lucide-react";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge, RAIL_TONE_CLASS } from "@/lib/ui/badge";
import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { contactDisplayName } from "@/lib/contacts/format";
import { REVIEW_STATUS_LABELS } from "@/lib/reviews-referrals/format";
import { REVIEW_STATUS_TONE, REVIEW_STATUS_ICON } from "../../jobs/_components/status";
import { ReviewQuickActions } from "./review-quick-actions";
import { TONE_CHIP_STYLE, isReviewResolvable, timingLabel, type ReviewRow } from "./rows";

/**
 * Trackpr 2.0, Phase 3G: one review-request row. Every visual choice here
 * reuses an existing primitive - the status tone/icon/label map
 * app/(app)/jobs/[id]/_components/review-referral-panel.tsx already uses,
 * and Badge/RAIL_TONE_CLASS from lib/ui/badge.tsx - so a review's status
 * reads identically whether seen on the job's own page or here.
 */
function ReviewRowItem({ row }: { row: ReviewRow }) {
  const { request, job } = row;
  const tone = REVIEW_STATUS_TONE[request.status];
  const Icon = REVIEW_STATUS_ICON[request.status];
  const timing = timingLabel(request);
  const contactName = job?.contact ? contactDisplayName(job.contact) : "Unknown customer";

  return (
    <li className={`flex flex-col gap-3 border-l-2 py-4 pl-3 pr-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4 ${RAIL_TONE_CLASS[tone]}`}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${TONE_CHIP_STYLE[tone]}`}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">
            {job?.contact ? (
              <Link href={`/customers/${job.contact.id}`} className="rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                {contactName}
              </Link>
            ) : (
              contactName
            )}
          </p>
          <p className="truncate text-sm text-slate-500">{job ? job.title : "Job unavailable"}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone={tone} icon={Icon}>
              {REVIEW_STATUS_LABELS[request.status]}
            </Badge>
            {timing ? <span className={metaClass}>{timing}</span> : null}
          </div>
          {request.failure_reason ? <p className="mt-1 text-xs text-danger-text">{request.failure_reason}</p> : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2 self-start">
        {job ? (
          <Link
            href={`/jobs/${job.id}`}
            className="inline-flex items-center gap-1 rounded text-sm font-medium text-slate-600 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            View job
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : null}
        {isReviewResolvable(request.status) ? <ReviewQuickActions jobId={request.job_id} /> : null}
      </div>
    </li>
  );
}

export function ReviewsSection({ rows, failed }: { rows: ReviewRow[]; failed: boolean }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className={sectionLabelClass}>Reviews</p>
        {rows.length > 0 ? <span className={metaClass}>{rows.length}</span> : null}
      </div>
      <div className="mt-2">
        {failed ? (
          <EmptyState
            icon={Star}
            title="Reviews couldn't be loaded."
            description="Something went wrong loading review activity - this isn't the same as having none. Refresh to try again."
          />
        ) : rows.length === 0 ? (
          <EmptyState icon={Star} title="No review activity yet." description="Review requests will appear here once Trackpr sends one after a completed job." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((row) => (
              <ReviewRowItem key={row.request.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
