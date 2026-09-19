import { CheckCircle2, AlertTriangle, CircleDashed, CircleSlash, PauseCircle, type LucideIcon } from "lucide-react";
import type { BadgeTone } from "@/lib/ui/badge";
import type { AutomationDisplayStatus } from "@/lib/automation/queries";

/**
 * Single source of truth for how an AutomationDisplayStatus (computed
 * server-side in lib/automation/queries.ts) maps onto the shared Badge
 * primitive - used by both the list page (automation-list.tsx) and the
 * detail page header, replacing the old duplicated status-pill.tsx.
 */
export const AUTOMATION_STATUS_BADGE: Record<AutomationDisplayStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  active: { label: "Active", tone: "success", icon: CheckCircle2 },
  attention: { label: "Attention", tone: "warning", icon: AlertTriangle },
  no_activity: { label: "No activity", tone: "neutral", icon: CircleDashed },
  not_configured: { label: "Not configured", tone: "neutral", icon: CircleSlash },
  disabled: { label: "Disabled", tone: "neutral", icon: PauseCircle },
};

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "seconds" },
  { amount: 60, unit: "minutes" },
  { amount: 24, unit: "hours" },
  { amount: 7, unit: "days" },
  { amount: 4.34524, unit: "weeks" },
  { amount: 12, unit: "months" },
  { amount: Number.POSITIVE_INFINITY, unit: "years" },
];

export function formatRelativeTime(iso: string): string {
  let duration = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return relativeTimeFormatter.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return relativeTimeFormatter.format(Math.round(duration), "years");
}

export function formatDateTime(iso: string): string {
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
