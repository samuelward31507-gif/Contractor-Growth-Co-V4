import { redirect } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { filterEstimates, getEstimatesResult, summarizeEstimates, ESTIMATE_STATUSES, type Estimate, type EstimateStatus } from "@/lib/estimates/queries";
import { filterJobs, getJobsResult, summarizeJobs, JOB_STATUSES, type Job, type JobStatus } from "@/lib/jobs/queries";
import { STATUS_LABELS as JOB_STATUS_LABELS } from "@/lib/jobs/format";
import { contactDisplayName } from "@/lib/contacts/format";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass } from "@/lib/ui/typography";
import { QueueCard } from "@/lib/ui/queue-card";
import { surfaceClass } from "@/lib/ui/surface";
import { Panel } from "@/lib/ui/section-card";
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
import { MoneyTabs, type MoneyTab } from "./_components/money-tabs";

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

function normalizeBrowse(value: string | undefined): MoneyTab {
  if (value === "estimates") return "estimates";
  if (value === "jobs") return "jobs";
  return "money";
}

function normalizeEstimateStatus(value: string | undefined): EstimateStatus | "all" {
  return value && ESTIMATE_STATUSES.some((s) => s.value === value) ? (value as EstimateStatus) : "all";
}

function normalizeJobStatus(value: string | undefined): JobStatus | "all" {
  return value && JOB_STATUSES.some((s) => s.value === value) ? (value as JobStatus) : "all";
}

/**
 * IA consolidation pass: Money absorbs Work in full - the curated "Money"
 * view (Quotes out / Ready to schedule / Won not finished) is still the
 * default, but "All estimates"/"All jobs" (MoneyTabs) now reuse Work's own
 * EstimatesTable/JobsTable/toolbars/summaries/Add buttons/empty states
 * verbatim, so nothing Work could do - browsing every estimate or job
 * regardless of status, searching, filtering, creating a new one - is lost
 * by retiring /work as a separate destination (see its own page.tsx, now a
 * redirect here). "Ready to schedule" (an accepted estimate with no job
 * yet) is the one real signal Work's old "Needs to move" queue carried that
 * neither of Money's original two groups covered - added here rather than
 * dropped. The fourth "Needs to move" bucket (a completed job with no
 * review request sent) is not carried over: per lib/reviews-referrals' own
 * documentation this state is never actually observed in practice (review
 * requests are created automatically on job completion), and the concept
 * itself belongs to Reviews & Referrals, not Money.
 */
export default async function MoneyPage({ searchParams }: PageProps<"/money">) {
  const params = await searchParams;
  const browse = normalizeBrowse(typeof params.browse === "string" ? params.browse : undefined);
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

  const [estimatesResult, jobsResult, contacts, leads] = await Promise.all([
    getEstimatesResult(supabase, membership.organizationId),
    getJobsResult(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
  ]);
  const allEstimates = estimatesResult.data;
  const allJobs = jobsResult.data;
  const failed = estimatesResult.failed || jobsResult.failed;

  const jobEstimateIds = new Set(allJobs.filter((job) => job.estimate_id).map((job) => job.estimate_id as string));

  const quotesOut: MoneyEntry[] = allEstimates
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

  // The one real "Needs to move" signal Money's original two groups didn't
  // cover - a customer already said yes, but there's no job for it yet.
  const readyToSchedule: MoneyEntry[] = allEstimates
    .filter((estimate: Estimate) => estimate.status === "accepted" && !jobEstimateIds.has(estimate.id))
    .map((estimate) => ({
      key: `ready:${estimate.id}`,
      problemLabel: "Accepted - not scheduled",
      age: formatRelativeTime(estimate.responded_at ?? estimate.updated_at),
      personName: estimate.contact ? contactDisplayName(estimate.contact) : estimate.title,
      personHref: estimate.contact ? `/people/${estimate.contact.id}` : `/estimates/${estimate.id}`,
      money: estimate.amount != null ? formatCurrency(estimate.amount) : undefined,
      jobType: estimate.title,
      sentence: estimate.notes ?? "Customer accepted - schedule the job.",
      phone: estimate.contact?.phone ?? null,
      secondaryHref: `/estimates/${estimate.id}`,
      amount: estimate.amount ?? 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const wonNotFinished: MoneyEntry[] = allJobs
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

  const estimateSummary = summarizeEstimates(allEstimates);
  const jobSummary = summarizeJobs(allJobs);
  const filteredEstimates = filterEstimates(allEstimates, { query, status: estimateStatus });
  const hasActiveEstimateFilters = Boolean(query.trim()) || estimateStatus !== "all";
  const filteredJobs = filterJobs(allJobs, { query, status: jobStatus });
  const hasActiveJobFilters = Boolean(query.trim()) || jobStatus !== "all";

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className={pageTitleClass}>Money</h1>
          <p className={`mt-1.5 ${pageDescriptionClass}`}>
            {browse === "money" ? "What's out for a decision, what's ready to schedule, and what's already won but not finished." : "Every estimate and job, searchable and filterable."}
          </p>
        </div>
        {browse !== "money" ? (
          <div className="shrink-0">{browse === "jobs" ? <AddJobButton contacts={contacts} leads={leads} /> : <AddEstimateButton contacts={contacts} leads={leads} />}</div>
        ) : null}
      </div>

      {failed ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some information is temporarily unavailable. Please try again.</p>
        </div>
      ) : null}

      <MoneyTabs active={browse} />

      {browse === "money" ? (
        <>
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
              <p className={sectionLabelClass}>Ready to schedule</p>
              <p className="text-xs text-ink-3">{totalsLine(readyToSchedule)}</p>
            </div>
            {readyToSchedule.length === 0 ? (
              <div className={`mt-3 ${surfaceClass} px-6 py-10 text-center`}>
                <p className="text-sm text-slate-500">Nothing accepted and waiting on a job.</p>
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {readyToSchedule.map((entry) => (
                  <QueueCard
                    key={entry.key}
                    tone="urgent"
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
        </>
      ) : null}

      {browse === "estimates" ? (
        <>
          <EstimatesSummary summary={estimateSummary} />
          {allEstimates.length === 0 ? (
            <EstimatesEmptyState contacts={contacts} leads={leads} />
          ) : (
            <Panel>
              <EstimatesToolbar initialQuery={query} initialStatus={estimateStatus} extraParams={{ browse: "estimates" }} />
              <div className="mt-5">
                <EstimatesTable estimates={filteredEstimates} hasActiveFilters={hasActiveEstimateFilters} />
              </div>
            </Panel>
          )}
        </>
      ) : null}

      {browse === "jobs" ? (
        <>
          <JobsSummary summary={jobSummary} />
          {allJobs.length === 0 ? (
            <JobsEmptyState contacts={contacts} leads={leads} />
          ) : (
            <Panel>
              <JobsToolbar initialQuery={query} initialStatus={jobStatus} extraParams={{ browse: "jobs" }} />
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
