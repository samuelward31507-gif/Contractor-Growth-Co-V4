/**
 * Structural test for the appointment-creation timezone fix
 * (app/(app)/appointments/actions.ts). Production bug: entering "2:00 PM" in
 * the Add Appointment dialog stored and later displayed the appointment as
 * "7:00 AM" - `parseAppointmentForm` built the stored instant with
 * `new Date(`${date}T${startTime}`)`, which Node parses as the SERVER's
 * local time (UTC in production), not the organization's configured
 * timezone. The fix reuses `zonedWallTimeToUtc` from
 * lib/scheduling/availability.ts (the same DST-safe conversion already used
 * for booking/availability, already covered by its own test suite) instead
 * of reimplementing timezone math here.
 *
 * createAppointment/updateAppointment call cookies()-dependent
 * createClient() via requireOrganization(), so they can't be invoked
 * directly from a bare node:test script - verified against the real source,
 * the same convention already used throughout this codebase's other
 * Server Action tests.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/appointments/actions.timezone.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(app)/appointments/actions.ts"), "utf8");

test("1. the old buggy pattern (assigning startAt/endAt directly from `new Date(...)`, parsed as server-local/UTC time) is gone from the live code - only referenced in the explanatory comment above the fix", () => {
  assert.doesNotMatch(SOURCE, /const startAt = new Date\(/);
  assert.doesNotMatch(SOURCE, /const endAt = new Date\(/);
});

test("2. the fix reuses the existing DST-safe zonedWallTimeToUtc helper from lib/scheduling/availability - not a new/duplicated timezone implementation", () => {
  assert.match(SOURCE, /import \{ zonedWallTimeToUtc \} from "@\/lib\/scheduling\/availability";/);
  const matches = SOURCE.match(/zonedWallTimeToUtc\(/g) ?? [];
  // Pass 2 (Native Calendar System) added rescheduleAppointmentTime, the
  // calendar's own compact reschedule action - it converts its own
  // start/end via this SAME helper (2 more calls) rather than
  // reimplementing the conversion, so the total rose from 2 to 4. Still
  // exactly one real implementation of the conversion, now with more
  // legitimate call sites - never a second, divergent one.
  assert.equal(matches.length, 4, "expected exactly four calls - two in parseAppointmentForm (startAt/endAt), two in rescheduleAppointmentTime (startAt/endAt)");
});

test("3. the organization's timezone is read via the existing getOrganizationTimezone accessor, not a new query or a hardcoded zone", () => {
  assert.match(SOURCE, /import \{ getOrganizationTimezone \} from "@\/lib\/settings\/queries";/);
  assert.doesNotMatch(SOURCE, /America\/Denver/, "must never hardcode a specific timezone - each organization's own configured value must be used");
});

test("4. the UTC fallback (only used when an organization somehow has no timezone configured) matches the established pattern elsewhere in this codebase (lib/scheduling/booking.ts), not an invented default", () => {
  assert.match(SOURCE, /getOrganizationTimezone\(supabase, organizationId\)\) \?\? "UTC"/g);
});

test("5. createAppointment resolves organizationId and timeZone BEFORE parsing the form - the fix requires knowing the org's timezone before any date math happens", () => {
  const fnMatch = SOURCE.match(/export async function createAppointment\([\s\S]*?\n\}/);
  assert.ok(fnMatch, "expected to find createAppointment");
  const body = fnMatch![0];
  const orgIndex = body.indexOf("requireOrganization()");
  const timezoneIndex = body.indexOf("getOrganizationTimezone(");
  const parseIndex = body.indexOf("parseAppointmentForm(");
  assert.ok(orgIndex !== -1 && timezoneIndex !== -1 && parseIndex !== -1);
  assert.ok(orgIndex < timezoneIndex && timezoneIndex < parseIndex, "organization/timezone must be resolved before parseAppointmentForm is called");
});

test("6. updateAppointment resolves organizationId and timeZone BEFORE parsing the form, identically to createAppointment", () => {
  const fnMatch = SOURCE.match(/export async function updateAppointment\([\s\S]*?\n {2}const relationshipError/);
  assert.ok(fnMatch, "expected to find updateAppointment up through its relationship check");
  const body = fnMatch![0];
  const orgIndex = body.indexOf("requireOrganization()");
  const timezoneIndex = body.indexOf("getOrganizationTimezone(");
  const parseIndex = body.indexOf("parseAppointmentForm(");
  assert.ok(orgIndex !== -1 && timezoneIndex !== -1 && parseIndex !== -1);
  assert.ok(orgIndex < timezoneIndex && timezoneIndex < parseIndex, "organization/timezone must be resolved before parseAppointmentForm is called");
});

test("7. parseAppointmentForm takes timeZone as an explicit parameter - the conversion is never implicit/ambient", () => {
  assert.match(SOURCE, /function parseAppointmentForm\(formData: FormData, timeZone: string\)/);
});

test("8. date/time strings are strictly validated (regex-anchored) before being fed to zonedWallTimeToUtc, rejecting malformed input with the existing user-facing error rather than propagating NaN", () => {
  assert.match(SOURCE, /\/\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)\$\//);
  assert.match(SOURCE, /if \(!dateMatch \|\| !startMatch \|\| !endMatch\)/);
});
