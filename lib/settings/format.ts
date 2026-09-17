const FALLBACK_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
];

/**
 * `Intl.supportedValuesOf` (Node 18+) returns the full, real list of IANA
 * timezone identifiers - no hardcoded list to keep in sync, no dependency.
 * Falls back to a small set of common US zones only if unavailable.
 */
export function getTimezoneOptions(): string[] {
  try {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.length > 0 ? zones : FALLBACK_TIMEZONES;
  } catch {
    return FALLBACK_TIMEZONES;
  }
}

export function isValidTimezone(timezone: string): boolean {
  return getTimezoneOptions().includes(timezone);
}

/**
 * Formats an "HH:MM" wall-clock string (from a native time input / stored
 * `time` column) as a friendly time - not a full Date/timestamp, so no
 * timezone conversion is involved or appropriate here.
 */
export function formatTimeOfDay(time: string | null): string {
  if (!time) return "";
  const [hoursRaw, minutesRaw] = time.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return time;

  const reference = new Date(2000, 0, 1, hours, minutes);
  return reference.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function formatMinutesDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours} hr${hours > 1 ? "s" : ""}`;
  return `${hours} hr ${remainder} min`;
}
