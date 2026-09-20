import { sectionLabelClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import type { ReviewReferralSummary } from "@/lib/reviews-referrals/queries";

const STATS: { key: keyof ReviewReferralSummary; label: string }[] = [
  { key: "reviewsRequested", label: "Reviews requested" },
  { key: "reviewsCompleted", label: "Reviews left" },
  { key: "referralsRequested", label: "Referrals requested" },
  { key: "referralsConverted", label: "Referrals converted" },
];

/**
 * Deliberately still the integrated-row convention (not StatGrid/StatCard) -
 * this is secondary, supporting context under JobsSummary's own boxed
 * primary metrics, not a second set of headline numbers competing for the
 * same visual weight. A border-t separates it from JobsSummary above so the
 * two rows read as distinct tiers rather than one continuous strip.
 */
export function ReviewReferralSummaryRow({ summary }: { summary: ReviewReferralSummary }) {
  if (summary.reviewsRequested === 0 && summary.referralsRequested === 0) return null;

  return (
    <div className="border-t border-slate-200 pt-6">
      <p className={sectionLabelClass}>Review &amp; Referral</p>
      <dl className="mt-3 flex flex-wrap gap-x-10 gap-y-4">
        {STATS.map(({ key, label }) => (
          <div key={key}>
            <dt className={statLabelClass}>{label}</dt>
            <dd className={statValueClass}>{summary[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
