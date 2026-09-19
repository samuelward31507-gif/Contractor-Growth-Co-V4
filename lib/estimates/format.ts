import type { EstimateStatus } from "./queries";

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
  draft: "bg-slate-400",
  sent: "bg-blue-500",
  accepted: "bg-emerald-500",
  declined: "bg-red-400",
  cancelled: "bg-slate-300",
  expired: "bg-amber-500",
};
