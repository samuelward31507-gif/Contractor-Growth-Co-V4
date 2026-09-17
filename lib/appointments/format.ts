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
 * than scattered through components. Historically this app had no
 * per-organization timezone field, so every function here ran in whatever
 * timezone the rendering runtime was in. Organizations now have a
 * configured `timezone` (IANA identifier, e.g. "America/Denver") - each
 * display function below accepts it as an optional parameter and passes it
 * straight to `Intl`, with no new dependency. When omitted, behavior is
 * byte-for-byte identical to before (runtime-local), so existing callers
 * that don't pass one are completely unaffected. Only the two Appointments
 * pages currently pass it through; this only changes DISPLAY - the write
 * path (turning entered date/time into a stored instant) is unchanged and
 * still uses the server's local interpretation, a known, documented
 * asymmetry rather than a full timezone rewrite.
 */
export function isSameCalendarDay(a: Date, b: Date, timeZone?: string): boolean {
  if (!timeZone) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  const format = (date: Date) => date.toLocaleDateString("en-US", { timeZone });
  return format(a) === format(b);
}

export function getDayGroupLabel(iso: string, now: Date = new Date(), timeZone?: string): string {
  const date = new Date(iso);
  if (isSameCalendarDay(date, now, timeZone)) return "Today";

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (isSameCalendarDay(date, tomorrow, timeZone)) return "Tomorrow";

  return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone });
}

export function formatAppointmentTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

export function formatAppointmentTimeRange(startIso: string, endIso: string, timeZone?: string): string {
  return `${formatAppointmentTime(startIso, timeZone)} – ${formatAppointmentTime(endIso, timeZone)}`;
}

export function formatAppointmentDate(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
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
