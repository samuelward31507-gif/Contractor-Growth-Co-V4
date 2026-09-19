import type { ReviewRequestStatus, ReferralRequestStatus } from "./queries";

export const REVIEW_STATUS_LABELS: Record<ReviewRequestStatus, string> = {
  not_requested: "Not requested",
  requested: "Requested",
  responded: "Responded",
  completed: "Completed",
  declined: "Declined",
  failed: "Failed",
};

export const REFERRAL_STATUS_LABELS: Record<ReferralRequestStatus, string> = {
  not_requested: "Not requested",
  requested: "Requested",
  responded: "Responded",
  converted: "Converted",
  declined: "Declined",
  failed: "Failed",
};

// Same restrained palette convention as lib/jobs/format.ts: neutral for
// in-flight states, one accent each for the closed outcomes.
export const REVIEW_STATUS_DOT_CLASS: Record<ReviewRequestStatus, string> = {
  not_requested: "bg-slate-300",
  requested: "bg-blue-500",
  responded: "bg-amber-500",
  completed: "bg-emerald-500",
  declined: "bg-slate-400",
  failed: "bg-red-500",
};

export const REFERRAL_STATUS_DOT_CLASS: Record<ReferralRequestStatus, string> = {
  not_requested: "bg-slate-300",
  requested: "bg-blue-500",
  responded: "bg-amber-500",
  converted: "bg-emerald-500",
  declined: "bg-slate-400",
  failed: "bg-red-500",
};
