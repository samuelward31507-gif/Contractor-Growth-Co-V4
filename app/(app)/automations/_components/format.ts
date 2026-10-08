import { CheckCircle2, AlertTriangle, CircleDashed, CircleSlash, PauseCircle, type LucideIcon } from "lucide-react";
import type { BadgeTone } from "@/lib/ui/badge";
import type { AutomationDisplayStatus } from "@/lib/automation/queries";
import { formatDateTime as formatCanonicalDateTime } from "@/lib/format/datetime";

/**
 * Single source of truth for how an AutomationDisplayStatus (computed
 * server-side in lib/automation/queries.ts) maps onto the shared Badge
 * primitive - used by both the list page (automation-list.tsx) and the
 * detail page header, replacing the old duplicated status-pill.tsx.
 */
export const AUTOMATION_STATUS_BADGE: Record<AutomationDisplayStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  active: { label: "Active", tone: "success", icon: CheckCircle2 },
  attention: { label: "Needs Attention", tone: "warning", icon: AlertTriangle },
  no_activity: { label: "No Activity", tone: "neutral", icon: CircleDashed },
  not_configured: { label: "Not Configured", tone: "neutral", icon: CircleSlash },
  disabled: { label: "Disabled", tone: "neutral", icon: PauseCircle },
};

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

// Batch 1: the canonical date/time path (lib/format/datetime.ts).
export { formatRelativeTime } from "@/lib/format/datetime";

/**
 * "Oct 9, 2026, 2:00 PM". With the organization's timezone it renders on
 * the canonical path; without one, the legacy runtime-local rendering is
 * kept unchanged for existing callers.
 */
export function formatDateTime(iso: string, timeZone?: string | null): string {
  if (timeZone) return formatCanonicalDateTime(iso, timeZone);
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}
