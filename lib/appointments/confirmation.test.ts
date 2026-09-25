/**
 * Pass 5B, Part A5: pure unit tests for
 * computeConfirmationInvalidationOnTimeChange - no Supabase round trip
 * needed. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/appointments/confirmation.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeConfirmationInvalidationOnTimeChange }: typeof import("./confirmation") = require("./confirmation.ts");

test("no time change: no fields touched at all, regardless of status", () => {
  assert.deepEqual(computeConfirmationInvalidationOnTimeChange("confirmed", false), {});
  assert.deepEqual(computeConfirmationInvalidationOnTimeChange("scheduled", false), {});
});

test("time change on a 'confirmed' appointment: clears confirmation AND reverts status to 'scheduled' - the exact example from Part A5 (confirmed Tuesday 2pm -> rescheduled Thursday 4pm -> requires confirmation again)", () => {
  assert.deepEqual(computeConfirmationInvalidationOnTimeChange("confirmed", true), {
    confirmed_at: null,
    confirmation_requested_at: null,
    status: "scheduled",
  });
});

test("time change on a 'scheduled' appointment: clears confirmation fields, but there is no status to revert (already 'scheduled')", () => {
  assert.deepEqual(computeConfirmationInvalidationOnTimeChange("scheduled", true), {
    confirmed_at: null,
    confirmation_requested_at: null,
  });
});

test("time change on a cancelled/completed/no_show appointment never forces a status override back to 'scheduled' - only a genuinely-confirmed appointment's status is ever touched", () => {
  for (const status of ["cancelled", "completed", "no_show"] as const) {
    const result = computeConfirmationInvalidationOnTimeChange(status, true);
    assert.equal((result as { status?: string }).status, undefined);
  }
});
