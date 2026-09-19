/**
 * End-to-end orchestration tests for retryWorkflowExecution() against a
 * mocked Supabase client - no real database, no production fixtures, no
 * real network call (N8N_BASE_URL/N8N_WEBHOOK_SECRET are unset in this test
 * process, so triggerN8nWorkflow's own "unconfigured" short-circuit fires
 * before any fetch() is attempted - see lib/automation/n8n.ts).
 *
 * Unlike retry-eligibility.test.ts, this file transitively imports several
 * "@/"-aliased modules (via appointment-reminders.ts/estimate-followups.ts/
 * n8n-retry.ts), which plain `node --test` cannot resolve on its own - see
 * lib/automation/test-loader.mjs, a small resolution bridge (no production
 * code, tsconfig, or package.json changes) that makes this runnable. Run
 * with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/retry.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { retryWorkflowExecution, planRetryAudit }: typeof import("./retry") = require("./retry.ts");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const EXECUTION_ID = "22222222-2222-2222-2222-222222222222";
const EVENT_ID = "33333333-3333-3333-3333-333333333333";
const NEW_EXECUTION_ID = "55555555-5555-5555-5555-555555555555";

const ORIGINAL_EXECUTION = {
  id: EXECUTION_ID,
  organization_id: ORG_ID,
  automation_event_id: EVENT_ID,
  workflow_name: "lead_created_followup",
  status: "failed",
  attempt: 1,
};

const EVENT = {
  id: EVENT_ID,
  organization_id: ORG_ID,
  event_type: "lead.created",
  entity_type: "lead",
  entity_id: "66666666-6666-6666-6666-666666666666",
  payload: {},
  status: "failed",
};

/** A chainable stub supporting any sequence of .eq()/.order()/.limit() calls, resolving via .maybeSingle(). */
function chainable(data: unknown) {
  const node = {
    eq: () => node,
    order: () => node,
    limit: () => node,
    maybeSingle: async () => ({ data }),
  };
  return node;
}

function createMockSupabase() {
  const calls: { kind: string; table?: string; fn?: string; args?: Record<string, unknown> }[] = [];

  const client = {
    from(table: string) {
      calls.push({ kind: "from", table });

      if (table === "workflow_executions") {
        return {
          // Serves both checkRetryEligibility's lookup (returns the
          // original failed execution) and startWorkflowExecution's own
          // internal getLatestAttempt retry-ceiling query (attempt: 1 is
          // safely below MAX_WORKFLOW_RETRY_ATTEMPTS).
          select: (columns: string) => chainable(columns === "attempt" ? { attempt: 1 } : ORIGINAL_EXECUTION),
          update: () => {
            throw new Error("the original execution row must never be updated by a retry");
          },
        };
      }
      if (table === "automation_events") {
        return {
          select: () => chainable(EVENT),
          insert: () => {
            throw new Error("retry must never create a new automation_events row - it must reuse the existing parent event");
          },
        };
      }
      if (table === "automation_settings") {
        return { select: () => chainable({ enabled: true }) };
      }
      if (table === "organizations" || table === "ai_settings") {
        return { select: () => chainable(null) };
      }
      throw new Error(`unexpected table in this test: ${table}`);
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ kind: "rpc", fn, args });
      if (fn === "start_workflow_execution") {
        return {
          single: async () => ({
            data: {
              id: NEW_EXECUTION_ID,
              organization_id: ORG_ID,
              automation_event_id: args.p_automation_event_id,
              workflow_name: args.p_workflow_name,
              status: "running",
              attempt: 2,
              started_at: new Date().toISOString(),
              completed_at: null,
              error_message: null,
              metadata: args.p_metadata ?? {},
              trigger_source: args.p_trigger_source,
            },
            error: null,
          }),
        };
      }
      if (fn === "fail_workflow_execution") {
        // Expected: triggerN8nWorkflow short-circuits to "unconfigured"
        // (N8N_BASE_URL/N8N_WEBHOOK_SECRET are unset here), and
        // redispatchToN8n correctly marks the new execution failed rather
        // than leaving it stuck "running" forever.
        return {
          single: async () => ({
            data: { id: args.p_execution_id, status: "failed", error_message: args.p_error_message },
            error: null,
          }),
        };
      }
      throw new Error(`unexpected rpc in this test: ${fn}`);
    },
    auth: {
      getUser: async () => ({ data: { user: { id: "admin-user" } } }),
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

test("retrying a failed execution creates a new execution with trigger_source='retry', never mutates the original row", async () => {
  const { client, calls } = createMockSupabase();

  const result = await retryWorkflowExecution(client, ORG_ID, EXECUTION_ID);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.newExecutionId, NEW_EXECUTION_ID);
  assert.equal(result.ok && result.executionId, EXECUTION_ID);

  const startCall = calls.find((c) => c.kind === "rpc" && c.fn === "start_workflow_execution");
  assert.ok(startCall, "start_workflow_execution must have been called");
  assert.equal(startCall?.args?.p_trigger_source, "retry");
  assert.equal(startCall?.args?.p_automation_event_id, EVENT_ID);

  // The mock's workflow_executions.update() and automation_events.insert()
  // both throw if ever called - reaching this line at all (this test would
  // have thrown/failed otherwise) already proves neither happened.
});

test("the new execution is created before any redispatch is attempted (start_workflow_execution is the first rpc call)", async () => {
  const { client, calls } = createMockSupabase();

  await retryWorkflowExecution(client, ORG_ID, EXECUTION_ID);

  const rpcCalls = calls.filter((c) => c.kind === "rpc");
  assert.equal(rpcCalls[0]?.fn, "start_workflow_execution", "the execution row must exist before anything else happens");
});

test("redispatch to an unconfigured n8n orchestrator never attempts a real network call, and is correctly reported as dispatched:false (not succeeded)", async () => {
  const { client } = createMockSupabase();

  // N8N_BASE_URL/N8N_WEBHOOK_SECRET are unset in this test process, so
  // triggerN8nWorkflow's own unconfigured short-circuit fires - this proves
  // no outbound provider call ever reaches an external endpoint during this
  // test. Verified by env absence rather than a call-count assertion, since
  // triggerN8nWorkflow is a plain fetch() call, not a mockable dependency
  // here.
  assert.equal(process.env.N8N_BASE_URL, undefined, "test assumes n8n is not configured in this environment");

  const result = await retryWorkflowExecution(client, ORG_ID, EXECUTION_ID);

  // The execution row was still created successfully (ok: true)...
  assert.equal(result.ok, true, "the retry execution row itself is still created successfully");
  // ...but the handoff failed, and this must be visible as dispatched:false
  // so the caller never audits/reports this as automation_retry_succeeded -
  // see the Phase E review report's audit-semantics fix.
  assert.equal(result.ok && result.dispatched, false);
  assert.ok(result.ok && !result.dispatched && result.dispatchError, "a dispatch error message must be present");
});

// Phase H: planRetryAudit is the pure decision behind retryExecution's
// audit calls (app/(app)/automations/actions.ts) - extracted specifically
// so this branching can be unit tested directly, since that file is
// "use server" and cannot export a plain synchronous function.

test("Phase H: an eligibility rejection with a resolved automationId plans 'rejected' only", () => {
  const plan = planRetryAudit({ ok: false, reason: "automation_disabled", executionId: EXECUTION_ID, automationId: "instant-lead-followup" });

  assert.deepEqual(plan, { kind: "rejected", automationId: "instant-lead-followup", reason: "automation_disabled" });
});

test("Phase H: an eligibility rejection with no resolvable automationId plans 'unattributable' (no audit call at all)", () => {
  const plan = planRetryAudit({ ok: false, reason: "execution_not_found", executionId: EXECUTION_ID, automationId: null });

  assert.deepEqual(plan, { kind: "unattributable" });
});

test("Phase H: a successful execution creation with a failed handoff plans 'requested_only' - never 'succeeded'", () => {
  const plan = planRetryAudit({
    ok: true,
    dispatched: false,
    executionId: EXECUTION_ID,
    newExecutionId: NEW_EXECUTION_ID,
    automationId: "instant-lead-followup",
    dispatchError: "The automation orchestrator rejected the request.",
  });

  assert.deepEqual(plan, { kind: "requested_only", automationId: "instant-lead-followup" });
});

test("Phase H: a successful execution creation with a successful handoff plans 'requested_and_succeeded'", () => {
  const plan = planRetryAudit({
    ok: true,
    dispatched: true,
    executionId: EXECUTION_ID,
    newExecutionId: NEW_EXECUTION_ID,
    automationId: "appointment-reminders",
  });

  assert.deepEqual(plan, { kind: "requested_and_succeeded", automationId: "appointment-reminders" });
});

test("Phase H: a successful execution creation with no resolvable automationId plans 'unattributable'", () => {
  const plan = planRetryAudit({ ok: true, dispatched: true, executionId: EXECUTION_ID, newExecutionId: NEW_EXECUTION_ID, automationId: null });

  assert.deepEqual(plan, { kind: "unattributable" });
});
