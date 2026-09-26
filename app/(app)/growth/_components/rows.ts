import { formatRelativeTime } from "@/lib/dashboard/format";
import type { BadgeTone } from "@/lib/ui/badge";
import type { Job } from "@/lib/jobs/queries";
import type { ReviewRequest, ReferralRequest } from "@/lib/reviews-referrals/queries";

/** Mirrors lib/ui/badge.tsx's own light-surface TONE_CLASS exactly (not exported there) - the same icon-chip background/text pairing app/(app)/opportunities/_components/opportunities-list.tsx already uses for its own row icon chip. */
export const TONE_CHIP_STYLE: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-600",
  info: "bg-info-muted text-info-text",
  success: "bg-accent-muted text-accent-text",
  warning: "bg-warning-muted text-warning-text",
  danger: "bg-danger-muted text-danger-text",
};

export type ReviewRow = { request: ReviewRequest; job: Job | null };
export type ReferralRow = { request: ReferralRequest; job: Job | null };

/** A request is only actionable while it's mid-flight - a lead sent it and hasn't been resolved yet. Mirrors review-referral-panel.tsx's own reviewResolvable/referralResolvable check exactly. */
export function isReviewResolvable(status: ReviewRequest["status"]): boolean {
  return status === "requested" || status === "responded";
}

export function isReferralResolvable(status: ReferralRequest["status"]): boolean {
  return status === "requested" || status === "responded";
}

function activityTimestamp(request: { requested_at: string | null; responded_at: string | null; resolved_at: string | null; created_at: string }): number {
  return new Date(request.resolved_at ?? request.responded_at ?? request.requested_at ?? request.created_at).getTime();
}

/** The most recent real lifecycle timestamp on a request, in plain English - never the row's created_at, which is a database artifact the reader has no reason to see. Returns null only for the (never actually observed - see queries.ts's own note) "not_requested" state, which has no timestamp at all yet. */
export function timingLabel(request: { requested_at: string | null; responded_at: string | null; resolved_at: string | null }): string | null {
  if (request.resolved_at) return `Resolved ${formatRelativeTime(request.resolved_at)}`;
  if (request.responded_at) return `Responded ${formatRelativeTime(request.responded_at)}`;
  if (request.requested_at) return `Requested ${formatRelativeTime(request.requested_at)}`;
  return null;
}

/**
 * In-memory join of the org's flat review/referral rows against the org's
 * already-fetched jobs (both job_id-keyed, both org-scoped) - the same
 * "join over already-fetched data, never N+1" pattern app/(app)/jobs/page.tsx
 * already uses for these exact same two tables. Rows needing action
 * (requested/responded) sort first, matching AttentionPanel's own
 * urgency-first convention; each group then sorts most-recent-activity
 * first.
 */
export function buildReviewRows(requests: ReviewRequest[], jobs: Job[]): ReviewRow[] {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  return requests
    .map((request) => ({ request, job: jobById.get(request.job_id) ?? null }))
    .sort((a, b) => {
      const aResolvable = isReviewResolvable(a.request.status);
      const bResolvable = isReviewResolvable(b.request.status);
      if (aResolvable !== bResolvable) return aResolvable ? -1 : 1;
      return activityTimestamp(b.request) - activityTimestamp(a.request);
    });
}

export function buildReferralRows(requests: ReferralRequest[], jobs: Job[]): ReferralRow[] {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  return requests
    .map((request) => ({ request, job: jobById.get(request.job_id) ?? null }))
    .sort((a, b) => {
      const aResolvable = isReferralResolvable(a.request.status);
      const bResolvable = isReferralResolvable(b.request.status);
      if (aResolvable !== bResolvable) return aResolvable ? -1 : 1;
      return activityTimestamp(b.request) - activityTimestamp(a.request);
    });
}
