/**
 * Unit tests for the Phase D trigger_source threading added to
 * startWorkflowExecution/startWorkflowExecutionAsService - against a mocked
 * Supabase client, no real database, no production fixtures. Run with:
 *
 *   node --test lib/automation/executions.test.ts
 *
 * executions.ts has no "@/"-aliased imports (only @supabase/supabase-js
 * types), so unlike events.ts it can be loaded directly under plain
 * node --test - see lib/automation/authorization.test.ts for why this repo
 * uses node:test directly and the require()-with-explicit-.ts-path pattern.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { startWorkflowExecution, startWorkflowExecutionAsService }: typeof import("./executions") = require("./executions.ts");

const EVENT_ID = "11111111-1111-1111-1111-111111111111";
const WORKFLOW = "appointment_reminder";

function fakeExecutionRow(args: Record<string, unknown>) {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    organization_id: "org-1",
    automation_event_id: args.p_automation_event_id,
    workflow_name: args.p_workflow_name,
    status: "running",
    attempt: 1,
    started_at: new Date().toISOString(),
    completed_at: null,
    error_message: null,
    metadata: args.p_metadata ?? {},
    trigger_source: args.p_trigger_source ?? "event",
  };
}

/** Covers both the session variant (auth.getUser + retry-ceiling lookup) and the service-role variant (neither). */
function createMockSupabase() {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: "admin-user" } } }),
    },
    from(table: string) {
      if (table !== "workflow_executions") throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: null }), // no prior attempts
              }),
            }),
          }),
        }),
      };
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { single: async () => ({ data: fakeExecutionRow(args), error: null }) };
    },
  } as unknown as SupabaseClient;

  return { client, rpcCalls };
}

test("startWorkflowExecutionAsService defaults trigger_source to 'event' when omitted (existing cron/webhook behavior unchanged)", async () => {
  const { client, rpcCalls } = createMockSupabase();

  const result = await startWorkflowExecutionAsService(client, EVENT_ID, WORKFLOW);

  assert.equal(result.ok, true);
  assert.equal(rpcCalls[0]?.args.p_trigger_source, "event");
  assert.equal(result.ok && result.execution.trigger_source, "event");
});

test("startWorkflowExecutionAsService passes trigger_source = 'manual' when a manual run requests it", async () => {
  const { client, rpcCalls } = createMockSupabase();

  const result = await startWorkflowExecutionAsService(client, EVENT_ID, WORKFLOW, {}, "manual");

  assert.equal(result.ok, true);
  assert.equal(rpcCalls[0]?.args.p_trigger_source, "manual");
  assert.equal(result.ok && result.execution.trigger_source, "manual");
});

test("startWorkflowExecution (session variant) defaults trigger_source to 'event' when omitted", async () => {
  const { client, rpcCalls } = createMockSupabase();

  const result = await startWorkflowExecution(client, EVENT_ID, WORKFLOW);

  assert.equal(result.ok, true);
  assert.equal(rpcCalls[0]?.args.p_trigger_source, "event");
});

test("startWorkflowExecution (session variant) passes trigger_source = 'manual' when specified", async () => {
  const { client, rpcCalls } = createMockSupabase();

  const result = await startWorkflowExecution(client, EVENT_ID, WORKFLOW, {}, "manual");

  assert.equal(result.ok, true);
  assert.equal(rpcCalls[0]?.args.p_trigger_source, "manual");
});
