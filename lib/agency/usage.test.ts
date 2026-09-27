/**
 * Pure unit tests for lib/agency/usage.ts's non-I/O aggregation logic
 * (summarizeAgencyUsage) - kept separate from usage.integration.test.ts
 * (real DB, authorization, real field mapping) and
 * usage.partial-data.test.ts (mocked single-table client for
 * loadMissedCallCounts), matching this codebase's own established split
 * (see lib/agency/expansion.test.ts for the identical pattern).
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/usage.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { summarizeAgencyUsage }: typeof import("./usage") = require("./usage.ts");

function client(overrides: Partial<Parameters<typeof summarizeAgencyUsage>[0][number]> = {}) {
  return {
    organizationId: "org-1",
    organizationName: "Org One",
    period: { from: null, to: null, label: "last 30 days" },
    messaging: { inbound: 0, outbound: 0, total: 0, byStatus: { queued: 0, sent: 0, delivered: 0, failed: 0, undelivered: 0, received: 0, logged: 0 } },
    ai: { interactions: 0, interactionsWithUsageData: 0, tokens: null, byType: {}, byModel: {}, needsHumanCount: 0 },
    automation: { executions: 0, successful: 0, failed: 0, running: 0, successRate: null },
    voice: { missedCalls: 0 },
    operational: { leads: 0, appointments: 0, estimates: 0, jobs: 0, reviewsRequested: 0, referralsRequested: 0 },
    dataQuality: { partialData: false, notes: [] },
    ...overrides,
  };
}

test("1. an empty client list summarizes to all-zero counts and a real (non-null) totalMissedCalls of 0, never throwing", () => {
  const totals = summarizeAgencyUsage([], false);
  assert.deepEqual(totals, {
    organizationCount: 0,
    totalMessages: 0,
    totalAiInteractions: 0,
    totalAutomationExecutions: 0,
    totalMissedCalls: 0,
  });
});

test("2. messages/AI/automation totals sum correctly across multiple clients", () => {
  const totals = summarizeAgencyUsage(
    [
      client({ organizationId: "org-1", messaging: { inbound: 3, outbound: 2, total: 5, byStatus: client().messaging.byStatus }, ai: { ...client().ai, interactions: 4 }, automation: { ...client().automation, executions: 6 } }),
      client({ organizationId: "org-2", messaging: { inbound: 1, outbound: 1, total: 2, byStatus: client().messaging.byStatus }, ai: { ...client().ai, interactions: 1 }, automation: { ...client().automation, executions: 2 } }),
    ],
    false,
  );

  assert.equal(totals.organizationCount, 2);
  assert.equal(totals.totalMessages, 7);
  assert.equal(totals.totalAiInteractions, 5);
  assert.equal(totals.totalAutomationExecutions, 8);
});

test("3. totalMissedCalls sums real per-client counts when the missed-call query succeeded", () => {
  const totals = summarizeAgencyUsage(
    [client({ organizationId: "org-1", voice: { missedCalls: 3 } }), client({ organizationId: "org-2", voice: { missedCalls: 4 } })],
    false,
  );
  assert.equal(totals.totalMissedCalls, 7);
});

test("4. totalMissedCalls is null (never 0, never summed) when the missed-call query failed - regardless of what individual clients happen to carry", () => {
  const totals = summarizeAgencyUsage(
    [client({ organizationId: "org-1", voice: { missedCalls: null } }), client({ organizationId: "org-2", voice: { missedCalls: null } })],
    true,
  );
  assert.equal(totals.totalMissedCalls, null, "a failed batched query must produce an honestly unknown total, never a fabricated 0 or a partial sum");
});

test("5. a client with a genuinely null AI token total does not corrupt totals for other clients - null tokens are a per-client display concern, not part of this aggregate", () => {
  const totals = summarizeAgencyUsage(
    [client({ organizationId: "org-1", ai: { ...client().ai, interactions: 2, tokens: null } }), client({ organizationId: "org-2", ai: { ...client().ai, interactions: 3, tokens: 500 } })],
    false,
  );
  assert.equal(totals.totalAiInteractions, 5, "interaction counts must still sum correctly even when one client's own token total is unavailable");
});
