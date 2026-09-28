import { contactDisplayName } from "@/lib/contacts/format";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import { STATUS_LABELS as JOB_STATUS_LABELS } from "@/lib/jobs/format";
import type { Estimate } from "@/lib/estimates/queries";
import type { Job } from "@/lib/jobs/queries";
import type { StatusTone } from "@/lib/ui/status";

export type MoneyEntry = {
  key: string;
  tone: StatusTone;
  personName: string;
  personHref: string;
  money?: string;
  status: string;
  age: string;
  nextStep: string;
  amount: number;
};

export type MoneySnapshot = {
  quotesOut: MoneyEntry[];
  readyToSchedule: MoneyEntry[];
  wonNotFinished: MoneyEntry[];
  knownOpportunityValue: number;
};

/**
 * Nav-restructure pass: extracted from money/page.tsx unchanged so Dashboard's
 * own compact snapshot and Money's own detailed page can never disagree about
 * these three numbers - previously computed once, inline, only on Money;
 * Dashboard needs the exact same real, already-established business rules
 * (a quote sent, an accepted estimate with no job yet, a job already
 * underway), not a second, independently-reasoned version of them.
 */
export function computeMoneySnapshot(estimates: Estimate[], jobs: Job[]): MoneySnapshot {
  const jobEstimateIds = new Set(jobs.filter((job) => job.estimate_id).map((job) => job.estimate_id as string));

  const quotesOut: MoneyEntry[] = estimates
    .filter((estimate) => estimate.status === "sent")
    .map((estimate) => ({
      key: `estimate:${estimate.id}`,
      tone: "soon" as const,
      status: "Quote sent",
      age: estimate.sent_at ? formatRelativeTime(estimate.sent_at) : formatRelativeTime(estimate.created_at),
      personName: estimate.contact ? contactDisplayName(estimate.contact) : estimate.title,
      personHref: estimate.contact ? `/people/${estimate.contact.id}` : `/estimates/${estimate.id}`,
      money: estimate.amount != null ? formatCurrency(estimate.amount) : undefined,
      nextStep: "Follow up",
      amount: estimate.amount ?? 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  // The one real "Needs to move" signal that doesn't belong to either
  // Estimates' or Jobs' own status filters alone - a customer already said
  // yes, but there's no job for it yet.
  const readyToSchedule: MoneyEntry[] = estimates
    .filter((estimate) => estimate.status === "accepted" && !jobEstimateIds.has(estimate.id))
    .map((estimate) => ({
      key: `ready:${estimate.id}`,
      tone: "urgent" as const,
      status: "Accepted, not scheduled",
      age: formatRelativeTime(estimate.responded_at ?? estimate.updated_at),
      personName: estimate.contact ? contactDisplayName(estimate.contact) : estimate.title,
      personHref: estimate.contact ? `/people/${estimate.contact.id}` : `/estimates/${estimate.id}`,
      money: estimate.amount != null ? formatCurrency(estimate.amount) : undefined,
      nextStep: "Schedule job",
      amount: estimate.amount ?? 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const wonNotFinished: MoneyEntry[] = jobs
    .filter((job) => job.status === "scheduled" || job.status === "in_progress")
    .map((job) => ({
      key: `job:${job.id}`,
      tone: "good" as const,
      status: JOB_STATUS_LABELS[job.status],
      age: formatRelativeTime(job.started_at ?? job.created_at),
      personName: job.contact ? contactDisplayName(job.contact) : job.title,
      personHref: job.contact ? `/people/${job.contact.id}` : `/jobs/${job.id}`,
      money: job.amount != null ? formatCurrency(job.amount) : undefined,
      nextStep: job.status === "scheduled" ? "Start job" : "Mark complete",
      amount: job.amount ?? 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const knownOpportunityValue = [...quotesOut, ...readyToSchedule, ...wonNotFinished].reduce((sum, entry) => sum + entry.amount, 0);

  return { quotesOut, readyToSchedule, wonNotFinished, knownOpportunityValue };
}
