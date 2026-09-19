import { sectionLabelClass, statLabelClass, statValueClass } from "@/lib/ui/typography";
import type { ReviewReferralSummary } from "@/lib/reviews-referrals/queries";

const STATS: { key: keyof ReviewReferralSummary; label: string }[] = [
  { key: "reviewsRequested", label: "Reviews requested" },
  { key: "reviewsCompleted", label: "Reviews left" },
  { key: "referralsRequested", label: "Referrals requested" },
  { key: "referralsConverted", label: "Referrals converted" },
];

/** Same integrated-row convention as JobsSummary/EstimatesSummary/LeadsSummary - restrained counts, not boxed metric cards. */
export function ReviewReferralSummaryRow({ summary }: { summary: ReviewReferralSummary }) {
  if (summary.reviewsRequested === 0 && summary.referralsRequested === 0) return null;

  return (
    <div>
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
