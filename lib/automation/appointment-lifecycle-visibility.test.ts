/**
 * P0 A0: a cancellation/reschedule customer notification that the outbound
 * gate blocks - or that the provider rejects - is recorded on the lifecycle
 * execution (blocked_reason/blocked_detail or send_error, existing metadata
 * fields), instead of a silent "completed, lifecycle_only". Runs the REAL
 * emitAppointmentLifecycleEvent(AsService) and its message path with every
 * database/network dependency mocked; nothing reaches TEST, Production,
 * Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/appointment-lifecycle-visibility.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

const APPOINTMENT = {
  id: "appt-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  lead_id: "lead-1",
  title: "Roof inspection",
  status: "cancelled",
  start_at: "2026-10-13T15:00:00.000Z",
  end_at: "2026-10-13T16:00:00.000Z",
};

const state = {
  duplicate: false,
  gate: { allowed: false, reason: "organization_not_live", detail: "TEST mode" } as Record<string, unknown>,
  sendResult: { ok: true, messageId: "msg-1", conversationId: "conv-1", providerMessageId: "SM1" } as Record<string, unknown>,
  completions: [] as Record<string, unknown>[],
  failures: 0,
  sends: 0,
};

const executions = {
  startWorkflowExecution: async () => ({ ok: true, execution: { id: "exec-1" } }),
  startWorkflowExecutionAsService: async () => ({ ok: true, execution: { id: "exec-1" } }),
  completeWorkflowExecution: async (_c: unknown, _id: string, metadata: Record<string, unknown>) => {
    state.completions.push(metadata);
    return { ok: true };
  },
  completeWorkflowExecutionAsService: async (_c: unknown, _id: string, metadata: Record<string, unknown>) => {
    state.completions.push(metadata);
    return { ok: true };
  },
  failWorkflowExecution: async () => {
    state.failures += 1;
    return { ok: true };
  },
  failWorkflowExecutionAsService: async () => {
    state.failures += 1;
    return { ok: true };
  },
};
const event = () => (state.duplicate ? { ok: true, duplicate: true, skipped: false, event: { id: "evt-1", organization_id: "org-1" } } : { ok: true, duplicate: false, skipped: false, event: { id: "evt-1", organization_id: "org-1" } });

mock.module(lib("lib/automation/executions.ts"), { namedExports: executions });
mock.module(lib("lib/automation/events.ts"), { namedExports: { createAutomationEvent: async () => event(), createAutomationEventAsService: async () => event() } });
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => ({}) } });
mock.module(lib("lib/appointments/queries.ts"), { namedExports: { getAppointment: async () => APPOINTMENT } });
mock.module(lib("lib/settings/queries.ts"), { namedExports: { getBusinessProfile: async () => ({ timezone: "America/Denver" }), getAiSettings: async () => ({ ai_enabled: true }) } });
mock.module(lib("lib/conversations/queries.ts"), { namedExports: { findOrCreateOpenConversation: async () => ({ id: "conv-1" }) } });
mock.module(lib("lib/automation/outbound-gate.ts"), { namedExports: { evaluateOutboundGate: async () => state.gate } });
mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async () => {
      state.sends += 1;
      return state.sendResult;
    },
  },
});
mock.module(lib("lib/automation/n8n.ts"), { namedExports: { triggerN8nWorkflow: async () => ({ ok: true }) } });
mock.module(lib("lib/notifications/founder.ts"), { namedExports: { notifyFounder: async () => undefined } });

const { emitAppointmentLifecycleEvent, emitAppointmentLifecycleEventAsService } = await import(lib("lib/automation/appointments.ts"));

const session = { from: () => ({}) };
const quiet = async <T>(fn: () => Promise<T>) => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

beforeEach(() => {
  state.duplicate = false;
  state.gate = { allowed: false, reason: "organization_not_live", detail: "TEST mode" };
  state.sendResult = { ok: true, messageId: "msg-1", conversationId: "conv-1", providerMessageId: "SM1" };
  state.completions = [];
  state.failures = 0;
  state.sends = 0;
});

for (const [label, emit] of [
  ["session", (type: string) => emitAppointmentLifecycleEvent(session as never, "appt-1", type)],
  ["service", (type: string) => emitAppointmentLifecycleEventAsService(session as never, "org-1", "appt-1", type)],
] as const) {
  for (const type of ["appointment.cancelled", "appointment.rescheduled"]) {
    test(`${label}: a gate-blocked ${type} notification is visible on the execution (blocked_reason/blocked_detail), nothing sent`, async () => {
      await quiet(() => emit(type));
      assert.equal(state.completions.length, 1);
      assert.deepEqual(state.completions[0], {
        lifecycle_only: true,
        appointment_id: "appt-1",
        should_send: false,
        blocked_reason: "organization_not_live",
        blocked_detail: "TEST mode",
      });
      assert.equal(state.sends, 0);
    });
  }

  test(`${label}: a provider send failure is visible on the execution (send_error)`, async () => {
    state.gate = { allowed: true, contactId: "contact-1", conversationId: "conv-1", body: "Your appointment was cancelled." };
    state.sendResult = { ok: false, error: "Twilio error 30003", messageId: "msg-1", conversationId: "conv-1" };
    await quiet(() => emit("appointment.cancelled"));
    assert.equal(state.completions[0]?.send_error, "Twilio error 30003");
    assert.equal(state.completions[0]?.should_send, true);
    assert.equal(state.sends, 1, "exactly one attempt - no retry send");
  });

  test(`${label}: a successful send stays a plain success with its message id`, async () => {
    state.gate = { allowed: true, contactId: "contact-1", conversationId: "conv-1", body: "Your appointment was cancelled." };
    await emit("appointment.cancelled");
    assert.deepEqual(state.completions[0], { lifecycle_only: true, appointment_id: "appt-1", should_send: true, message_id: "msg-1" });
    assert.equal(state.failures, 0);
    assert.equal(state.sends, 1);
  });

  test(`${label}: a replayed lifecycle event sends nothing and records nothing (no duplicate outbound)`, async () => {
    state.gate = { allowed: true, contactId: "contact-1", conversationId: "conv-1", body: "x" };
    state.duplicate = true;
    await emit("appointment.cancelled");
    assert.equal(state.sends, 0);
    assert.equal(state.completions.length, 0);
  });

  test(`${label}: appointment.completed stays lifecycle-only with no send fields`, async () => {
    await emit("appointment.completed");
    assert.deepEqual(state.completions[0], { lifecycle_only: true, appointment_id: "appt-1" });
    assert.equal(state.sends, 0);
  });
}
