/**
 * Unit tests for checkRetryEligibility() against a mocked Supabase client -
 * no real database, no production fixtures. Run with:
 *
 *   node --test lib/automation/retry-eligibility.test.ts
 *
 * retry-eligibility.ts has no "@/"-aliased imports (only relative imports to
 * catalog.ts/settings.ts/executions.ts, none of which have such imports
 * either), so it can be loaded directly under plain node --test - see
 * lib/automation/authorization.test.ts for the require()-with-explicit-
 * .ts-path pattern this repo uses for that reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { checkRetryEligibility }: typeof import("./retry-eligibility") = require("./retry-eligibility.ts");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const EXECUTION_ID = "22222222-2222-2222-2222-222222222222";
const EVENT_ID = "33333333-3333-3333-3333-333333333333";

type MockConfig = {
  execution?: Record<string, unknown> | null;
  event?: Record<string, unknown> | null;
  automationEnabled?: boolean;
};

function createMockSupabase({ execution, event, automationEnabled = true }: MockConfig) {
  const client = {
    from(table: string) {
      if (table === "workflow_executions") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: execution ?? null }) }) }) }) };
      }
      if (table === "automation_events") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: event ?? null }) }) }) }) };
      }
      if (table === "automation_settings") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: automationEnabled } }) }) }) }) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;

  return client;
}

const BASE_EXECUTION = {
  id: EXECUTION_ID,
  organization_id: ORG_ID,
  automation_event_id: EVENT_ID,
  workflow_name: "lead_created_followup",
  status: "failed",
  attempt: 1,
};

const BASE_EVENT = {
  id: EVENT_ID,
  organization_id: ORG_ID,
  event_type: "lead.created",
  entity_type: "lead",
  entity_id: "44444444-4444-4444-4444-444444444444",
  payload: { lead_id: "44444444-4444-4444-4444-444444444444" },
  status: "failed",
};

test("A failed execution with a valid, idle parent event and an enabled automation is eligible", async () => {
  const client = createMockSupabase({ execution: BASE_EXECUTION, event: BASE_EVENT, automationEnabled: true });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, true);
  assert.ok(result.ok && result.automationId === "instant-lead-followup");
});

test("execution not found is rejected", async () => {
  const client = createMockSupabase({ execution: null });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "execution_not_found");
});

test("a completed execution is rejected (not retryable)", async () => {
  const client = createMockSupabase({ execution: { ...BASE_EXECUTION, status: "completed" } });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "not_failed");
});

test("a running execution is rejected (not retryable)", async () => {
  const client = createMockSupabase({ execution: { ...BASE_EXECUTION, status: "running" } });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "not_failed");
});

test("a cancelled execution is rejected (not retryable)", async () => {
  const client = createMockSupabase({ execution: { ...BASE_EXECUTION, status: "cancelled" } });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "not_failed");
});

test("retry ceiling reached is rejected", async () => {
  const client = createMockSupabase({ execution: { ...BASE_EXECUTION, attempt: 5 } });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "retry_ceiling_reached");
});

test("a missing automation_event_id on the execution is rejected", async () => {
  const client = createMockSupabase({ execution: { ...BASE_EXECUTION, automation_event_id: null } });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "missing_parent_event");
});

test("a deleted/missing parent event row is rejected", async () => {
  const client = createMockSupabase({ execution: BASE_EXECUTION, event: null });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "missing_parent_event");
});

test("a parent event already 'processing' is rejected", async () => {
  const client = createMockSupabase({ execution: BASE_EXECUTION, event: { ...BASE_EVENT, status: "processing" } });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "event_not_retryable");
  assert.equal(!result.ok && result.automationId, "instant-lead-followup", "automationId should still be resolved so the rejection can be audited");
});

test("a parent event already 'completed' is rejected", async () => {
  const client = createMockSupabase({ execution: BASE_EXECUTION, event: { ...BASE_EVENT, status: "completed" } });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "event_not_retryable");
});

test("a disabled automation is rejected", async () => {
  const client = createMockSupabase({ execution: BASE_EXECUTION, event: BASE_EVENT, automationEnabled: false });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "automation_disabled");
  assert.equal(!result.ok && result.automationId, "instant-lead-followup");
});

test("an uncatalogued event type (no automation mapping) is rejected - nothing to verify a safe contract against", async () => {
  const client = createMockSupabase({
    execution: { ...BASE_EXECUTION, workflow_name: "lead_lost_lifecycle" },
    event: { ...BASE_EVENT, event_type: "lead.lost" },
  });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "not_safely_retryable");
  assert.equal(!result.ok && result.automationId, null);
});

test("an n8n-dispatched automation other than instant-lead-followup is rejected as not safely retryable (Phase E n8n safety audit)", async () => {
  const client = createMockSupabase({
    execution: { ...BASE_EXECUTION, workflow_name: "appointment_created_followup" },
    event: { ...BASE_EVENT, event_type: "appointment.created", entity_type: "appointment", payload: { appointment_id: "77777777-7777-7777-7777-777777777777" } },
  });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "not_safely_retryable");
  assert.equal(!result.ok && result.automationId, "appointment-lifecycle", "automationId should still resolve so the rejection can be audited");
});

test("instant-lead-followup (the one verified-safe n8n automation) remains eligible", async () => {
  const client = createMockSupabase({ execution: BASE_EXECUTION, event: BASE_EVENT, automationEnabled: true });

  const result = await checkRetryEligibility(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.automationId, "instant-lead-followup");
});

test("the two Trackpr-dispatched automations (appointment-reminders, estimate-followup) remain eligible", async () => {
  const reminderClient = createMockSupabase({
    execution: { ...BASE_EXECUTION, workflow_name: "appointment_reminder" },
    event: { ...BASE_EVENT, event_type: "appointment.reminder" },
  });
  const reminderResult = await checkRetryEligibility(reminderClient, ORG_ID, EXECUTION_ID);
  assert.equal(reminderResult.ok, true);
  assert.equal(reminderResult.ok && reminderResult.automationId, "appointment-reminders");

  const followupClient = createMockSupabase({
    execution: { ...BASE_EXECUTION, workflow_name: "estimate_followup" },
    event: { ...BASE_EVENT, event_type: "estimate.followup" },
  });
  const followupResult = await checkRetryEligibility(followupClient, ORG_ID, EXECUTION_ID);
  assert.equal(followupResult.ok, true);
  assert.equal(followupResult.ok && followupResult.automationId, "estimate-followup");
});
