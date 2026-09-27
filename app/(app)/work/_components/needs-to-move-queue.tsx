import Link from "next/link";
import { FileClock, CalendarClock, Hammer, Star, ArrowRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge, RAIL_TONE_CLASS, type BadgeTone } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { formatCurrency } from "@/lib/dashboard/format";
import { contactDisplayName } from "@/lib/contacts/format";
import type { Estimate } from "@/lib/estimates/queries";
import type { Job } from "@/lib/jobs/queries";
import type { ReviewRequest } from "@/lib/reviews-referrals/queries";

/**
 * Usability audit fix (#5, Work real tabs + Needs-to-move): "What work needs
 * movement right now" - a read-only queue merging existing estimate/job/
 * review-request signals the Estimates and Jobs tabs already fetch. No new
 * table, no new status field, no new business rule: every item here is a
 * row that already exists in `estimates`/`jobs`/`review_requests`, filtered
 * by status values those tables already support.
 */
type NeedsToMoveKind = "estimate_ready_to_schedule" | "estimate_awaiting_response" | "job_scheduled" | "job_needs_review_request";

export type NeedsToMoveItem = {
  id: string;
  kind: NeedsToMoveKind;
  label: string;
  title: string;
  subtitle: string;
  amount: number | null;
  href: string;
  sortDate: string;
};

const KIND_META: Record<NeedsToMoveKind, { label: string; icon: LucideIcon; tone: BadgeTone }> = {
  estimate_ready_to_schedule: { label: "Ready to schedule", icon: CalendarClock, tone: "success" },
  estimate_awaiting_response: { label: "Awaiting response", icon: FileClock, tone: "warning" },
  job_scheduled: { label: "Scheduled", icon: Hammer, tone: "info" },
  job_needs_review_request: { label: "Needs review request", icon: Star, tone: "neutral" },
};

/**
 * Priority order, most-actionable-revenue-first: an accepted estimate with
 * no job yet is money already won sitting idle (highest priority); a sent
 * estimate still needs a customer decision; a scheduled-but-not-started job
 * is already moving through the pipeline; a completed job's review ask is
 * the lowest-urgency housekeeping item. Within each kind, oldest first (the
 * one that's been waiting longest surfaces first).
 */
export function buildNeedsToMoveQueue(estimates: Estimate[], jobs: Job[], reviewRequests: ReviewRequest[]): NeedsToMoveItem[] {
  const jobEstimateIds = new Set(jobs.filter((job) => job.estimate_id).map((job) => job.estimate_id as string));
  const reviewRequestByJobId = new Map(reviewRequests.map((request) => [request.job_id, request]));

  const readyToSchedule: NeedsToMoveItem[] = estimates
    .filter((estimate) => estimate.status === "accepted" && !jobEstimateIds.has(estimate.id))
    .map((estimate) => ({
      id: estimate.id,
      kind: "estimate_ready_to_schedule" as const,
      label: KIND_META.estimate_ready_to_schedule.label,
      title: estimate.title,
      subtitle: estimate.contact ? contactDisplayName(estimate.contact) : "No contact",
      amount: estimate.amount,
      href: `/estimates/${estimate.id}`,
      sortDate: estimate.responded_at ?? estimate.updated_at,
    }));

  const awaitingResponse: NeedsToMoveItem[] = estimates
    .filter((estimate) => estimate.status === "sent")
    .map((estimate) => ({
      id: estimate.id,
      kind: "estimate_awaiting_response" as const,
      label: KIND_META.estimate_awaiting_response.label,
      title: estimate.title,
      subtitle: estimate.contact ? contactDisplayName(estimate.contact) : "No contact",
      amount: estimate.amount,
      href: `/estimates/${estimate.id}`,
      sortDate: estimate.sent_at ?? estimate.updated_at,
    }));

  const scheduledJobs: NeedsToMoveItem[] = jobs
    .filter((job) => job.status === "scheduled")
    .map((job) => ({
      id: job.id,
      kind: "job_scheduled" as const,
      label: KIND_META.job_scheduled.label,
      title: job.title,
      subtitle: job.contact ? contactDisplayName(job.contact) : "No contact",
      amount: job.amount,
      href: `/jobs/${job.id}`,
      sortDate: job.updated_at,
    }));

  const needsReviewRequest: NeedsToMoveItem[] = jobs
    .filter((job) => {
      if (job.status !== "completed") return false;
      const request = reviewRequestByJobId.get(job.id);
      return !request || request.status === "not_requested";
    })
    .map((job) => ({
      id: job.id,
      kind: "job_needs_review_request" as const,
      label: KIND_META.job_needs_review_request.label,
      title: job.title,
      subtitle: job.contact ? contactDisplayName(job.contact) : "No contact",
      amount: job.amount,
      href: `/jobs/${job.id}`,
      sortDate: job.completed_at ?? job.updated_at,
    }));

  const byOldestFirst = (a: NeedsToMoveItem, b: NeedsToMoveItem) => new Date(a.sortDate).getTime() - new Date(b.sortDate).getTime();

  return [
    ...readyToSchedule.sort(byOldestFirst),
    ...awaitingResponse.sort(byOldestFirst),
    ...scheduledJobs.sort(byOldestFirst),
    ...needsReviewRequest.sort(byOldestFirst),
  ];
}

function NeedsToMoveRow({ item }: { item: NeedsToMoveItem }) {
  const meta = KIND_META[item.kind];
  const Icon = meta.icon;
  return (
    <Link
      href={item.href}
      className={`group flex items-center gap-3 border-l-2 py-3.5 pl-3 pr-2 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${RAIL_TONE_CLASS[meta.tone]}`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-900">{item.title}</span>
          <Badge tone={meta.tone} icon={Icon}>
            {meta.label}
          </Badge>
        </span>
        <span className="block truncate text-xs text-slate-500">{item.subtitle}</span>
      </span>
      {item.amount != null ? <span className="shrink-0 text-sm font-medium tabular-nums text-slate-700">{formatCurrency(item.amount)}</span> : null}
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden />
    </Link>
  );
}

export function NeedsToMoveQueue({ items }: { items: NeedsToMoveItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Hammer}
        title="Nothing needs to move right now."
        description="Estimates awaiting a decision, accepted work ready to schedule, and completed jobs needing a review ask will show up here."
      />
    );
  }

  return <div className="divide-y divide-slate-100">{items.map((item) => <NeedsToMoveRow key={`${item.kind}-${item.id}`} item={item} />)}</div>;
}
