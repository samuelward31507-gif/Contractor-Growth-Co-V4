import type { ReviewRequestStatus, ReferralRequestStatus } from "./queries";
import { STATUS_DOT_TONE_CLASS } from "@/lib/ui/status-vocabulary";

export const REVIEW_STATUS_LABELS: Record<ReviewRequestStatus, string> = {
  not_requested: "Not Requested",
  requested: "Requested",
  responded: "Responded",
  completed: "Completed",
  declined: "Declined",
  failed: "Failed",
};

export const REFERRAL_STATUS_LABELS: Record<ReferralRequestStatus, string> = {
  not_requested: "Not Requested",
  requested: "Requested",
  responded: "Responded",
  converted: "Converted",
  declined: "Declined",
  failed: "Failed",
};

// Same restrained palette convention as lib/jobs/format.ts: neutral for
// in-flight states, one accent each for the closed outcomes.
export const REVIEW_STATUS_DOT_CLASS: Record<ReviewRequestStatus, string> = {
  not_requested: STATUS_DOT_TONE_CLASS.muted,
  requested: STATUS_DOT_TONE_CLASS.progress,
  responded: STATUS_DOT_TONE_CLASS.attention,
  completed: STATUS_DOT_TONE_CLASS.success,
  declined: STATUS_DOT_TONE_CLASS.neutral,
  failed: STATUS_DOT_TONE_CLASS.danger,
};

export const REFERRAL_STATUS_DOT_CLASS: Record<ReferralRequestStatus, string> = {
  not_requested: STATUS_DOT_TONE_CLASS.muted,
  requested: STATUS_DOT_TONE_CLASS.progress,
  responded: STATUS_DOT_TONE_CLASS.attention,
  converted: STATUS_DOT_TONE_CLASS.success,
  declined: STATUS_DOT_TONE_CLASS.neutral,
  failed: STATUS_DOT_TONE_CLASS.danger,
};
