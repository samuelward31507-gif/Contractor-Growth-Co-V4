import type { AppointmentStatus } from "./queries";

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-Show",
};

// Restrained palette, consistent with the Leads badge convention: neutral
// for the working states, one accent each for the two closed outcomes.
export const STATUS_BADGE_CLASS: Record<AppointmentStatus, string> = {
  scheduled: "bg-slate-100 text-slate-700",
  confirmed: "bg-blue-50 text-blue-700",
  completed: "bg-emerald-50 text-emerald-700",
  cancelled: "bg-red-50 text-red-600",
  no_show: "bg-amber-50 text-amber-700",
};

/**
 * All date/time logic for Appointments lives here, in one place, rather
 * than scattered through components. This app has no per-organization
 * timezone field (confirmed against the live schema), so - consistent with
 * every other date/time display already in this codebase (Contacts, Leads,
 * the dashboard) - these run in whatever timezone the rendering runtime is
 * in. This is an existing, app-wide characteristic, not something new
 * introduced here.
 */
export function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function getDayGroupLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (isSameCalendarDay(date, now)) return "Today";

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (isSameCalendarDay(date, tomorrow)) return "Tomorrow";

  return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

export function formatAppointmentTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function formatAppointmentTimeRange(startIso: string, endIso: string): string {
  return `${formatAppointmentTime(startIso)} – ${formatAppointmentTime(endIso)}`;
}

export function formatAppointmentDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function formatAppointmentDuration(startIso: string, endIso: string): string {
  const minutes = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours} hr${hours > 1 ? "s" : ""}`;
  return `${hours} hr ${remainder} min`;
}
