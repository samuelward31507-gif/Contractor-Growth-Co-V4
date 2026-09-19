import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * The single authorization gate every scheduled-automation HTTP endpoint
 * (app/api/automation/appointment-reminders, estimate-followups,
 * lead-nurture, lead-reactivation) must call before doing anything.
 * Previously each route reimplemented this itself, and two of the four
 * (lead-nurture, lead-reactivation) used a plain `===` string comparison
 * instead of a constant-time one - a real, if narrow, timing-attack
 * surface, unlike appointment-reminders/estimate-followups, which already
 * used `timingSafeEqual`. This is now the one implementation all four
 * routes share, so that inconsistency can't recur.
 *
 * Fails closed: an unset CRON_SECRET, a missing Authorization header, or a
 * length mismatch (checked before timingSafeEqual, which requires
 * equal-length buffers) are all "not authorized" - there is no
 * default-allow path.
 *
 * This endpoint is invoked over plain HTTP by whatever external scheduler
 * calls it (Vercel Cron previously; an n8n Schedule Trigger now - see
 * vercel.json's removed `crons` array and the "Trackpr Scheduled
 * Automations" n8n workflow) - it is deliberately not scoped to Vercel's
 * own cron invocation mechanism, since the whole point of this file is to
 * let a different scheduler safely stand in for it.
 */
export function isAuthorizedCronRequest(request: NextRequest): boolean {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) return false;

  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;

  const expected = Buffer.from(`Bearer ${configuredSecret}`);
  const actual = Buffer.from(authHeader);
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}
