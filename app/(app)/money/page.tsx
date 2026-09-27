import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getEstimatesResult, type Estimate } from "@/lib/estimates/queries";
import { getJobsResult, type Job } from "@/lib/jobs/queries";
import { STATUS_LABELS as JOB_STATUS_LABELS } from "@/lib/jobs/format";
import { contactDisplayName } from "@/lib/contacts/format";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass } from "@/lib/ui/typography";
import { QueueCard } from "@/lib/ui/queue-card";
import { surfaceClass } from "@/lib/ui/surface";

type MoneyEntry = {
  key: string;
  problemLabel: string;
  age: string;
  personName: string;
  personHref: string;
  money?: string;
  jobType: string;
  sentence: string;
  phone: string | null;
  secondaryHref: string;
  amount: number;
};

function totalsLine(entries: MoneyEntry[]): string {
  if (entries.length === 0) return "";
  const known = entries.filter((entry) => entry.amount > 0);
  const total = known.reduce((sum, entry) => sum + entry.amount, 0);
  const unknownCount = entries.length - known.length;
  const countLabel = `${entries.length} ${entries.length === 1 ? "item" : "items"}`;
  if (known.length === 0) return `${countLabel} · value unknown`;
  const suffix = unknownCount > 0 ? ` (${unknownCount} with no amount set)` : "";
  return `${formatCurrency(total)} across ${countLabel}${suffix}`;
}

/**
 * Phase 4 (Money pass): /money replaces /work in the nav's own concept of
 * "money in motion" - the plan's own recommended Option A, confirmed by the
 * user - two groups only: quotes out (estimates sent, awaiting a decision)
 * and won not finished (jobs actively underway, not yet completed). A third
 * "finished, not paid" group was explicitly ruled out in the plan itself -
 * there is no invoicing/payment data model to build it from, and inventing
 * one is out of scope here. /work itself, and everything it reads, is
 * completely untouched - this reads the exact same getEstimatesResult/
 * getJobsResult calls /work already performs, zero new queries, just a
 * narrower, money-first slice and grouping of the same rows.
 */
export default async function MoneyPage() {
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

  const [estimatesResult, jobsResult] = await Promise.all([
    getEstimatesResult(supabase, membership.organizationId),
    getJobsResult(supabase, membership.organizationId),
  ]);

  const quotesOut: MoneyEntry[] = estimatesResult.data
    .filter((estimate: Estimate) => estimate.status === "sent")
    .map((estimate) => ({
      key: `estimate:${estimate.id}`,
      problemLabel: "Quote sent",
      age: estimate.sent_at ? formatRelativeTime(estimate.sent_at) : formatRelativeTime(estimate.created_at),
      personName: estimate.contact ? contactDisplayName(estimate.contact) : estimate.title,
      personHref: estimate.contact ? `/people/${estimate.contact.id}` : `/estimates/${estimate.id}`,
      money: estimate.amount != null ? formatCurrency(estimate.amount) : undefined,
      jobType: estimate.title,
      sentence: estimate.notes ?? "Waiting on a decision.",
      phone: estimate.contact?.phone ?? null,
      secondaryHref: `/estimates/${estimate.id}`,
      amount: estimate.amount ?? 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const wonNotFinished: MoneyEntry[] = jobsResult.data
    .filter((job: Job) => job.status === "scheduled" || job.status === "in_progress")
    .map((job) => ({
      key: `job:${job.id}`,
      problemLabel: JOB_STATUS_LABELS[job.status],
      age: formatRelativeTime(job.started_at ?? job.created_at),
      personName: job.contact ? contactDisplayName(job.contact) : job.title,
      personHref: job.contact ? `/people/${job.contact.id}` : `/jobs/${job.id}`,
      money: job.amount != null ? formatCurrency(job.amount) : undefined,
      jobType: job.title,
      sentence: job.notes ?? "Job is underway, not yet marked complete.",
      phone: job.contact?.phone ?? null,
      secondaryHref: `/jobs/${job.id}`,
      amount: job.amount ?? 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <h1 className={pageTitleClass}>Money</h1>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>What&apos;s out for a decision, and what&apos;s already won but not finished.</p>
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <p className={sectionLabelClass}>Quotes out</p>
          <p className="text-xs text-ink-3">{totalsLine(quotesOut)}</p>
        </div>
        {quotesOut.length === 0 ? (
          <div className={`mt-3 ${surfaceClass} px-6 py-10 text-center`}>
            <p className="text-sm text-slate-500">No quotes are out right now.</p>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {quotesOut.map((entry) => (
              <QueueCard
                key={entry.key}
                tone="soon"
                problemLabel={entry.problemLabel}
                age={entry.age}
                personName={entry.personName}
                personHref={entry.personHref}
                money={entry.money}
                jobType={entry.jobType}
                sentence={entry.sentence}
                phone={entry.phone}
                secondaryHref={entry.secondaryHref}
                secondaryLabel="View"
              />
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <p className={sectionLabelClass}>Won, not finished</p>
          <p className="text-xs text-ink-3">{totalsLine(wonNotFinished)}</p>
        </div>
        {wonNotFinished.length === 0 ? (
          <div className={`mt-3 ${surfaceClass} px-6 py-10 text-center`}>
            <p className="text-sm text-slate-500">No jobs in progress right now.</p>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {wonNotFinished.map((entry) => (
              <QueueCard
                key={entry.key}
                tone="good"
                problemLabel={entry.problemLabel}
                age={entry.age}
                personName={entry.personName}
                personHref={entry.personHref}
                money={entry.money}
                jobType={entry.jobType}
                sentence={entry.sentence}
                phone={entry.phone}
                secondaryHref={entry.secondaryHref}
                secondaryLabel="View"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
