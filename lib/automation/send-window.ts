/**
 * Final Batch 1: the hard quiet-hours floor for automated customer-facing
 * SMS. No automated message may reach a customer before 08:00 or at/after
 * 21:00 in the organization's own timezone - whatever an automation's own
 * (optional) business-hours setting says. Business hours can only narrow
 * this window further, never widen it.
 *
 * The canonical outbound gate (evaluateOutboundGate) enforces it on every
 * automated send. A producer that can wait - the shared touch runtime and
 * the A4 follow-up dispatcher - also checks it BEFORE claiming a touch, so
 * the touch is deferred to the next allowed time instead of being claimed
 * and then blocked (which would use up its idempotency key for good).
 *
 * A human's own message from the inbox is not automated and is not subject
 * to this floor.
 *
 * Known, intentional limitations (no new scheduler or persistence was added):
 * - Event-driven automated sends (instant lead reply, AI customer reply,
 *   missed-call text, booking messages, n8n-drafted lifecycle messages) have
 *   no deferral mechanism: inside the floor the gate blocks them and the run
 *   completes as blocked - nothing is sent, and the conversation or lead
 *   surfaces on Today for a person (a new lead after 15 minutes).
 * - An A2 retry (automatic or manual) does not pass the pre-claim check -
 *   it reuses its claimed execution - so a retry that lands inside the floor
 *   is blocked at the gate and that retry is used up. Safe (nothing is sent),
 *   but the retry is not deferred.
 */
export const QUIET_HOURS_END_MINUTES = 8 * 60;
export const QUIET_HOURS_START_MINUTES = 21 * 60;

/** The organization's timezone if it is a real IANA zone, else UTC - the fallback only when no usable timezone exists. */
export function sendTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** True from 08:00 up to (not including) 21:00, local to `timeZone` (an unusable zone counts as UTC). */
export function isWithinQuietHoursFloor(now: Date, timeZone: string | null | undefined): boolean {
  const minutes = localMinutes(now, sendTimeZone(timeZone));
  return minutes >= QUIET_HOURS_END_MINUTES && minutes < QUIET_HOURS_START_MINUTES;
}

/**
 * The first moment at or after `from` at which `allowed` holds (15-minute steps, up to 8 days), or null if the
 * week has none. A producer passes the floor combined with its own business hours.
 */
export function nextAllowedSendTime(from: Date, allowed: (at: Date) => boolean): Date | null {
  if (allowed(from)) return from;
  const step = 15 * 60 * 1000;
  const limit = from.getTime() + 8 * 24 * 60 * 60 * 1000;
  for (let t = Math.ceil(from.getTime() / step) * step; t <= limit; t += step) {
    if (allowed(new Date(t))) return new Date(t);
  }
  return null;
}
