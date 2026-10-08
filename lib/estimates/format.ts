import type { EstimateStatus } from "./queries";
import { STATUS_DOT_TONE_CLASS } from "@/lib/ui/status-vocabulary";

export const STATUS_LABELS: Record<EstimateStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
};

// Same restrained palette convention as lib/leads/format.ts: neutral for the
// working pipeline, one accent each for the closed outcomes.
export const STATUS_DOT_CLASS: Record<EstimateStatus, string> = {
  draft: STATUS_DOT_TONE_CLASS.neutral,
  sent: STATUS_DOT_TONE_CLASS.progress,
  accepted: STATUS_DOT_TONE_CLASS.success,
  declined: STATUS_DOT_TONE_CLASS.danger,
  cancelled: STATUS_DOT_TONE_CLASS.muted,
  expired: STATUS_DOT_TONE_CLASS.attention,
};
