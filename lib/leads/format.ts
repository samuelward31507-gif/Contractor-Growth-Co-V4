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
export const STATUS_BADGE_CLASS: Record<LeadStatus, string> = {
  new: "bg-slate-100 text-slate-700",
  contacted: "bg-slate-100 text-slate-700",
  qualified: "bg-slate-100 text-slate-700",
  appointment: "bg-blue-50 text-blue-700",
  estimate: "bg-amber-50 text-amber-700",
  won: "bg-emerald-50 text-emerald-700",
  lost: "bg-red-50 text-red-600",
};

export const TEMPERATURE_BADGE_CLASS: Record<LeadTemperature, string> = {
  cold: "bg-slate-100 text-slate-500",
  warm: "bg-amber-50 text-amber-600",
  hot: "bg-red-50 text-red-600",
};
