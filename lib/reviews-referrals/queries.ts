import type { SupabaseClient } from "@supabase/supabase-js";

export type ReviewRequestStatus = "not_requested" | "requested" | "responded" | "completed" | "declined" | "failed";
export type ReferralRequestStatus = "not_requested" | "requested" | "responded" | "converted" | "declined" | "failed";

export const REVIEW_REQUEST_STATUSES: { value: ReviewRequestStatus; label: string }[] = [
  { value: "not_requested", label: "Not requested" },
  { value: "requested", label: "Requested" },
  { value: "responded", label: "Responded" },
  { value: "completed", label: "Completed" },
  { value: "declined", label: "Declined" },
  { value: "failed", label: "Failed" },
];

export const REFERRAL_REQUEST_STATUSES: { value: ReferralRequestStatus; label: string }[] = [
  { value: "not_requested", label: "Not requested" },
  { value: "requested", label: "Requested" },
  { value: "responded", label: "Responded" },
  { value: "converted", label: "Converted" },
  { value: "declined", label: "Declined" },
  { value: "failed", label: "Failed" },
];

export type ReviewRequest = {
  id: string;
  organization_id: string;
  job_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  workflow_execution_id: string | null;
  status: ReviewRequestStatus;
  review_url: string | null;
  requested_at: string | null;
  responded_at: string | null;
  resolved_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type ReferralRequest = {
  id: string;
  organization_id: string;
  job_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  workflow_execution_id: string | null;
  status: ReferralRequestStatus;
  referred_lead_id: string | null;
  requested_at: string | null;
  responded_at: string | null;
  resolved_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

const REVIEW_REQUEST_COLUMNS =
  "id, organization_id, job_id, contact_id, conversation_id, message_id, workflow_execution_id, status, review_url, requested_at, responded_at, resolved_at, failure_reason, created_at, updated_at";

const REFERRAL_REQUEST_COLUMNS =
  "id, organization_id, job_id, contact_id, conversation_id, message_id, workflow_execution_id, status, referred_lead_id, requested_at, responded_at, resolved_at, failure_reason, created_at, updated_at";

/** Org-scoped, single-job lookups - mirrors getJob's contract exactly (any error/not-found resolves to null, never throws). Used by the job detail page; a job with no request attempt yet correctly returns null (see the migration's own note on why 'not_requested' rows are never created eagerly). */
export async function getReviewRequestForJob(supabase: SupabaseClient, organizationId: string, jobId: string): Promise<ReviewRequest | null> {
  const { data, error } = await supabase
    .from("review_requests")
    .select(REVIEW_REQUEST_COLUMNS)
    .eq("job_id", jobId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error || !data) return null;
  return data as ReviewRequest;
}

export async function getReferralRequestForJob(supabase: SupabaseClient, organizationId: string, jobId: string): Promise<ReferralRequest | null> {
  const { data, error } = await supabase
    .from("referral_requests")
    .select(REFERRAL_REQUEST_COLUMNS)
    .eq("job_id", jobId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error || !data) return null;
  return data as ReferralRequest;
}

/** Loads every review/referral request for the org (capped, matching getJobs/getLeads), for the Jobs page's summary. */
export async function getReviewRequests(supabase: SupabaseClient, organizationId: string): Promise<ReviewRequest[]> {
  const { data } = await supabase.from("review_requests").select(REVIEW_REQUEST_COLUMNS).eq("organization_id", organizationId).limit(1000);
  return (data ?? []) as ReviewRequest[];
}

export async function getReferralRequests(supabase: SupabaseClient, organizationId: string): Promise<ReferralRequest[]> {
  const { data } = await supabase.from("referral_requests").select(REFERRAL_REQUEST_COLUMNS).eq("organization_id", organizationId).limit(1000);
  return (data ?? []) as ReferralRequest[];
}

export type ReviewReferralSummary = {
  reviewsRequested: number;
  reviewsResponded: number;
  reviewsCompleted: number;
  reviewsDeclined: number;
  reviewsFailed: number;
  referralsRequested: number;
  referralsResponded: number;
  referralsConverted: number;
  referralsDeclined: number;
  referralsFailed: number;
};

/**
 * Restrained counts only - matches summarizeJobs/summarizeEstimates' own
 * discipline (a handful of numbers, not every possible cross-tab). "Requested"
 * counts every row that ever reached at least 'requested' (i.e. every row
 * that exists at all, since a row is never created before that point) -
 * responded/completed/declined/failed are each an exact status count, not
 * cumulative, so they sum back to the total.
 */
export function summarizeReviewRequests(requests: ReviewRequest[]): Pick<ReviewReferralSummary, "reviewsRequested" | "reviewsResponded" | "reviewsCompleted" | "reviewsDeclined" | "reviewsFailed"> {
  return {
    reviewsRequested: requests.length,
    reviewsResponded: requests.filter((r) => r.status === "responded").length,
    reviewsCompleted: requests.filter((r) => r.status === "completed").length,
    reviewsDeclined: requests.filter((r) => r.status === "declined").length,
    reviewsFailed: requests.filter((r) => r.status === "failed").length,
  };
}

export function summarizeReferralRequests(requests: ReferralRequest[]): Pick<ReviewReferralSummary, "referralsRequested" | "referralsResponded" | "referralsConverted" | "referralsDeclined" | "referralsFailed"> {
  return {
    referralsRequested: requests.length,
    referralsResponded: requests.filter((r) => r.status === "responded").length,
    referralsConverted: requests.filter((r) => r.status === "converted").length,
    referralsDeclined: requests.filter((r) => r.status === "declined").length,
    referralsFailed: requests.filter((r) => r.status === "failed").length,
  };
}
