import { zonedWallTimeToUtc } from "@/lib/scheduling/availability";
import { resolveTimeZone } from "@/lib/format/datetime";

/**
 * Job scheduling state (jobs.scheduled_for - supabase/pending/job_scheduled_for.sql).
 *
 * jobs.status keeps its meaning: 'scheduled' is the job's starting state
 * (not started), set the moment an accepted estimate creates the job.
 * Whether the work has actually been booked with the customer is
 * scheduled_for alone: null until the contractor sets the date and time on
 * the job page.
 *
 * Pure: no I/O, no clock - every caller passes the data and the
 * organization's timezone.
 */

/** The one rule Today and the person's next step share: an approved job whose work has not been scheduled yet. */
export function isApprovedJobAwaitingSchedule(job: { status: string; estimate_id: string | null; scheduled_for: string | null | undefined }, estimateStatus: string | null | undefined): boolean {
  // undefined scheduled_for = not read (an older caller) - never treated as unscheduled.
  if (job.scheduled_for !== null) return false;
  // Not started yet. Once the work is under way (or done, or cancelled) there is nothing left to schedule.
  if (job.status !== "scheduled") return false;
  // Created from an estimate the customer accepted - a directly created job has no approval to act on.
  return job.estimate_id !== null && estimateStatus === "accepted";
}

export type JobScheduleParse = { scheduledFor: string | null; error?: undefined } | { scheduledFor?: undefined; error: string };

/**
 * Parses the job page's plain date ("YYYY-MM-DD") and time ("HH:MM")
 * inputs as wall-clock time in the organization's timezone - the same
 * convention and the same DST-safe conversion (zonedWallTimeToUtc) the
 * appointment form uses - into the instant stored in scheduled_for. Both
 * empty clears the schedule (null). Out-of-range values are rejected rather
 * than rolled over into another day.
 */
export function parseJobSchedule(dateRaw: string, timeRaw: string, timeZone: string | null | undefined): JobScheduleParse {
  const date = dateRaw.trim();
  const time = timeRaw.trim();
  if (!date && !time) return { scheduledFor: null };
  if (!date || !time) return { error: "Enter both a date and a time." };

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) return { error: "Enter a valid date and time." };

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59) {
    return { error: "Enter a valid date and time." };
  }

  const instant = zonedWallTimeToUtc(year, month, day, hour * 60 + minute, resolveTimeZone(timeZone));
  if (Number.isNaN(instant.getTime())) return { error: "Enter a valid date and time." };
  return { scheduledFor: instant.toISOString() };
}

/** The date/time input values for a stored instant, as wall-clock time in the organization's timezone (empty when unscheduled). */
export function jobScheduleInputValues(scheduledFor: string | null, timeZone: string | null | undefined): { date: string; time: string } {
  if (!scheduledFor) return { date: "", time: "" };
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(scheduledFor))) {
    parts[part.type] = part.value;
  }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
