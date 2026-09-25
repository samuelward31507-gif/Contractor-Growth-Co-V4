/**
 * Pass 2 (Native Calendar System): structural tests for the calendar's
 * one-click status/reschedule actions added to
 * app/(app)/appointments/actions.ts (updateAppointmentStatus,
 * rescheduleAppointmentTime, and the applyAppointmentUpdate helper they
 * share with the full edit form's updateAppointment). These call
 * cookies()-dependent requireOrganization()/createClient(), so - matching
 * this codebase's own established convention for testing this exact kind
 * of Server Action (see actions.timezone.test.ts's own header comment) -
 * they can't be invoked directly from a bare node:test script; this file
 * verifies the real source instead.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/appointments/actions.calendar-quick-actions.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(app)/appointments/actions.ts"), "utf8");

function extractFunction(name: string): string {
  const match = SOURCE.match(new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(match, `expected to find ${name}`);
  return match![0];
}

test("1. updateAppointmentStatus and rescheduleAppointmentTime both resolve the organization via requireOrganization() - never a client-supplied organization id", () => {
  const status = extractFunction("updateAppointmentStatus");
  const reschedule = extractFunction("rescheduleAppointmentTime");
  assert.match(status, /requireOrganization\(\)/);
  assert.match(reschedule, /requireOrganization\(\)/);
});

test("2. updateAppointmentStatus rejects any status outside the real appointment status enum before ever writing", () => {
  const body = extractFunction("updateAppointmentStatus");
  assert.match(body, /CONFIRMABLE_STATUSES\.includes\(status\)/);
});

test("3. updateAppointmentStatus and rescheduleAppointmentTime both call the SAME applyAppointmentUpdate helper updateAppointment itself uses - never a second, parallel write/automation-dispatch implementation", () => {
  const status = extractFunction("updateAppointmentStatus");
  const reschedule = extractFunction("rescheduleAppointmentTime");
  const updateAppointment = extractFunction("updateAppointment");
  assert.match(status, /applyAppointmentUpdate\(/);
  assert.match(reschedule, /applyAppointmentUpdate\(/);
  assert.match(updateAppointment, /applyAppointmentUpdate\(/);
});

test("4. applyAppointmentUpdate itself dispatches through emitAppointmentTransitions AND syncAppointmentEditToGoogle - the exact same lifecycle automation and Google sync the full edit form already used, never duplicated calendar-only logic", () => {
  const helperMatch = SOURCE.match(/async function applyAppointmentUpdate\([\s\S]*?\n\}/);
  assert.ok(helperMatch, "expected to find applyAppointmentUpdate");
  const body = helperMatch![0];
  assert.match(body, /emitAppointmentTransitions\(/);
  assert.match(body, /syncAppointmentEditToGoogle\(/);
});

test("5. rescheduleAppointmentTime re-validates the new time against BOTH real appointment conflicts and blocked time, server-side, before ever writing", () => {
  const body = extractFunction("rescheduleAppointmentTime");
  const overlapIndex = body.indexOf("checkAppointmentOverlap(");
  const blockedIndex = body.indexOf("checkBlockedTimeOverlap(");
  const writeIndex = body.indexOf("applyAppointmentUpdate(");
  assert.ok(overlapIndex !== -1 && blockedIndex !== -1 && writeIndex !== -1);
  assert.ok(overlapIndex < writeIndex && blockedIndex < writeIndex, "both conflict checks must run BEFORE the actual write");
});

test("6. rescheduleAppointmentTime converts wall-clock date/startTime/endTime via the existing zonedWallTimeToUtc - never trusts a client-computed ISO instant", () => {
  const body = extractFunction("rescheduleAppointmentTime");
  assert.match(body, /zonedWallTimeToUtc\(/);
  assert.doesNotMatch(body, /new Date\(startAt\)/, "must never construct the stored instant from a raw client-sent string");
});

test("7. rescheduleAppointmentTime resolves the organization's real configured timezone - never a hardcoded zone", () => {
  const body = extractFunction("rescheduleAppointmentTime");
  assert.match(body, /getOrganizationTimezone\(supabase, organizationId\)/);
});

test("8. updateAppointmentStatus and rescheduleAppointmentTime both revalidate /calendar in addition to the existing /appointments paths, so the calendar reflects the change immediately", () => {
  const status = extractFunction("updateAppointmentStatus");
  const reschedule = extractFunction("rescheduleAppointmentTime");
  assert.match(status, /revalidatePath\("\/calendar"\)/);
  assert.match(reschedule, /revalidatePath\("\/calendar"\)/);
});

test("9. Pass 5B, Part A5: applyAppointmentUpdate computes confirmation invalidation via computeConfirmationInvalidationOnTimeChange and merges it into the SAME write both the one-click reschedule action and the full edit form share - never a second, parallel invalidation implementation", () => {
  const helperMatch = SOURCE.match(/async function applyAppointmentUpdate\([\s\S]*?\n\}/);
  assert.ok(helperMatch, "expected to find applyAppointmentUpdate");
  const body = helperMatch![0];
  assert.match(body, /computeConfirmationInvalidationOnTimeChange\(/);
  assert.match(body, /fieldsWithInvalidation/, "the invalidation result must actually be merged into the write payload, not just computed and discarded");
});

test("10. Pass 5B, Part A5: the lifecycle-dispatch/Google-sync decision (`next.status`) reads from the POST-invalidation fields, never the raw pre-invalidation ones - otherwise a confirmed->scheduled reversion would be silently ignored by the rest of the same save", () => {
  const helperMatch = SOURCE.match(/async function applyAppointmentUpdate\([\s\S]*?\n\}/);
  assert.ok(helperMatch);
  const body = helperMatch![0];
  assert.match(body, /status:\s*fieldsWithInvalidation\.status\s*\?\?\s*previous\.status/);
});
