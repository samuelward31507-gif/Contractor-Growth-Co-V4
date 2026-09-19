/**
 * Unit tests for isReminderDue() - the pure eligibility check behind both
 * processAppointmentReminders and previewAppointmentReminders (Automation
 * Configuration V1). This file transitively imports several "@/"-aliased
 * modules, so it needs the same resolution bridge as retry.test.ts - see
 * lib/automation/test-loader.mjs. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/appointment-reminders.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isReminderDue }: typeof import("./appointment-reminders") = require("./appointment-reminders.ts");

const NOW = new Date("2026-09-19T12:00:00.000Z");

function hoursFromNow(hours: number): string {
  return new Date(NOW.getTime() + hours * 60 * 60 * 1000).toISOString();
}

test("Config 9: an appointment 30 hours out is NOT due under the default 24h config - the old hardcoded window would never have caught it", () => {
  const appointment = { start_at: hoursFromNow(30), updated_at: hoursFromNow(-100) };

  assert.equal(isReminderDue(appointment, { reminder_lead_time_hours: 24 }, NOW), false);
});

test("Config 9b: the exact same appointment IS due once its organization configures a 48-hour lead time, proving the configured value - not a hardcoded 24h constant - drives the result", () => {
  const appointment = { start_at: hoursFromNow(30), updated_at: hoursFromNow(-100) };

  assert.equal(isReminderDue(appointment, { reminder_lead_time_hours: 48 }, NOW), true);
});

test("Config 9c: an appointment more than the configured lead time away is not yet due", () => {
  const appointment = { start_at: hoursFromNow(10), updated_at: hoursFromNow(-100) };

  assert.equal(isReminderDue(appointment, { reminder_lead_time_hours: 6 }, NOW), false);
});

test("Config 9d: an appointment already in the past is never due, regardless of configured lead time", () => {
  const appointment = { start_at: hoursFromNow(-1), updated_at: hoursFromNow(-100) };

  assert.equal(isReminderDue(appointment, { reminder_lead_time_hours: 168 }, NOW), false);
});

test("Config 9e: the staleness guard still uses the configured lead time - an appointment rescheduled more recently than its own start_at minus the configured lead time is not due yet, even though it's within the window", () => {
  // Starts in 2 hours, with a 6-hour configured lead time: start_at -
  // leadTime is 4 hours in the past, but this appointment was only updated
  // (created/rescheduled) 1 hour ago - i.e. after that threshold, so it
  // hasn't been stable at this start_at for the full configured lead time.
  const appointment = { start_at: hoursFromNow(2), updated_at: hoursFromNow(-1) };

  assert.equal(isReminderDue(appointment, { reminder_lead_time_hours: 6 }, NOW), false);
});
