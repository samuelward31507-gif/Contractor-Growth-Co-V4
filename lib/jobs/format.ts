import type { JobStatus } from "./queries";

export const STATUS_LABELS: Record<JobStatus, string> = {
  scheduled: "Scheduled",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

// Same restrained palette convention as lib/leads/format.ts and
// lib/estimates/format.ts: neutral for the working pipeline, one accent
// each for the closed outcomes.
export const STATUS_DOT_CLASS: Record<JobStatus, string> = {
  scheduled: "bg-slate-400",
  in_progress: "bg-blue-500",
  completed: "bg-emerald-500",
  cancelled: "bg-slate-300",
};
