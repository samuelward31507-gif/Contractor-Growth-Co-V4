/**
 * P0 A0: appointment reminders ask the customer to "Reply CONFIRM", never
 * "Reply YES" - a bare "YES" is a carrier START keyword
 * (lib/messaging/keywords.ts) and is intercepted by the compliance layer
 * before it can reach the confirmation path. CONFIRM is not a compliance
 * keyword, so it reaches the normal inbound flow (covered end to end in
 * lib/automation/booking-offer-close.test.ts).
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/reminder-confirm-wording.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

const { composeReminderBody } = await import(lib("lib/automation/appointment-reminders.ts"));
const { matchSmsKeyword } = await import(lib("lib/messaging/keywords.ts"));
const { evaluateContentSafety } = await import(lib("lib/automation/content-safety.ts"));

const appointment = (status: string) =>
  ({ id: "appt-1", title: "Roof inspection", status, start_at: "2026-10-13T15:00:00.000Z", end_at: "2026-10-13T16:00:00.000Z" }) as never;

test("an unconfirmed appointment's reminder asks the customer to reply CONFIRM", () => {
  const body: string = composeReminderBody(appointment("scheduled"), "America/Denver");
  assert.match(body, /Reply CONFIRM to confirm, or let us know if you need to reschedule\./);
  assert.match(body, /Reply STOP to opt out of texts\./);
  assert.deepEqual(evaluateContentSafety(body), { safe: true });
});

test("no reminder copy asks for YES (unconfirmed or confirmed)", () => {
  for (const status of ["scheduled", "confirmed"]) {
    const body: string = composeReminderBody(appointment(status), "America/Denver");
    assert.doesNotMatch(body, /\bYES\b/i, status);
  }
  // Source-level guard: no reminder composer anywhere in the module asks for YES.
  const source = readFileSync(path.join(process.cwd(), "lib/automation/appointment-reminders.ts"), "utf8");
  assert.doesNotMatch(source, /Reply YES/);
});

test("an already-confirmed appointment's reminder asks for nothing", () => {
  const body: string = composeReminderBody(appointment("confirmed"), "America/Denver");
  assert.doesNotMatch(body, /CONFIRM/);
});

test("Final Batch 1: a bare YES is an ordinary reply (not START); START/UNSTOP still are; CONFIRM is not a compliance keyword", () => {
  assert.equal(matchSmsKeyword("YES"), null);
  assert.equal(matchSmsKeyword("yes"), null);
  assert.equal(matchSmsKeyword("START"), "start");
  assert.equal(matchSmsKeyword("unstop"), "start");
  assert.equal(matchSmsKeyword("CONFIRM"), null);
  assert.equal(matchSmsKeyword("confirm"), null);
});
