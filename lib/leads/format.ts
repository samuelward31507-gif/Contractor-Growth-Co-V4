import type { LeadStatus, LeadTemperature } from "./queries";

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
  new: "bg-slate-400",
  contacted: "bg-slate-400",
  qualified: "bg-slate-400",
  appointment: "bg-blue-500",
  estimate: "bg-amber-500",
  won: "bg-emerald-500",
  lost: "bg-red-400",
};

export const TEMPERATURE_DOT_CLASS: Record<LeadTemperature, string> = {
  cold: "bg-slate-300",
  warm: "bg-amber-500",
  hot: "bg-red-500",
};
