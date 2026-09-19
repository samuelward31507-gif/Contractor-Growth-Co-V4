/**
 * Pure, dependency-free tests of the catalog helpers Phase C's enforcement
 * relies on. Run with:
 *
 *   node --test lib/automation/catalog.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getAutomationDefinition, getAutomationForEventType }: typeof import("./catalog") = require("./catalog.ts");

test("F: an unknown automation id resolves to null (rejected by setAutomationEnabled)", () => {
  assert.equal(getAutomationDefinition("not-a-real-automation"), null);
});

test("G: Safe AI Outbound is a safety-layer automation, never event-triggered/scheduled", () => {
  const safeAiOutbound = getAutomationDefinition("safe-ai-outbound");

  assert.ok(safeAiOutbound, "safe-ai-outbound must exist in the catalog");
  assert.equal(safeAiOutbound?.kind, "safety-layer");
  // No event type can ever resolve to it - it has no dispatched workflow of
  // its own for setAutomationEnabled's caller (events.ts) to ever check
  // enablement against.
  assert.equal(safeAiOutbound?.eventTypes.length, 0);
});

test("getAutomationForEventType maps a real event type to its catalog automation", () => {
  const automation = getAutomationForEventType("lead.created");

  assert.equal(automation?.id, "instant-lead-followup");
});

test("getAutomationForEventType returns null for an uncatalogued internal event (lead.lost)", () => {
  assert.equal(getAutomationForEventType("lead.lost"), null);
});

test("getAutomationForEventType never maps anything to safe-ai-outbound", () => {
  const definitions = ["lead.created", "customer.message.received", "appointment.created", "estimate.sent", "job.created"];
  for (const eventType of definitions) {
    assert.notEqual(getAutomationForEventType(eventType)?.id, "safe-ai-outbound");
  }
});
