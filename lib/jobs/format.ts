import type { JobStatus } from "./queries";
import { STATUS_DOT_TONE_CLASS } from "@/lib/ui/status-vocabulary";

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
  scheduled: STATUS_DOT_TONE_CLASS.neutral,
  in_progress: STATUS_DOT_TONE_CLASS.progress,
  completed: STATUS_DOT_TONE_CLASS.success,
  cancelled: STATUS_DOT_TONE_CLASS.muted,
};
