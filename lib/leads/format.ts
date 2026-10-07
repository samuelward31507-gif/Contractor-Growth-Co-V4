import type { LeadStatus, LeadTemperature } from "./queries";
import { STATUS_DOT_TONE_CLASS } from "@/lib/ui/status-vocabulary";

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  appointment: "Appointment",
  estimate: "Estimate",
  won: "Won",
  lost: "Lost",
};

export const TEMPERATURE_LABELS: Record<LeadTemperature, string> = {
  cold: "Cold",
  warm: "Warm",
  hot: "Hot",
};

// Restrained palette: neutral for the working pipeline, one accent each for
// the two closed outcomes, so status never turns into a rainbow of colors.
// Rendered as a small dot next to plain text (see badges.tsx) rather than a
// filled pill - color signals the distinction, it doesn't have to shout it.
export const STATUS_DOT_CLASS: Record<LeadStatus, string> = {
  new: STATUS_DOT_TONE_CLASS.neutral,
  contacted: STATUS_DOT_TONE_CLASS.neutral,
  qualified: STATUS_DOT_TONE_CLASS.neutral,
  appointment: STATUS_DOT_TONE_CLASS.progress,
  estimate: STATUS_DOT_TONE_CLASS.attention,
  won: STATUS_DOT_TONE_CLASS.success,
  lost: STATUS_DOT_TONE_CLASS.danger,
};

export const TEMPERATURE_DOT_CLASS: Record<LeadTemperature, string> = {
  cold: STATUS_DOT_TONE_CLASS.muted,
  warm: STATUS_DOT_TONE_CLASS.attention,
  hot: STATUS_DOT_TONE_CLASS.danger,
};
