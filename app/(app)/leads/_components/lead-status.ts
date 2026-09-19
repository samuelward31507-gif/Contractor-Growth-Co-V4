import type { LeadStatus, LeadTemperature } from "@/lib/leads/queries";
import type { BadgeTone } from "@/lib/ui/badge";

/**
 * Maps the lead pipeline's own status/temperature enums onto the app's one
 * shared Badge tone set (lib/ui/badge.tsx). The working pipeline (new →
 * qualified) stays neutral/info so it doesn't compete for attention; the two
 * closed outcomes get the outcome tones (won → success, lost → danger); a
 * lead actively at the estimate stage reads as warning (time-sensitive).
 */
export const LEAD_STATUS_TONE: Record<LeadStatus, BadgeTone> = {
  new: "neutral",
  contacted: "neutral",
  qualified: "info",
  appointment: "info",
  estimate: "warning",
  won: "success",
  lost: "danger",
};

/** Hot leads get the danger tone so they visually jump out of a scanned list - this is the "easy to scan for hot leads" requirement's primary mechanism. */
export const LEAD_TEMPERATURE_TONE: Record<LeadTemperature, BadgeTone> = {
  cold: "neutral",
  warm: "warning",
  hot: "danger",
};
