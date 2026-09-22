"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { errorBannerClass, inputClass, primaryButtonSmallClass, secondaryButtonSmallClass } from "@/lib/ui/form";
import { detailLabelClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
import { SectionCard } from "@/lib/ui/section-card";
import type { ReviewRequest, ReferralRequest } from "@/lib/reviews-referrals/queries";
import { REVIEW_STATUS_LABELS, REFERRAL_STATUS_LABELS } from "@/lib/reviews-referrals/format";
import { REVIEW_STATUS_TONE, REVIEW_STATUS_ICON, REFERRAL_STATUS_TONE, REFERRAL_STATUS_ICON } from "../../_components/status";
import { markReviewCompleted, markReviewDeclined, markReferralConverted, markReferralDeclined, createLeadFromReferral } from "../../actions";

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
  const [showNewLeadForm, setShowNewLeadForm] = useState(false);
  const [newLeadName, setNewLeadName] = useState("");
  const [newLeadPhone, setNewLeadPhone] = useState("");
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
    <SectionCard title="Review & Referral">
      <div className="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-2">
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
                <button type="button" disabled={isPending} onClick={() => run(() => markReviewCompleted(jobId))} className={primaryButtonSmallClass}>
                  Mark Review Left
                </button>
                <button type="button" disabled={isPending} onClick={() => run(() => markReviewDeclined(jobId))} className={secondaryButtonSmallClass}>
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
                <button type="button" disabled={isPending} onClick={() => run(() => markReferralConverted(jobId, selectedLeadId || null))} className={primaryButtonSmallClass}>
                  Mark Converted
                </button>
                <button type="button" disabled={isPending} onClick={() => run(() => markReferralDeclined(jobId))} className={secondaryButtonSmallClass}>
                  Mark Declined
                </button>
                {!showNewLeadForm ? (
                  <button type="button" disabled={isPending} onClick={() => setShowNewLeadForm(true)} className="text-xs font-medium text-slate-500 hover:text-slate-900">
                    Don&apos;t have a lead yet? Create one
                  </button>
                ) : null}
              </div>
            ) : null}
            {referralResolvable && showNewLeadForm ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                <input
                  type="text"
                  aria-label="Referred person's name"
                  placeholder="Referred person's name"
                  value={newLeadName}
                  onChange={(event) => setNewLeadName(event.target.value)}
                  disabled={isPending}
                  className={`${inputClass} max-w-[180px] py-1.5 text-xs`}
                />
                <input
                  type="tel"
                  aria-label="Referred person's phone"
                  placeholder="Phone number"
                  value={newLeadPhone}
                  onChange={(event) => setNewLeadPhone(event.target.value)}
                  disabled={isPending}
                  className={`${inputClass} max-w-[160px] py-1.5 text-xs`}
                />
                <button
                  type="button"
                  disabled={isPending || !newLeadName.trim() || !newLeadPhone.trim()}
                  onClick={() => run(() => createLeadFromReferral(jobId, { firstName: newLeadName, phone: newLeadPhone }))}
                  className={primaryButtonSmallClass}
                >
                  Create Lead
                </button>
                <button type="button" disabled={isPending} onClick={() => setShowNewLeadForm(false)} className={secondaryButtonSmallClass}>
                  Cancel
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? <p className={`mt-3 ${errorBannerClass}`}>{error}</p> : null}
    </SectionCard>
  );
}
