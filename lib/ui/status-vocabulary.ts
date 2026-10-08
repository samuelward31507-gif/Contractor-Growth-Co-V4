/**
 * Batch 1 (Cinder design foundation): the shared status display
 * vocabulary - how a status READS, never what it means. Lifecycle logic,
 * database enums and decision-engine semantics are untouched; every
 * domain's own label map points its display strings here so the same
 * state reads the same way on every page (Title Case, one spelling).
 */
export const STATUS_LABEL = {
  new: "New",
  draft: "Draft",
  scheduled: "Scheduled",
  booked: "Booked",
  confirmed: "Confirmed",
  sent: "Sent",
  requested: "Requested",
  responded: "Responded",
  inProgress: "In Progress",
  partiallyPaid: "Partially Paid",
  paid: "Paid",
  accepted: "Accepted",
  completed: "Completed",
  converted: "Converted",
  won: "Won",
  lost: "Lost",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
  void: "Void",
  failed: "Failed",
  noShow: "No-Show",
  notRequested: "Not Requested",
  needsAttention: "Needs Attention",
  healthy: "Healthy",
  active: "Active",
  paused: "Paused",
  disabled: "Disabled",
  noActivity: "No Activity",
  notConfigured: "Not Configured",
  configured: "Configured",
} as const;

/** Display fallback for a raw value with no entry above: "partially_paid" -> "Partially Paid". */
export function statusDisplayLabel(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Unknown";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

/**
 * The semantic status colors - the only colors a status dot or rail may
 * use (no raw Tailwind palette classes):
 *   success   -> pine (done, won, paid, healthy, active)
 *   attention -> warning amber (needs a look, waiting on someone)
 *   progress  -> strong ink (in flight, moving forward)
 *   neutral   -> muted ink (not started, early pipeline)
 *   muted     -> hairline (closed without outcome, inactive)
 *   danger    -> danger (failed, lost, critical)
 */
export type StatusTone = "success" | "attention" | "progress" | "neutral" | "muted" | "danger";

export const STATUS_DOT_TONE_CLASS: Record<StatusTone, string> = {
  success: "bg-accent",
  attention: "bg-warning",
  progress: "bg-ink-2",
  neutral: "bg-ink-4",
  muted: "bg-line-strong",
  danger: "bg-danger",
};

export const STATUS_TEXT_TONE_CLASS: Record<StatusTone, string> = {
  success: "text-accent-text",
  attention: "text-warning-text",
  progress: "text-ink-2",
  neutral: "text-ink-3",
  muted: "text-ink-3",
  danger: "text-danger-text",
};
