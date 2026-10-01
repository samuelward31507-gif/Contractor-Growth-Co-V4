/**
 * Pass 6T fix: behavioral regression coverage for dispatchAppointmentWorkflow's
 * n8n-dispatch failure branch in appointments.ts.
 *
 * The scheduled no-show scan (no-show-detection.ts) calls
 * emitAppointmentNoShowAsService with a service-role client that has no
 * Supabase Auth session. Before this fix the failure branch always called the
 * user-session failWorkflowExecution, which returned "Not authenticated."
 * without recording anything, leaving the execution stuck in `running`.
 *
 * Unlike customer-reply-dispatch-failure.test.ts (source inspection, because
 * `after` throws outside a Next.js request), this test mocks next/server's
 * `after` so the real callback runs, and mocks every module appointments.ts
 * imports so nothing touches the network or a database. Requires Node's
 * module mocks. Run with:
 *
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/appointments-dispatch-failure.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const at = (relative: string) => new URL(relative, import.meta.url).href;

const afterCallbacks: Array<() => Promise<void>> = [];
const calls: Array<{ fn: string; args: unknown[] }> = [];
const record = (fn: string, result: unknown) => async (...args: unknown[]) => {
  calls.push({ fn, args });
  return result;
};

const EXECUTION = { id: "exec-1", attempt: 1 };
const EVENT = { id: "event-1", organization_id: "org-1" };
const APPOINTMENT = { id: "appt-1", title: "Estimate visit", contact_id: null, contact: null, lead_id: null, start_at: "2027-03-10T14:00:00.000Z" };

mock.module("next/server", { namedExports: { after: (fn: () => Promise<void>) => void afterCallbacks.push(fn) } });
mock.module(at("./n8n.ts"), {
  namedExports: { triggerN8nWorkflow: record("triggerN8nWorkflow", { ok: false, error: "n8n rejected the request (status 500)" }) },
});
mock.module(at("./executions.ts"), {
  namedExports: {
    startWorkflowExecution: record("startWorkflowExecution", { ok: true, execution: EXECUTION }),
    completeWorkflowExecution: record("completeWorkflowExecution", { ok: true }),
    failWorkflowExecution: record("failWorkflowExecution", { ok: true, execution: EXECUTION }),
    startWorkflowExecutionAsService: record("startWorkflowExecutionAsService", { ok: true, execution: EXECUTION }),
    completeWorkflowExecutionAsService: record("completeWorkflowExecutionAsService", { ok: true }),
    failWorkflowExecutionAsService: record("failWorkflowExecutionAsService", { ok: true, execution: EXECUTION }),
  },
});
mock.module(at("./events.ts"), {
  namedExports: {
    createAutomationEvent: record("createAutomationEvent", { ok: true, duplicate: false, skipped: false, event: EVENT }),
    createAutomationEventAsService: record("createAutomationEventAsService", { ok: true, duplicate: false, skipped: false, event: EVENT }),
  },
});
mock.module(at("./outbound-gate.ts"), { namedExports: { evaluateOutboundGate: record("evaluateOutboundGate", null) } });
mock.module(at("../messaging/outbound.ts"), { namedExports: { sendOutboundMessage: record("sendOutboundMessage", null) } });
mock.module(at("../conversations/queries.ts"), { namedExports: { findOrCreateOpenConversation: record("findOrCreateOpenConversation", null) } });
mock.module(at("../appointments/queries.ts"), { namedExports: { getAppointment: record("getAppointment", APPOINTMENT) } });
mock.module(at("../appointments/format.ts"), { namedExports: { formatAppointmentDate: () => "", formatAppointmentTimeRange: () => "" } });
mock.module(at("../settings/queries.ts"), {
  namedExports: {
    getAiSettings: record("getAiSettings", { ai_enabled: true, tone: null, business_introduction: null, general_instructions: null }),
    getBusinessProfile: record("getBusinessProfile", { name: "Test Co", timezone: "UTC" }),
  },
});
mock.module(at("../notifications/founder.ts"), { namedExports: { notifyFounder: record("notifyFounder", undefined) } });
mock.module(at("../supabase/service.ts"), { namedExports: { createServiceRoleClient: () => ({}) } });

const { emitAppointmentNoShowAsService, emitAppointmentNoShow } = await import("./appointments");

// Only query a signed-in emitter now makes itself: reading the appointment's
// organization before creating the event (everything else is mocked above).
const fakeSupabase = {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { organization_id: "org-1" }, error: null }) }) }) }),
} as never;
const called = (fn: string) => calls.filter((c) => c.fn === fn);

async function runAfterCallbacks() {
  while (afterCallbacks.length) await afterCallbacks.shift()!();
}

beforeEach(() => {
  calls.length = 0;
  afterCallbacks.length = 0;
});

test("service-role no-show path: a failed n8n dispatch is recorded with failWorkflowExecutionAsService, never the user-session failWorkflowExecution", async () => {
  await emitAppointmentNoShowAsService(fakeSupabase, "org-1", "appt-1");
  await runAfterCallbacks();

  assert.equal(called("triggerN8nWorkflow").length, 1);
  const serviceFails = called("failWorkflowExecutionAsService");
  assert.equal(serviceFails.length, 1);
  assert.deepEqual(serviceFails[0].args.slice(1), ["exec-1", "n8n rejected the request (status 500)", "n8n_dispatch_failed"]);
  assert.equal(called("failWorkflowExecution").length, 0);
});

test("user-session no-show path (asService false): a failed n8n dispatch is still recorded with failWorkflowExecution, unchanged", async () => {
  await emitAppointmentNoShow(fakeSupabase, "appt-1");
  await runAfterCallbacks();

  assert.equal(called("triggerN8nWorkflow").length, 1);
  const userFails = called("failWorkflowExecution");
  assert.equal(userFails.length, 1);
  assert.deepEqual(userFails[0].args.slice(1), ["exec-1", "n8n rejected the request (status 500)", "n8n_dispatch_failed"]);
  assert.equal(called("failWorkflowExecutionAsService").length, 0);
});
