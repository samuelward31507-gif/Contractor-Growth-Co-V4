/**
 * Unit tests for buildIncidentFingerprint()/automationFingerprintContext() -
 * pure functions, no I/O. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/fingerprint.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildIncidentFingerprint, automationFingerprintContext }: typeof import("./fingerprint") = require("./fingerprint.ts");

test("the same category and context always produce the same fingerprint", () => {
  const a = buildIncidentFingerprint("workflow_failed", "instant-lead-followup");
  const b = buildIncidentFingerprint("workflow_failed", "instant-lead-followup");
  assert.equal(a, b);
});

test("different categories with the same context produce different fingerprints", () => {
  const a = buildIncidentFingerprint("workflow_failed", "instant-lead-followup");
  const b = buildIncidentFingerprint("n8n_dispatch_failed", "instant-lead-followup");
  assert.notEqual(a, b);
});

test("different contexts with the same category produce different fingerprints", () => {
  const a = buildIncidentFingerprint("workflow_stuck", "execution-1");
  const b = buildIncidentFingerprint("workflow_stuck", "execution-2");
  assert.notEqual(a, b);
});

test("throws on an empty or whitespace-only context rather than silently building a malformed key", () => {
  assert.throws(() => buildIncidentFingerprint("workflow_failed", ""));
  assert.throws(() => buildIncidentFingerprint("workflow_failed", "   "));
});

test("automationFingerprintContext prefers the catalog automation id when known", () => {
  assert.equal(automationFingerprintContext("instant-lead-followup", "lead_created_followup"), "instant-lead-followup");
});

test("automationFingerprintContext falls back to a workflow-name-derived context when no catalog automation is known", () => {
  assert.equal(automationFingerprintContext(null, "some_unknown_workflow"), "workflow:some_unknown_workflow");
});
