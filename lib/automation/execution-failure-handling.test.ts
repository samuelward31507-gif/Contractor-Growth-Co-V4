/**
 * P0 A0: AI/model failures and stuck executions become FAILED executions.
 *
 * Runs the REAL n8n callback route (POST), the REAL execution machinery
 * (lib/automation/executions.ts - failWorkflowExecutionAsService /
 * completeWorkflowExecutionAsService) and the REAL stuck-execution timeout
 * against an in-memory store whose fail/complete RPCs mirror the SQL
 * functions' semantics (only a 'running' row transitions; the parent event
 * moves to failed/completed; anything else raises "Execution is not
 * running"). Health signals, founder notifications, the gate and the
 * outbound sender are mocked and only counted. Nothing reaches TEST,
 * Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/execution-failure-handling.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const EXEC = "33333333-3333-4333-8333-333333333333";
const CONV = "44444444-4444-4444-8444-444444444444";
const CONTACT = "55555555-5555-4555-8555-555555555555";
const SECRET = "test-webhook-secret";

let store: Record<string, Row[]> = {};
const calls = { signals: [] as string[], founder: [] as string[], sends: 0, gate: 0 };

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private upsertRow: Row | null = null;
  private max: number | null = null;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  lt(column: string, value: string) { this.filters.push((row) => String(row[column]) < value); return this; }
  order() { return this; }
  limit(n: number) { this.max = n; return this; }
  update(values: Row) { this.updateValues = values; return this; }
  upsert(values: Row) { this.upsertRow = values; return this; }
  maybeSingle() { return this.run(true); }
  single() { return this.run(true); }
  then<T>(resolve: (value: { data: unknown; error: null }) => T, reject?: (reason: unknown) => T) { return this.run(false).then(resolve, reject); }
  private async run(single: boolean) {
    const rows = (store[this.table] ??= []);
    if (this.upsertRow) {
      const key = this.upsertRow.workflow_execution_id;
      if (!rows.some((row) => row.workflow_execution_id === key)) rows.push({ ...this.upsertRow });
      return { data: null, error: null };
    }
    let matched = rows.filter((row) => this.filters.every((f) => f(row)));
    if (this.updateValues) for (const row of matched) Object.assign(row, this.updateValues);
    if (this.max !== null) matched = matched.slice(0, this.max);
    return { data: single ? (matched[0] ?? null) : matched, error: null };
  }
}

/** Mirrors fail_workflow_execution / complete_workflow_execution (service-role branch). */
function rpc(name: string, args: Row) {
  const run = async () => {
    const execution = store.workflow_executions!.find((row) => row.id === args.p_execution_id);
    if (!execution) return { data: null, error: { message: "Execution not found" } };
    if (execution.status !== "running") return { data: null, error: { message: "Execution is not running" } };
    const event = store.automation_events!.find((row) => row.id === execution.automation_event_id);
    if (name === "fail_workflow_execution") {
      Object.assign(execution, { status: "failed", error_message: args.p_error_message, completed_at: "now" });
      if (event?.status === "processing") event.status = "failed";
    } else if (name === "complete_workflow_execution") {
      Object.assign(execution, { status: "completed", metadata: args.p_metadata, completed_at: "now" });
      if (event?.status === "processing") event.status = "completed";
    } else {
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    }
    const plain: Row = { ...execution };
    delete plain.automation_events;
    return { data: plain, error: null };
  };
  return { single: run, then: <T>(resolve: (v: unknown) => T) => run().then(resolve) };
}

const service = { from: (table: string) => new Query(table), rpc };

mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => service } });
mock.module(lib("lib/automation-health/service.ts"), {
  namedExports: {
    recordAutomationHealthSignal: async (_s: unknown, input: Row) => {
      calls.signals.push(String(input.category));
      return { occurrenceCount: 1 };
    },
    resolveAutomationFailureIncidents: async () => undefined,
  },
});
mock.module(lib("lib/notifications/founder.ts"), {
  namedExports: {
    notifyFounder: async (_s: unknown, input: Row) => {
      calls.founder.push(String(input.kind));
    },
  },
});
mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async () => {
      calls.sends += 1;
      return { ok: true, messageId: "m1", conversationId: CONV, providerMessageId: "SM1" };
    },
  },
});
mock.module(lib("lib/automation/outbound-gate.ts"), {
  namedExports: {
    evaluateOutboundGate: async () => {
      calls.gate += 1;
      return { allowed: false, reason: "organization_not_live" };
    },
    // Final Batch 1: the automated-action safeguards are covered in lib/automation/communication-core.test.ts; here they pass.
    evaluateAutomatedActionPreconditions: async () => ({ allowed: true }),
  },
});
const realSettings = await import(lib("lib/settings/queries.ts"));
mock.module(lib("lib/settings/queries.ts"), { namedExports: { ...realSettings, getAiSettings: async () => ({ ai_enabled: true }) } });
mock.module(lib("lib/scheduling/booking.ts"), {
  namedExports: { getAvailableBookingSlots: async () => ({ status: "available", slots: [] }), bookAppointment: async () => ({ success: false }), rescheduleAppointment: async () => ({ success: false }) },
});
mock.module(lib("lib/automation/booking-context.ts"), { namedExports: { getRecentBookingContext: async () => null } });
mock.module(lib("lib/automation/appointments.ts"), { namedExports: { cancelAppointmentAsService: async () => ({ ok: false, reason: "not_found" }) } });
mock.module(lib("lib/reviews-referrals/tracking.ts"), { namedExports: { recordPostJobFollowupOutcome: async () => undefined } });

process.env.N8N_WEBHOOK_SECRET = SECRET;
const { POST, describeAiResultFailure } = await import(lib("app/api/automation/n8n-callback/route.ts"));
const { failTimedOutExecutions, EXECUTION_TIMEOUT_MINUTES } = await import(lib("lib/automation/execution-timeout.ts"));
const { checkRetryEligibility } = await import(lib("lib/automation/retry-eligibility.ts"));

const NOW = new Date("2026-10-05T18:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function seed(startedAt = minutesAgo(1), id = EXEC, eventId = EVENT) {
  const event = {
    id: eventId,
    organization_id: ORG,
    event_type: "customer.message.received",
    entity_type: "conversation",
    entity_id: CONV,
    payload: { conversation_id: CONV, contact_id: CONTACT, lead_id: null },
    status: "processing",
  };
  (store.automation_events ??= []).push(event);
  const execution = {
    id,
    organization_id: ORG,
    automation_event_id: eventId,
    workflow_name: "customer_reply_followup",
    status: "running",
    attempt: 1,
    started_at: startedAt,
    error_message: null,
    metadata: {},
    trigger_source: "event",
    automation_events: event,
  };
  (store.workflow_executions ??= []).push(execution);
  return { event, execution };
}

const AI_FAILURE = {
  should_send: false,
  response_message: null,
  qualification_status: "needs_human",
  missing_information: [],
  urgency: "normal",
  needs_human: true,
  model: null,
  intent: null,
  summary: "AI processing failed",
};
const LEGIT_ESCALATION = { ...AI_FAILURE, model: "claude-sonnet-5", intent: "warranty_question", summary: "Customer asks about warranty terms - needs the contractor." };

function callback(aiResult: unknown, executionId = EXEC, eventId = EVENT) {
  const body: Row = { execution_id: executionId, event_id: eventId, organization_id: ORG };
  if (aiResult !== undefined) body.ai_result = aiResult;
  return POST(
    new Request("https://preview.example/api/automation/n8n-callback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trackpr-webhook-secret": SECRET },
      body: JSON.stringify(body),
    }) as never,
  ) as Promise<Response>;
}

beforeEach(() => {
  store = { workflow_executions: [], automation_events: [], conversations: [{ id: CONV, organization_id: ORG, ai_enabled: true }], ai_interactions: [] };
  calls.signals = [];
  calls.founder = [];
  calls.sends = 0;
  calls.gate = 0;
});

const conversation = () => store.conversations![0]!;

// ---------------------------------------------------------------------------
// Change 2: AI/model failure -> FAILED execution (never a completed AI
// decision). Final Batch 1: on a customer reply the customer is waiting, so the
// conversation is also locked for a human and escalated - the dispatch-failure
// safety net - instead of being left unanswered. Still no AI interaction and
// no send.
// ---------------------------------------------------------------------------

test("model: null -> execution failed, event failed (retryable), no AI interaction, no send; the waiting customer's conversation is locked and escalated once", async () => {
  const { execution, event } = seed();
  const response = await callback(AI_FAILURE);
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(json, { ok: true, failed: true });
  assert.equal(execution.status, "failed");
  assert.match(String(execution.error_message), /^ai_model_failure:/);
  assert.equal(event.status, "failed", "the parent event is failed, so start_workflow_execution can retry it");
  assert.equal(conversation().ai_enabled, false, "the customer is not left waiting: locked for a human");
  assert.deepEqual(calls.signals, ["workflow_failed", "human_escalation_requested"], "the failure incident plus the human escalation");
  assert.deepEqual(calls.founder, ["ai_escalation"]);
  assert.equal(store.ai_interactions!.length, 0, "no AI interaction - this was not an AI decision");
  assert.equal(calls.gate + calls.sends, 0, "no fallback message");
});

test("missing ai_result and ai_result: null -> execution failed the same way", async () => {
  for (const aiResult of [undefined, null]) {
    beforeEachReset();
    const { execution, event } = seed();
    const json = await (await callback(aiResult)).json();
    assert.deepEqual(json, { ok: true, failed: true });
    assert.equal(execution.status, "failed");
    assert.match(String(execution.error_message), /^ai_result_missing:/);
    assert.equal(event.status, "failed");
    assert.equal(conversation().ai_enabled, false);
    assert.deepEqual(calls.founder, ["ai_escalation"]);
    assert.equal(calls.sends, 0);
  }
});

test("a legitimate AI result with needs_human: true still escalates normally (lock + escalation incident + founder notice, completed)", async () => {
  const { execution, event } = seed();
  const json = await (await callback(LEGIT_ESCALATION)).json();

  assert.equal(json.ok, true);
  assert.equal(execution.status, "completed");
  assert.equal(event.status, "completed");
  assert.equal(conversation().ai_enabled, false, "locked for a human");
  assert.ok(calls.signals.includes("human_escalation_requested"));
  assert.ok(!calls.signals.includes("workflow_failed"));
  assert.deepEqual(calls.founder, ["ai_escalation"]);
  assert.equal(store.ai_interactions!.length, 1);
  assert.equal(calls.sends, 0);
});

test("duplicate/late callbacks after an AI failure are idempotent no-ops (even a late 'good' result changes nothing)", async () => {
  const { execution, event } = seed();
  await callback(AI_FAILURE);
  const failedMessage = execution.error_message;

  for (const late of [AI_FAILURE, LEGIT_ESCALATION, { ...LEGIT_ESCALATION, needs_human: false, should_send: true, response_message: "Hi!" }]) {
    const json = await (await callback(late)).json();
    assert.deepEqual(json, { ok: true, alreadyProcessed: true });
  }
  assert.equal(execution.status, "failed");
  assert.equal(execution.error_message, failedMessage);
  assert.equal(event.status, "failed");
  assert.equal(conversation().ai_enabled, false);
  assert.deepEqual(calls.signals, ["workflow_failed", "human_escalation_requested"], "exactly one failure incident and one escalation");
  assert.deepEqual(calls.founder, ["ai_escalation"], "escalated once");
  assert.equal(calls.gate + calls.sends, 0);
});

test("the failed execution is retryable through the existing eligibility gate's rules (status failed, event failed)", async () => {
  const { execution, event } = seed();
  await callback(AI_FAILURE);
  // customer.message.received is not on the safe-retry allowlist - the gate
  // reaches the safety check (it is NOT rejected as not_failed or
  // event_not_retryable), which is the existing architecture's decision.
  const eligibility = await checkRetryEligibility(service as never, ORG, execution.id as string);
  assert.equal(execution.status, "failed");
  assert.equal(event.status, "failed");
  assert.deepEqual(eligibility, { ok: false, reason: "not_safely_retryable", automationId: "inbound-customer-reply" });
});

test("describeAiResultFailure: only a missing result or a null model is a failure", () => {
  assert.match(String(describeAiResultFailure(null)), /^ai_result_missing/);
  assert.match(String(describeAiResultFailure({ ...AI_FAILURE } as never)), /^ai_model_failure/);
  assert.equal(describeAiResultFailure({ ...LEGIT_ESCALATION } as never), null);
  assert.equal(describeAiResultFailure({ ...LEGIT_ESCALATION, model: "test-model", needs_human: false } as never), null);
});

// ---------------------------------------------------------------------------
// Change 3: stuck running executions are timed out
// ---------------------------------------------------------------------------

test("an execution running past the timeout is failed; its event becomes failed/retryable; nothing is sent; a timed-out customer reply is escalated to a human", async () => {
  const { execution, event } = seed(minutesAgo(EXECUTION_TIMEOUT_MINUTES + 5));
  const result = await failTimedOutExecutions(service as never, NOW);

  assert.deepEqual(result.timedOut.map((row: Row) => row.id), [EXEC]);
  assert.equal(result.errors, 0);
  assert.equal(execution.status, "failed");
  assert.match(String(execution.error_message), /^execution_timeout:/);
  assert.equal(event.status, "failed");
  // Final Batch 1: the customer never got an answer - locked and escalated, like a dispatch or AI failure.
  assert.deepEqual(calls.signals, ["workflow_failed", "human_escalation_requested"]);
  assert.equal(conversation().ai_enabled, false);
  assert.deepEqual(calls.founder, ["ai_escalation"]);
  assert.equal(calls.gate + calls.sends, 0);
});

test("a recent running execution (inside the timeout, including one already past the 30-minute stuck threshold) is left alone", async () => {
  const recent = seed(minutesAgo(5)).execution;
  const stuckButNotTimedOut = seed(minutesAgo(45), "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777").execution;

  const result = await failTimedOutExecutions(service as never, NOW);

  assert.deepEqual(result.timedOut, []);
  assert.equal(recent.status, "running");
  assert.equal(stuckButNotTimedOut.status, "running");
  assert.deepEqual(calls.signals, []);
});

test("timeout processing is idempotent: a second tick fails nothing and records nothing new", async () => {
  const { execution } = seed(minutesAgo(EXECUTION_TIMEOUT_MINUTES * 3));
  await failTimedOutExecutions(service as never, NOW);
  const second = await failTimedOutExecutions(service as never, NOW);

  assert.deepEqual(second, { timedOut: [], errors: 0 });
  assert.equal(execution.status, "failed");
  assert.deepEqual(calls.signals, ["workflow_failed", "human_escalation_requested"], "one failure incident and one escalation only");
  assert.deepEqual(calls.founder, ["ai_escalation"]);
});

test("a late n8n callback after the timeout is ignored: no AI processing, no lock, no duplicate send", async () => {
  const { execution, event } = seed(minutesAgo(EXECUTION_TIMEOUT_MINUTES + 1));
  await failTimedOutExecutions(service as never, NOW);

  const late = await (await callback({ ...LEGIT_ESCALATION, needs_human: false, should_send: true, response_message: "Thanks - we'll be in touch." })).json();

  assert.deepEqual(late, { ok: true, alreadyProcessed: true });
  assert.equal(execution.status, "failed");
  assert.equal(event.status, "failed");
  assert.equal(calls.gate + calls.sends, 0);
  assert.equal(store.ai_interactions!.length, 0);
  assert.equal(conversation().ai_enabled, false, "locked by the timeout's escalation - the late callback changed nothing");
  assert.deepEqual(calls.founder, ["ai_escalation"], "escalated once, by the timeout");
});

test("an execution a callback settles first is not counted as timed out", async () => {
  seed(minutesAgo(EXECUTION_TIMEOUT_MINUTES + 1));
  // The callback lands between the scan and the fail call.
  const originalRpc = service.rpc;
  let raced = false;
  (service as { rpc: typeof rpc }).rpc = (name: string, args: Row) => {
    if (!raced) {
      raced = true;
      Object.assign(store.workflow_executions![0]!, { status: "completed" });
    }
    return originalRpc(name, args);
  };
  try {
    const result = await failTimedOutExecutions(service as never, NOW);
    assert.deepEqual(result, { timedOut: [], errors: 0 });
    assert.equal(store.workflow_executions![0]!.status, "completed");
  } finally {
    (service as { rpc: typeof rpc }).rpc = originalRpc;
  }
});

function beforeEachReset() {
  store = { workflow_executions: [], automation_events: [], conversations: [{ id: CONV, organization_id: ORG, ai_enabled: true }], ai_interactions: [] };
  calls.signals = [];
  calls.founder = [];
  calls.sends = 0;
  calls.gate = 0;
}
