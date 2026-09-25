import type { BusinessHour } from "@/lib/settings/queries";

/**
 * Pass 2 (Native Calendar System): pure positioning math for the Day/Week
 * time-grid views. No I/O, no wall-clock read - fully deterministic and
 * unit-testable, matching this codebase's own pure/impure split convention.
 */

export const HOUR_HEIGHT_PX = 60;

/** The organization-local minutes-since-midnight a given instant falls at - never assumes UTC or server-local. */
export function localMinutesSinceMidnight(iso: string, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function parseTimeToMinutes(time: string | null): number | null {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export type GridBounds = { startHour: number; endHour: number };

const DEFAULT_BOUNDS: GridBounds = { startHour: 7, endHour: 19 };

/**
 * The visible hour range for the grid - derived from the organization's own
 * configured business hours (earliest open, latest close across every open
 * day), not a fixed, possibly-wrong assumption. Falls back to a sane
 * default (7am-7pm) only when business hours are not configured at all, so
 * the grid never renders as a single, useless row. Always widened to
 * include midnight-crossing appointment times if genuinely present (an
 * appointment/blocked-time outside business hours must still be visible,
 * never clipped off the grid), via the optional `extraMinutes` values a
 * caller can pass in.
 */
export function getGridBounds(businessHours: BusinessHour[], extraMinutes: number[] = []): GridBounds {
  let minStart = Infinity;
  let maxEnd = -Infinity;

  for (const hour of businessHours) {
    if (!hour.is_open) continue;
    const open = parseTimeToMinutes(hour.open_time);
    const close = parseTimeToMinutes(hour.close_time);
    if (open === null || close === null) continue;
    minStart = Math.min(minStart, open);
    maxEnd = Math.max(maxEnd, close);
  }

  for (const minutes of extraMinutes) {
    minStart = Math.min(minStart, minutes);
    maxEnd = Math.max(maxEnd, minutes);
  }

  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd) || maxEnd <= minStart) {
    return DEFAULT_BOUNDS;
  }

  const startHour = Math.max(0, Math.floor(minStart / 60));
  const endHour = Math.min(24, Math.ceil(maxEnd / 60));
  return { startHour, endHour };
}

export type BlockPosition = { topPx: number; heightPx: number };

/** Vertical position/height (px) for a [startMinutes, endMinutes) span within a grid starting at bounds.startHour. Clamped to the visible grid - an appointment that starts before the grid or ends after it is still rendered, just visually cropped at the edge, never causing negative/absurd values. */
export function computeBlockPosition(startMinutes: number, endMinutes: number, bounds: GridBounds): BlockPosition {
  const gridStartMinutes = bounds.startHour * 60;
  const gridEndMinutes = bounds.endHour * 60;
  const clampedStart = Math.max(startMinutes, gridStartMinutes);
  const clampedEnd = Math.min(Math.max(endMinutes, clampedStart + 15), gridEndMinutes);
  const topPx = (clampedStart - gridStartMinutes) * (HOUR_HEIGHT_PX / 60);
  const heightPx = Math.max(18, (clampedEnd - clampedStart) * (HOUR_HEIGHT_PX / 60));
  return { topPx, heightPx };
}
