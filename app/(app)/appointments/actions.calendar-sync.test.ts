/**
 * Structural tests for the Phase 1 Scheduling Foundation, Stage 5
 * additions to app/(app)/appointments/actions.ts - Google Calendar sync
 * wiring and the appointments_no_overlap (23P01) race-condition handling.
 * createAppointment/updateAppointment/deleteAppointment all call
 * createClient() (lib/supabase/server.ts), which depends on next/headers's
 * cookies() - unavailable outside a real request scope, the same
 * limitation this codebase's other Server Action tests already document
 * (e.g. app/agency/organizations/actions.test.ts). Verified against the
 * real source.
 *
 * The sync ORCHESTRATION logic itself (lib/calendar/appointment-sync.ts)
 * is exhaustively covered live in appointment-sync.integration.test.ts -
 * this file only proves actions.ts wires it in at the right points, in the
 * right order, with the right failure handling.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/appointments/actions.calendar-sync.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, "app/(app)/appointments/actions.ts"), "utf8");

test("1. createAppointment: Google sync is only ever attempted AFTER the Trackpr insert has already succeeded - never before, never conditionally on it", () => {
  const insertIndex = SOURCE.indexOf('.from("appointments")\n    .insert({ ...input, organization_id: organizationId })');
  const syncCallIndex = SOURCE.indexOf("syncAppointmentCreatedToGoogle(supabase, organizationId, created.id)");
  assert.ok(insertIndex !== -1 && syncCallIndex !== -1);
  assert.ok(insertIndex < syncCallIndex, "the Trackpr insert must appear before the Google sync call in source order");
});

test("2. createAppointment: a 23P01 (exclusion constraint violation) on insert returns the exact same conflict message as the application-level pre-check, and Google sync is never reached for a failed insert", () => {
  const conflictCheckIndex = SOURCE.indexOf('if (insertError.code === "23P01")');
  assert.ok(conflictCheckIndex !== -1, "expected explicit 23P01 handling on the insert error path");
  const returnLine = SOURCE.slice(conflictCheckIndex, conflictCheckIndex + 150);
  assert.match(returnLine, /return \{ error: APPOINTMENT_CONFLICT_ERROR \};/);

  // The insert-error branch returns early (inside the `if (insertError)` block), so a 23P01 can never fall through to the sync call below it.
  const insertErrorBlockStart = SOURCE.indexOf("if (insertError) {");
  const insertErrorBlockEnd = SOURCE.indexOf("\n  }", insertErrorBlockStart);
  const syncCallIndex = SOURCE.indexOf("syncAppointmentCreatedToGoogle(supabase, organizationId, created.id)");
  assert.ok(insertErrorBlockEnd < syncCallIndex, "the insert-error block (including its 23P01 branch) must return before the sync call is ever reached");
});

test("3. createAppointment: a Google sync warning is passed through in the success return - the appointment is still reported as a success, never as a failure", () => {
  assert.match(SOURCE, /return \{ success: true, warning \};/);
});

test("4. updateAppointment: a newly-cancelled appointment with a previously-synced event has its Google event DELETED (not merely updated) - per this stage's own domain semantics", () => {
  assert.match(SOURCE, /const newlyCancelled = previous\.status !== "cancelled" && nextStatus === "cancelled";/);
  const cancelBranchIndex = SOURCE.indexOf("if (newlyCancelled && previous.external_event_id && previous.external_calendar_id)");
  assert.ok(cancelBranchIndex !== -1);
  const branchBody = SOURCE.slice(cancelBranchIndex, cancelBranchIndex + 400);
  assert.match(branchBody, /syncAppointmentRemovedFromGoogle\(/);
});

test("5. updateAppointment: after a successful cancel-triggered Google deletion, external_event_id/external_calendar_id are cleared on the Trackpr row - never left pointing at a deleted event", () => {
  assert.match(SOURCE, /\.update\(\{ external_event_id: null, external_calendar_id: null \}\)/);
});

test("6. updateAppointment: if the cancel-triggered Google deletion itself FAILS, the external ids are deliberately left populated (not cleared) - so a future retry/reconciliation still has the ids needed to try again, rather than losing track of the orphaned event", () => {
  const clearIdsIndex = SOURCE.indexOf('.update({ external_event_id: null, external_calendar_id: null })');
  const guardIndex = SOURCE.lastIndexOf("if (!result.warning)", clearIdsIndex);
  assert.ok(guardIndex !== -1 && guardIndex < clearIdsIndex, "clearing the external ids must be conditioned on the deletion having actually succeeded");
});

test("7. updateAppointment: a non-cancelling save to an already-synced appointment updates the Google event (never re-creates, never deletes)", () => {
  const updateBranchIndex = SOURCE.indexOf("if (!newlyCancelled && previous.external_event_id)");
  assert.ok(updateBranchIndex !== -1);
  const branchBody = SOURCE.slice(updateBranchIndex, updateBranchIndex + 200);
  assert.match(branchBody, /syncAppointmentUpdatedToGoogle\(/);
});

test("8. updateAppointment: a 23P01 on the UPDATE itself (a concurrent reschedule race) returns the same conflict message as insert's own handling", () => {
  // Pass 2 (Native Calendar System): this handling now lives inside the
  // shared applyAppointmentUpdate helper (reused by updateAppointment AND
  // the calendar's own quick-action Server Actions - see
  // actions.calendar-quick-actions.test.ts #3/#4) rather than inline in
  // updateAppointment itself - same behavior, factored so the calendar
  // never duplicates this error handling.
  const helperMatch = SOURCE.match(/async function applyAppointmentUpdate\([\s\S]*?\n\}/);
  assert.ok(helperMatch, "expected to find applyAppointmentUpdate");
  const updateErrorBlock = helperMatch![0].slice(helperMatch![0].indexOf("if (updateError) {"), helperMatch![0].indexOf("if (!data) {"));
  assert.match(updateErrorBlock, /if \(updateError\.code === "23P01"\)/);
  assert.match(updateErrorBlock, /error: APPOINTMENT_CONFLICT_ERROR/);

  // updateAppointment itself must still propagate that same error string to
  // its own caller (the AppointmentDialog form) unchanged.
  const updateAppointmentMatch = SOURCE.match(/export async function updateAppointment\([\s\S]*?\n\}/);
  assert.ok(updateAppointmentMatch, "expected to find updateAppointment");
  assert.match(updateAppointmentMatch![0], /if \(!result\.ok\) \{\s*return \{ error: result\.error \};/);
});

test("9. deleteAppointment: external_event_id/external_calendar_id are captured via the DELETE's own RETURNING clause - the only chance to read them, since the row is gone immediately after", () => {
  assert.match(SOURCE, /\.select\("id, external_event_id, external_calendar_id"\)/);
});

test("10. deleteAppointment: Google sync is only attempted when both external ids are actually present - never called with a null/undefined id", () => {
  assert.match(SOURCE, /if \(data\.external_event_id && data\.external_calendar_id\) \{/);
});

test("11. deleteAppointment: the Trackpr DELETE happens unconditionally before any Google sync attempt - Google is never deleted first", () => {
  const deleteIndex = SOURCE.indexOf('.from("appointments")\n    .delete()');
  const syncIndex = SOURCE.indexOf("syncAppointmentRemovedFromGoogle(supabase, organizationId, data.external_event_id, data.external_calendar_id)");
  assert.ok(deleteIndex !== -1 && syncIndex !== -1 && deleteIndex < syncIndex);
});

test("12. no OAuth tokens, credentials, or raw provider errors are ever referenced in this file - only the typed sync-function calls and their returned `warning` string", () => {
  assert.doesNotMatch(SOURCE, /access_?[Tt]oken|refresh_?[Tt]oken|client_?[Ss]ecret/);
});

test("13. the appointment-sync module is imported from its real, expected path - not duplicated or reimplemented inline in this file", () => {
  assert.match(SOURCE, /import \{ syncAppointmentCreatedToGoogle, syncAppointmentUpdatedToGoogle, syncAppointmentRemovedFromGoogle \} from "@\/lib\/calendar\/appointment-sync";/);
});
