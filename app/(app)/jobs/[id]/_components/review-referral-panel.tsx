"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { errorBannerClass, inputClass } from "@/lib/ui/form";
import { detailLabelClass, subsectionTitleClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
import type { ReviewRequest, ReferralRequest } from "@/lib/reviews-referrals/queries";
import { REVIEW_STATUS_LABELS, REFERRAL_STATUS_LABELS } from "@/lib/reviews-referrals/format";
import { REVIEW_STATUS_TONE, REVIEW_STATUS_ICON, REFERRAL_STATUS_TONE, REFERRAL_STATUS_ICON } from "../../_components/status";
import { markReviewCompleted, markReviewDeclined, markReferralConverted, markReferralDeclined } from "../../actions";

const primaryBtn =
  "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400";
const secondaryBtn =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The only place a review/referral request can ever be moved to a terminal
 * outcome beyond 'requested'/'responded'/'failed' - every button here maps
 * to exactly one existing action in ../../actions, which itself re-verifies
 * organization/eligibility server-side (see the actions' own docs). This
 * component never decides truth; it only offers a button that lets the
 * contractor record what they already know happened. Nothing renders at
 * all for a job that has no request yet (see the migration's own note on
 * why a row doesn't exist until a request is actually attempted).
 */
export function ReviewReferralPanel({
  jobId,
  reviewRequest,
  referralRequest,
  leadOptions,
}: {
  jobId: string;
  reviewRequest: ReviewRequest | null;
  referralRequest: ReferralRequest | null;
  leadOptions: { id: string; label: string }[];
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState("");
  const router = useRouter();

  if (!reviewRequest && !referralRequest) return null;

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      router.refresh();
    });
  }

  const reviewResolvable = reviewRequest?.status === "requested" || reviewRequest?.status === "responded";
  const referralResolvable = referralRequest?.status === "requested" || referralRequest?.status === "responded";

  return (
    <div className="border-t border-slate-200 pt-8">
      <h2 className={subsectionTitleClass}>Review &amp; Referral</h2>
      <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-2">
        {reviewRequest ? (
          <div>
            <dt className={detailLabelClass}>Review</dt>
            <dd className="mt-1.5">
              <Badge tone={REVIEW_STATUS_TONE[reviewRequest.status]} icon={REVIEW_STATUS_ICON[reviewRequest.status]}>
                {REVIEW_STATUS_LABELS[reviewRequest.status]}
              </Badge>
            </dd>
            {reviewRequest.failure_reason ? <p className="mt-1.5 text-xs text-red-600">{reviewRequest.failure_reason}</p> : null}
            {reviewResolvable ? (
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={isPending} onClick={() => run(() => markReviewCompleted(jobId))} className={primaryBtn}>
                  Mark Review Left
                </button>
                <button type="button" disabled={isPending} onClick={() => run(() => markReviewDeclined(jobId))} className={secondaryBtn}>
                  Mark Declined
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {referralRequest ? (
          <div>
            <dt className={detailLabelClass}>Referral</dt>
            <dd className="mt-1.5">
              <Badge tone={REFERRAL_STATUS_TONE[referralRequest.status]} icon={REFERRAL_STATUS_ICON[referralRequest.status]}>
                {REFERRAL_STATUS_LABELS[referralRequest.status]}
              </Badge>
            </dd>
            {referralRequest.failure_reason ? <p className="mt-1.5 text-xs text-red-600">{referralRequest.failure_reason}</p> : null}
            {referralResolvable ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {leadOptions.length > 0 ? (
                  <select
                    aria-label="Referred lead (optional)"
                    value={selectedLeadId}
                    onChange={(event) => setSelectedLeadId(event.target.value)}
                    disabled={isPending}
                    className={`${inputClass} max-w-[220px] py-1.5 text-xs`}
                  >
                    <option value="">No specific lead</option>
                    {leadOptions.map((lead) => (
                      <option key={lead.id} value={lead.id}>
                        {lead.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button type="button" disabled={isPending} onClick={() => run(() => markReferralConverted(jobId, selectedLeadId || null))} className={primaryBtn}>
                  Mark Converted
                </button>
                <button type="button" disabled={isPending} onClick={() => run(() => markReferralDeclined(jobId))} className={secondaryBtn}>
                  Mark Declined
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? <p className={`mt-3 ${errorBannerClass}`}>{error}</p> : null}
    </div>
  );
}
