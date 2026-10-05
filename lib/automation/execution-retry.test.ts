/**
 * P0 A2: execution outcome, retry/backoff, permanent failure, timeout and
 * Today visibility.
 *
 * Runs the REAL retry processor (lib/automation/execution-retry.ts), the
 * REAL retry path (retry.ts -> retry-eligibility.ts -> the real
 * retryAppointmentReminder dispatcher -> the REAL outbound gate), the REAL
 * execution functions (executions.ts) and the REAL stale-timeout scan,
 * against an in-memory store whose RPCs mirror the SQL:
 *   start_workflow_execution - refuses an event already processing or
 *     completed; numbers the attempt max+1; event -> processing
 *   complete/fail_workflow_execution - only a 'running' row transitions;
 *     event -> completed/failed
 * and whose writes derive `outcome` exactly like the A2 trigger
 * workflow_executions_derive_outcome. The SMS provider, n8n, incident
 * recording and business settings are mocked and counted. Nothing reaches
 * TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/execution-retry.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "org-1";
const CONTACT = "contact-1";
const APPT = "appt-1";

let store: Record<string, Row[]> = {};
let ids = 0;
const calls = { sends: 0, n8n: 0, signals: [] as Row[] };
const control = { sendOk: true };

/** Mirrors the A2 trigger workflow_executions_derive_outcome. */
function deriveOutcome(row: Row) {
  const status = row.status;
  const metadata = (row.metadata ?? {}) as Row;
  row.outcome =
    status === "running" ? null
    : status === "completed" ? (metadata.blocked_reason ? "blocked" : "succeeded")
    : status === "failed" ? (String(row.error_message ?? "").startsWith("execution_timeout:") ? "timed_out" : "failed")
    : status === "cancelled" ? "cancelled" : null;
}

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private insertRows: Row[] | null = null;
  private sortBy: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  gt(c: string, v: number) { this.filters.push((r) => Number(r[c]) > v); return this; }
  gte(c: string, v: string) { this.filters.push((r) => String(r[c]) >= v); return this; }
  lt(c: string, v: string) { this.filters.push((r) => String(r[c]) < v); return this; }
  lte(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) <= v); return this; }
  or(expr: string) {
    const clauses = expr.split(",").map((part) => part.split("."));
    this.filters.push((r) => clauses.some(([c, op, v]) => op === "eq" && String(r[c!]) === v));
    return this;
  }
  order(c: string, o?: { ascending?: boolean }) { this.sortBy = { column: c, ascending: o?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  update(v: Row) { this.updateValues = v; return this; }
  insert(v: Row | Row[]) { this.insertRows = Array.isArray(v) ? v : [v]; return this; }
  single() { return this.run(true); }
  maybeSingle() { return this.run(true); }
  then<T>(resolve: (v: { data: unknown; error: unknown }) => T, reject?: (e: unknown) => T) { return this.run(false).then(resolve, reject); }
  private async run(single: boolean): Promise<{ data: unknown; error: unknown }> {
    const rows = (store[this.table] ??= []);
    if (this.insertRows) {
      const inserted = this.insertRows.map((r) => ({ id: `${this.table}-${++ids}`, created_at: new Date().toISOString(), ...r }));
      rows.push(...inserted);
      return { data: single ? inserted[0] : inserted, error: null };
    }
    let matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.updateValues) {
      for (const r of matched) {
        Object.assign(r, this.updateValues);
        if (this.table === "workflow_executions") deriveOutcome(r);
      }
    }
    if (this.sortBy) {
      const { column, ascending } = this.sortBy;
      matched = [...matched].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    if (this.max !== null) matched = matched.slice(0, this.max);
    return { data: single ? (matched[0] ?? null) : matched, error: null };
  }
}

function rpc(name: string, args: Row) {
  const run = async () => {
    const executions = (store.workflow_executions ??= []);
    if (name === "start_workflow_execution") {
      const event = store.automation_events!.find((e) => e.id === args.p_automation_event_id);
      if (!event) return { data: null, error: { message: "Automation event not found" } };
      if (event.status === "processing") return { data: null, error: { message: "Automation event is already being processed" } };
      if (event.status === "completed") return { data: null, error: { message: "Automation event has already completed" } };
      const attempt = Math.max(0, ...executions.filter((e) => e.automation_event_id === event.id).map((e) => Number(e.attempt))) + 1;
      const row: Row = { id: `exec-${++ids}`, organization_id: event.organization_id, automation_event_id: event.id, workflow_name: args.p_workflow_name, status: "running", attempt, started_at: new Date().toISOString(), completed_at: null, error_message: null, metadata: args.p_metadata ?? {}, trigger_source: args.p_trigger_source, retry_state: null, next_retry_at: null, max_attempts: null, retry_detail: null };
      deriveOutcome(row);
      executions.push(row);
      event.status = "processing";
      return { data: { ...row }, error: null };
    }
    const execution = executions.find((e) => e.id === args.p_execution_id);
    if (!execution) return { data: null, error: { message: "Execution not found" } };
    if (execution.status !== "running") return { data: null, error: { message: "Execution is not running" } };
    const event = store.automation_events!.find((e) => e.id === execution.automation_event_id);
    if (name === "complete_workflow_execution") {
      Object.assign(execution, { status: "completed", metadata: args.p_metadata ?? {}, completed_at: new Date().toISOString() });
      if (event?.status === "processing") event.status = "completed";
    } else if (name === "fail_workflow_execution") {
      Object.assign(execution, { status: "failed", error_message: args.p_error_message, completed_at: new Date().toISOString() });
      if (event?.status === "processing") event.status = "failed";
    } else return { data: null, error: { message: `unexpected rpc ${name}` } };
    deriveOutcome(execution);
    return { data: { ...execution }, error: null };
  };
  return { single: run, then: <T>(resolve: (v: unknown) => T) => run().then(resolve) };
}

const db = { from: (t: string) => new Query(t), rpc };

mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => db } });
mock.module(lib("lib/automation-health/service.ts"), {
  namedExports: {
    recordAutomationHealthSignal: async (_s: unknown, input: Row) => {
      calls.signals.push(input);
      return { occurrenceCount: 1 };
    },
    resolveAutomationFailureIncidents: async () => undefined,
  },
});
mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async (_s: unknown, input: Row) => {
      calls.sends += 1;
      store.messages!.push({ id: `msg-${++ids}`, workflow_execution_id: input.workflowExecutionId, direction: "outbound" });
      return control.sendOk ? { ok: true, messageId: "m", conversationId: "c", providerMessageId: "SM" } : { ok: false, error: "Twilio error 30003", messageId: null, conversationId: null };
    },
  },
});
mock.module(lib("lib/automation/n8n.ts"), {
  namedExports: {
    triggerN8nWorkflow: async () => {
      calls.n8n += 1;
      return { ok: true };
    },
  },
});
mock.module(lib("lib/settings/queries.ts"), {
  namedExports: {
    getBusinessProfile: async () => ({ name: "QA Fixture Roofing", timezone: "UTC" }),
    getBusinessHours: async () => [],
    getOrganizationTimezone: async () => "UTC",
    getAiSettings: async () => ({ ai_enabled: true }),
  },
});

const { decideRetry, classifyFailedExecutions, processDueRetries, RETRY_LEASE_MINUTES } = await import(lib("lib/automation/execution-retry.ts"));
const { AUTOMATIC_RETRY_POLICY, SAFE_RETRY_AUTOMATION_IDS, UNSAFE_RETRY_WORKFLOW_NAMES, retryDelayMinutes, checkRetryEligibility } = await import(lib("lib/automation/retry-eligibility.ts"));
const { AUTOMATION_CATALOG } = await import(lib("lib/automation/catalog.ts"));
const { failWorkflowExecutionAsService, MAX_WORKFLOW_RETRY_ATTEMPTS } = await import(lib("lib/automation/executions.ts"));
const { failTimedOutExecutions, EXECUTION_TIMEOUT_MINUTES } = await import(lib("lib/automation/execution-timeout.ts"));
const { buildAutomationAttentionItems, executionDisposition, loadAutomationAttention } = await import(lib("lib/automation/execution-visibility.ts"));
const { assembleDecisions } = await import(lib("lib/decisions/assemble.ts"));

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
let clock = T0;
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const advanceTo = (minutes: number) => {
  clock = T0 + minutes * 60_000;
  mock.timers.setTime(clock);
};

beforeEach(() => {
  store = {
    organizations: [{ id: ORG, automation_mode: "live", payment_status: "active", automation_paused: false }],
    contacts: [{ id: CONTACT, organization_id: ORG, sms_opt_out: false, phone: "+15550142299", phone_normalized: "+15550142299" }],
    conversations: [{ id: "conv-1", organization_id: ORG, contact_id: CONTACT, lead_id: null, channel: "sms", status: "open", ai_enabled: true }],
    appointments: [{ id: APPT, organization_id: ORG, contact_id: CONTACT, lead_id: null, title: "Roof inspection", status: "scheduled", start_at: "2026-10-06T15:00:00.000Z", end_at: "2026-10-06T16:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" }],
    automation_events: [],
    workflow_executions: [],
    messages: [],
    automation_settings: [],
  };
  ids = 0;
  clock = T0;
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: T0 });
  calls.sends = 0;
  calls.n8n = 0;
  calls.signals = [];
  control.sendOk = true;
});

/** A reminder event whose first attempt is running (as the cron dispatch leaves it). */
function startReminder(workflowName = "appointment_reminder", eventType = "appointment.reminder") {
  const event: Row = { id: `evt-${++ids}`, organization_id: ORG, event_type: eventType, entity_type: "appointment", entity_id: APPT, payload: { appointment_id: APPT }, status: "pending" };
  store.automation_events!.push(event);
  const execution: Row = { id: `exec-${++ids}`, organization_id: ORG, automation_event_id: event.id, workflow_name: workflowName, status: "running", attempt: 1, started_at: new Date(clock).toISOString(), completed_at: null, error_message: null, metadata: {}, trigger_source: "event", retry_state: null, next_retry_at: null, max_attempts: null, retry_detail: null };
  deriveOutcome(execution);
  store.workflow_executions!.push(execution);
  event.status = "processing";
  return { event, execution };
}
const executionsOf = (eventId: unknown) => store.workflow_executions!.filter((e) => e.automation_event_id === eventId).sort((a, b) => Number(a.attempt) - Number(b.attempt));
const quiet = async <T>(fn: () => Promise<T>) => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

// ===========================================================================
// Policy
// ===========================================================================

test("policy: exactly the gate-allowed workflows are auto-retryable; estimate_sent_followup and every other n8n workflow are not", () => {
  const allowed = AUTOMATION_CATALOG.filter((a: Row) => SAFE_RETRY_AUTOMATION_IDS.has(a.id as string))
    .flatMap((a: Row) => a.workflowNames as string[])
    .filter((name: string) => !UNSAFE_RETRY_WORKFLOW_NAMES.has(name));
  assert.deepEqual(Object.keys(AUTOMATIC_RETRY_POLICY).sort(), [...allowed].sort());
  assert.equal(AUTOMATIC_RETRY_POLICY.estimate_sent_followup, undefined);
  assert.equal(AUTOMATIC_RETRY_POLICY.customer_reply_followup, undefined);
  for (const policy of Object.values(AUTOMATIC_RETRY_POLICY) as { maxAttempts: number }[]) assert.ok(policy.maxAttempts <= MAX_WORKFLOW_RETRY_ATTEMPTS);
});

test("backoff is bounded and exponential: 5, 15, 45, then capped at 60 minutes", () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(retryDelayMinutes), [5, 15, 45, 60, 60]);
});

test("decideRetry: first failure schedules at failure+5m; second at failure+15m; third is exhausted; unsafe is not_retryable", () => {
  const base = { workflow_name: "appointment_reminder", automation_event_id: "e", started_at: at(0).toISOString() };
  const first = decideRetry({ ...base, attempt: 1, completed_at: at(1).toISOString() }, at(2));
  assert.deepEqual(first, { retryState: "scheduled", nextRetryAt: at(6).toISOString(), maxAttempts: 3, detail: "retry 2 of 3 scheduled" });
  assert.equal(decideRetry({ ...base, attempt: 2, completed_at: at(10).toISOString() }, at(10)).nextRetryAt, at(25).toISOString());
  assert.equal(decideRetry({ ...base, attempt: 3, completed_at: at(30).toISOString() }, at(30)).retryState, "exhausted");
  assert.equal(decideRetry({ ...base, workflow_name: "estimate_sent_followup", attempt: 1, completed_at: at(1).toISOString() }, at(1)).retryState, "not_retryable");
  // Never scheduled in the past (a failure classified late retries promptly, not retroactively).
  assert.equal(decideRetry({ ...base, attempt: 1, completed_at: at(0).toISOString() }, at(60)).nextRetryAt, at(60).toISOString());
});

// ===========================================================================
// Execution states
// ===========================================================================

test("states: success -> succeeded; gate block -> blocked (never failed); technical failure -> failed", async () => {
  const ok = startReminder().execution;
  await failWorkflowExecutionAsService(db as never, ok.id as string, "boom");
  assert.equal(ok.outcome, "failed");

  const blocked = startReminder();
  await db.rpc("complete_workflow_execution", { p_execution_id: blocked.execution.id, p_metadata: { should_send: false, blocked_reason: "organization_not_live" } }).single();
  assert.equal(blocked.execution.outcome, "blocked");
  assert.equal(blocked.execution.status, "completed");

  const sent = startReminder();
  await db.rpc("complete_workflow_execution", { p_execution_id: sent.execution.id, p_metadata: { should_send: true, blocked_reason: null } }).single();
  assert.equal(sent.execution.outcome, "succeeded");
});

// ===========================================================================
// Retry: schedule, attempts, timing, idempotency
// ===========================================================================

test("first failure schedules a retry with next_retry_at stored; repeated classification decides once", async () => {
  const { execution } = startReminder();
  await failWorkflowExecutionAsService(db as never, execution.id as string, "provider timeout");
  advanceTo(1);
  const first = await classifyFailedExecutions(db as never, at(1));
  const second = await classifyFailedExecutions(db as never, at(2));

  assert.deepEqual(first.decided, [{ id: execution.id, retryState: "scheduled" }]);
  assert.deepEqual(second.decided, []);
  assert.equal(execution.retry_state, "scheduled");
  assert.equal(execution.next_retry_at, at(5).toISOString());
  assert.equal(execution.max_attempts, 3);
});

test("concurrent classification ticks record exactly one decision", async () => {
  const { execution } = startReminder();
  await failWorkflowExecutionAsService(db as never, execution.id as string, "provider timeout");
  const [a, b] = await Promise.all([classifyFailedExecutions(db as never, at(0)), classifyFailedExecutions(db as never, at(0))]);
  assert.equal(a.decided.length + b.decided.length, 1);
});

test("a retry never runs before next_retry_at; when due it runs once through the gate and sends once; repeated/concurrent processing does not retry twice", async () => {
  const { event, execution } = startReminder();
  await failWorkflowExecutionAsService(db as never, execution.id as string, "provider timeout");
  await classifyFailedExecutions(db as never, at(0));

  advanceTo(4);
  assert.deepEqual(await processDueRetries(db as never, at(4)), { started: [], stopped: [], errors: 0 });
  assert.equal(executionsOf(event.id).length, 1);

  advanceTo(6);
  const [a, b] = await Promise.all([processDueRetries(db as never, at(6)), processDueRetries(db as never, at(6))]);
  await processDueRetries(db as never, at(7));

  const attempts = executionsOf(event.id);
  assert.equal(attempts.length, 2, "exactly one new attempt");
  assert.equal(a.started.length + b.started.length, 1);
  assert.equal(a.stopped.length + b.stopped.length, 0, "the losing tick never even attempts (lease), it does not rely on the start RPC refusing");
  assert.equal(attempts[1]!.attempt, 2, "attempt incremented exactly once");
  assert.equal(attempts[1]!.trigger_source, "retry");
  assert.equal(attempts[1]!.outcome, "succeeded");
  assert.equal(execution.retry_state, "retried");
  assert.equal(calls.sends, 1, "one customer message, sent by the gated retry");
});

test("a retry still goes through the outbound gate: STOP blocks it, START restores it", async () => {
  const { event, execution } = startReminder();
  await failWorkflowExecutionAsService(db as never, execution.id as string, "provider timeout");
  await classifyFailedExecutions(db as never, at(0));
  store.contacts![0]!.sms_opt_out = true; // STOP arrived meanwhile
  advanceTo(6);
  await processDueRetries(db as never, at(6));
  const retried = executionsOf(event.id)[1]!;
  assert.equal(retried.outcome, "blocked");
  assert.equal((retried.metadata as Row).blocked_reason, "contact_opted_out");
  assert.equal(calls.sends, 0);

  // START: a later, fresh reminder flows normally.
  store.contacts![0]!.sms_opt_out = false;
  const fresh = startReminder();
  await failWorkflowExecutionAsService(db as never, fresh.execution.id as string, "provider timeout");
  await classifyFailedExecutions(db as never, at(6));
  advanceTo(12);
  await processDueRetries(db as never, at(12));
  assert.equal(executionsOf(fresh.event.id)[1]!.outcome, "succeeded");
  assert.equal(calls.sends, 1);
});

for (const [label, arrange, reason] of [
  ["payment inactive", () => (store.organizations![0]!.payment_status = "payment_required"), "organization_payment_inactive"],
  ["organization not live (TEST mode)", () => (store.organizations![0]!.automation_mode = "test"), "organization_not_live"],
  ["automation paused", () => (store.organizations![0]!.automation_paused = true), "organization_automation_paused"],
] as const) {
  test(`a retry cannot bypass ${label}: blocked (${reason}), nothing sent`, async () => {
    const { event, execution } = startReminder();
    await failWorkflowExecutionAsService(db as never, execution.id as string, "provider timeout");
    await classifyFailedExecutions(db as never, at(0));
    (arrange as () => void)();
    advanceTo(6);
    await processDueRetries(db as never, at(6));
    const retried = executionsOf(event.id)[1]!;
    assert.equal(retried.outcome, "blocked");
    assert.equal((retried.metadata as Row).blocked_reason, reason);
    assert.equal(calls.sends, 0);
  });
}

test("retry exhaustion: three failed attempts end permanently failed; no fourth attempt; no customer failure message; no extra incident", async () => {
  control.sendOk = false;
  const { event, execution } = startReminder();
  await failWorkflowExecutionAsService(db as never, execution.id as string, "provider timeout", "sms_send_failed");
  let minute = 0;
  for (let tick = 0; tick < 12; tick++) {
    minute += 15;
    advanceTo(minute);
    await quiet(() => classifyFailedExecutions(db as never, at(minute)));
    await quiet(() => processDueRetries(db as never, at(minute)));
  }
  const attempts = executionsOf(event.id);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map((e) => e.retry_state), ["retried", "retried", "exhausted"]);
  assert.equal(attempts[2]!.max_attempts, 3);
  assert.match(String(attempts[2]!.retry_detail), /^retry_exhausted/);
  assert.equal(calls.sends, 2, "only the two gated retry sends were attempted - never a 'we failed' message");
  // Every failure signal is the existing per-automation one (folds into one incident); A2 adds none.
  const contexts = new Set(calls.signals.map((s) => s.fingerprintContext));
  assert.equal(contexts.size, 1);
  assert.ok(calls.signals.every((s) => s.category === "sms_send_failed" || s.category === "workflow_failed"));
});

test("non-retryable workflows never enter automatic retry (estimate_sent_followup, customer_reply_followup)", async () => {
  for (const [workflow, type] of [["estimate_sent_followup", "estimate.sent"], ["customer_reply_followup", "customer.message.received"]]) {
    const { execution } = startReminder(workflow, type);
    await failWorkflowExecutionAsService(db as never, execution.id as string, "ai_model_failure: x");
    await classifyFailedExecutions(db as never, at(0));
    assert.equal(execution.retry_state, "not_retryable");
    assert.equal(execution.retry_detail, "not_safely_retryable");
    assert.equal(execution.next_retry_at, null);
  }
  advanceTo(600);
  assert.deepEqual(await processDueRetries(db as never, at(600)), { started: [], stopped: [], errors: 0 });
  assert.equal(calls.n8n, 0);
  assert.equal(store.workflow_executions!.length, 2);
});

test("a disabled automation stops at retry time as not_retryable (needs a person), never retried", async () => {
  const { event, execution } = startReminder();
  await failWorkflowExecutionAsService(db as never, execution.id as string, "provider timeout");
  await classifyFailedExecutions(db as never, at(0));
  store.automation_settings!.push({ organization_id: ORG, automation_id: "appointment-reminders", enabled: false });
  advanceTo(6);
  const result = await processDueRetries(db as never, at(6));
  assert.deepEqual(result.stopped, [{ id: execution.id, reason: "automation_disabled" }]);
  assert.equal(execution.retry_state, "not_retryable");
  assert.equal(executionsOf(event.id).length, 1);
});

test("a failure whose event already has a newer attempt (staff retried it) is recorded as retried, not re-scheduled", async () => {
  const { event, execution } = startReminder();
  await failWorkflowExecutionAsService(db as never, execution.id as string, "provider timeout");
  await db.rpc("start_workflow_execution", { p_automation_event_id: event.id, p_workflow_name: "appointment_reminder", p_trigger_source: "retry" }).single();
  await classifyFailedExecutions(db as never, at(0));
  assert.equal(execution.retry_state, "retried");
  assert.equal(execution.retry_detail, "superseded_by_newer_attempt");
});

test("a crashed retry (lease taken, nothing started) is picked up again after the lease expires - never lost", async () => {
  const { event, execution } = startReminder();
  await failWorkflowExecutionAsService(db as never, execution.id as string, "provider timeout");
  await classifyFailedExecutions(db as never, at(0));
  // Simulate a tick that leased the row and died before retrying.
  execution.next_retry_at = at(5 + RETRY_LEASE_MINUTES).toISOString();
  advanceTo(10);
  assert.equal((await processDueRetries(db as never, at(10))).started.length, 0);
  advanceTo(5 + RETRY_LEASE_MINUTES);
  assert.equal((await processDueRetries(db as never, at(5 + RETRY_LEASE_MINUTES))).started.length, 1);
  assert.equal(executionsOf(event.id).length, 2);
});

// ===========================================================================
// Timeout (A0) under A2 semantics
// ===========================================================================

test("timeout: a stale execution is failed (outcome timed_out), its event is no longer processing, then gets one retry decision; repeated scans are idempotent", async () => {
  const { event, execution } = startReminder();
  advanceTo(EXECUTION_TIMEOUT_MINUTES + 5);
  await failTimedOutExecutions(db as never, at(EXECUTION_TIMEOUT_MINUTES + 5));
  await failTimedOutExecutions(db as never, at(EXECUTION_TIMEOUT_MINUTES + 6));
  assert.equal(execution.outcome, "timed_out");
  assert.equal(event.status, "failed");
  await classifyFailedExecutions(db as never, at(EXECUTION_TIMEOUT_MINUTES + 6));
  await classifyFailedExecutions(db as never, at(EXECUTION_TIMEOUT_MINUTES + 7));
  assert.equal(execution.retry_state, "scheduled");
  assert.equal(calls.sends, 0, "timing out sends nothing");
  assert.equal(calls.signals.length, 1, "one failure signal for the timeout");
});

// ===========================================================================
// Visibility (Today)
// ===========================================================================

const vrow = (over: Row) => ({ id: `v-${++ids}`, automation_event_id: `e-${ids}`, workflow_name: "appointment_reminder", status: "failed", outcome: "failed", retry_state: null, retry_detail: null, next_retry_at: null, attempt: 1, metadata: {}, ...over }) as never;

test("disposition: each lifecycle state is distinct", () => {
  assert.equal(executionDisposition(vrow({ status: "running", outcome: null })), "processing");
  assert.equal(executionDisposition(vrow({ status: "completed", outcome: "succeeded" })), "succeeded");
  assert.equal(executionDisposition(vrow({ status: "completed", outcome: "blocked", metadata: { blocked_reason: "contact_opted_out" } })), "blocked");
  assert.equal(executionDisposition(vrow({ status: "completed", outcome: "blocked", metadata: { blocked_reason: "organization_payment_inactive" } })), "blocked_needs_person");
  assert.equal(executionDisposition(vrow({})), "retry_pending");
  assert.equal(executionDisposition(vrow({ retry_state: "scheduled" })), "retry_scheduled");
  assert.equal(executionDisposition(vrow({ retry_state: "retried" })), "retried");
  assert.equal(executionDisposition(vrow({ retry_state: "exhausted" })), "stopped_retrying");
  assert.equal(executionDisposition(vrow({ retry_state: "not_retryable" })), "not_retryable");
  assert.equal(executionDisposition(vrow({ outcome: "timed_out", retry_state: "scheduled" })), "retry_scheduled");
});

test("Today: permanent failures and person-blocked sends are Needs You (one row per automation); retrying/processing work is Trackpr's; routine blocks and pre-A2 history never surface", () => {
  const items = buildAutomationAttentionItems([
    vrow({ retry_state: "exhausted" }),
    vrow({ retry_state: "exhausted" }),
    vrow({ workflow_name: "customer_reply_followup", retry_state: "not_retryable" }),
    vrow({ status: "completed", outcome: "blocked", workflow_name: "lead_created_followup", metadata: { blocked_reason: "invalid_destination" } }),
    vrow({ status: "completed", outcome: "blocked", workflow_name: "lead_created_followup", metadata: { blocked_reason: "organization_not_live" } }),
    vrow({ retry_state: "not_retryable", retry_detail: "pre_a2_failure", workflow_name: "job_created_followup" }),
    vrow({ workflow_name: "estimate_followup", retry_state: "scheduled" }),
    vrow({ workflow_name: "estimate_followup", status: "running", outcome: null }),
  ]);
  const needs = items.filter((i: Row) => i.kind === "automation_needs_attention");
  const handling = items.filter((i: Row) => i.kind === "automation_retrying");
  assert.deepEqual(needs.map((i: Row) => i.title).sort(), ["Appointment Reminders", "Inbound Customer Reply", "Instant Lead Follow-Up"]);
  assert.equal(needs.find((i: Row) => i.title === "Appointment Reminders")!.detail, "2 runs failed and Trackpr stopped retrying.");
  assert.equal(needs.find((i: Row) => i.title === "Instant Lead Follow-Up")!.detail, "1 message was held back for something only you can fix.");
  assert.deepEqual(handling.map((i: Row) => [i.title, i.detail]), [["Estimate Follow-Up", "Trackpr is working on 2 runs and will retry if needed."]]);
  assert.ok(!JSON.stringify(items).includes("exec-"), "no internal ids in operator copy");
});

test("Today: a permanent failure someone already retried no longer needs anyone", () => {
  const row = vrow({ retry_state: "exhausted" });
  assert.equal(buildAutomationAttentionItems([row], new Set([(row as Row).id as string])).length, 0);
});

test("Today decisions: Needs-You automation items are human exceptions; retrying ones count toward 'Trackpr is handling'", () => {
  const decisions = assembleDecisions({
    attentionItems: buildAutomationAttentionItems([vrow({ retry_state: "exhausted" }), vrow({ workflow_name: "estimate_followup", retry_state: "scheduled" })]),
    prioritizedOpportunities: [],
  });
  assert.deepEqual(decisions.exceptions.map((d: Row) => [d.problemLabel, d.actor]), [["Automation needs you", "human"]]);
  assert.deepEqual(decisions.trackprHandling.map((d: Row) => d.reasonCode), ["automation_retrying"]);
  assert.equal(decisions.totalNeedingAttention, 1);
});

test("Today loader: reads the store end to end, and yields nothing (never throws) when the A2 columns are missing", async () => {
  const { execution } = startReminder();
  await failWorkflowExecutionAsService(db as never, execution.id as string, "boom");
  execution.retry_state = "exhausted";
  const items = await loadAutomationAttention(db as never, ORG, at(1));
  assert.deepEqual(items.map((i: Row) => i.kind), ["automation_needs_attention"]);

  const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "column workflow_executions.outcome does not exist" } }) }), or: () => ({ gte: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "column does not exist" } }) }) }) }) }) }) }) };
  assert.deepEqual(await quiet(() => loadAutomationAttention(broken as never, ORG, at(1))), []);
});

test("eligibility gate still rejects unsafe workflows even if asked directly", async () => {
  const { execution } = startReminder("estimate_sent_followup", "estimate.sent");
  await failWorkflowExecutionAsService(db as never, execution.id as string, "boom");
  const result = await checkRetryEligibility(db as never, ORG, execution.id as string);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "not_safely_retryable");
});
