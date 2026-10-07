/**
 * P0-B B2.8a (HIGH-1): a concurrent duplicate n8n callback must never fail
 * the execution another request is already sending.
 *
 * Runs the REAL n8n callback route (POST), the REAL sendOutboundMessage and
 * the REAL execution machinery against an in-memory store that enforces the
 * outbound unique index (messages.workflow_execution_id where direction =
 * 'outbound' -> 23505) and mirrors the fail/complete RPCs (only a 'running'
 * row transitions; the parent event follows). The gate is mocked to ALLOW
 * behind a barrier (both callbacks pass it before either inserts - the real
 * race window), and the SMS provider is held so the winner's message row is
 * still 'queued' when the loser hits the index. Nothing reaches TEST,
 * Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/api/automation/n8n-callback/duplicate-callback.test.ts
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
const LEAD = "66666666-6666-4666-8666-666666666666";
const SECRET = "test-webhook-secret";
const NOW = new Date();
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

let store: Record<string, Row[]> = {};
let ids = 0;
const calls = { gate: 0, provider: 0, signals: [] as string[] };

// The gate lets both callbacks through only once both have reached it.
let gateArrivals = 0;
let openGate: () => void = () => undefined;
let gateOpen = Promise.resolve();
// The provider call is held until the test releases it.
let releaseProvider: () => void = () => undefined;
let providerHeld = Promise.resolve();
let providerOk = true;

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private insertRow: Row | null = null;
  private upsertRow: Row | null = null;
  private max: number | null = null;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  gt(column: string, value: string) { this.filters.push((row) => row[column] != null && String(row[column]) > value); return this; }
  lt(column: string, value: string) { this.filters.push((row) => row[column] != null && String(row[column]) < value); return this; }
  order() { return this; }
  limit(n: number) { this.max = n; return this; }
  update(values: Row) { this.updateValues = values; return this; }
  insert(values: Row) { this.insertRow = values; return this; }
  upsert(values: Row) { this.upsertRow = values; return this; }
  maybeSingle() { return this.run(true); }
  single() { return this.run(true); }
  then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (reason: unknown) => T) { return this.run(false).then(resolve, reject); }
  private async run(single: boolean): Promise<{ data: unknown; error: unknown }> {
    const rows = (store[this.table] ??= []);
    if (this.upsertRow) {
      const key = this.upsertRow.workflow_execution_id;
      if (!rows.some((row) => row.workflow_execution_id === key)) rows.push({ ...this.upsertRow });
      return { data: null, error: null };
    }
    if (this.insertRow) {
      const row: Row = { id: `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`, created_at: new Date().toISOString(), ...this.insertRow };
      // The outbound unique index - the database's own duplicate-send guarantee.
      if (this.table === "messages" && row.direction === "outbound" && row.workflow_execution_id && rows.some((r) => r.direction === "outbound" && r.workflow_execution_id === row.workflow_execution_id)) {
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint messages_outbound_execution_unique" } };
      }
      rows.push(row);
      return { data: { ...row }, error: null };
    }
    let matched = rows.filter((row) => this.filters.every((f) => f(row)));
    if (this.updateValues) for (const row of matched) Object.assign(row, this.updateValues);
    if (this.max !== null) matched = matched.slice(0, this.max);
    const copy = matched.map((row) => ({ ...row }));
    return { data: single ? (copy[0] ?? null) : copy, error: null };
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
      Object.assign(execution, { status: "failed", error_message: args.p_error_message, completed_at: new Date().toISOString() });
      if (event?.status === "processing") event.status = "failed";
    } else if (name === "complete_workflow_execution") {
      Object.assign(execution, { status: "completed", metadata: args.p_metadata, completed_at: new Date().toISOString() });
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
mock.module(lib("lib/notifications/founder.ts"), { namedExports: { notifyFounder: async () => undefined } });
const realGate = await import(lib("lib/automation/outbound-gate.ts"));
mock.module(lib("lib/automation/outbound-gate.ts"), {
  namedExports: {
    ...realGate,
    evaluateOutboundGate: async (_s: unknown, input: { contactId: string; conversationId: string; aiResult: { response_message: string } }) => {
      calls.gate += 1;
      gateArrivals += 1;
      if (gateArrivals === 2) openGate();
      await gateOpen;
      return { allowed: true, contactId: input.contactId, conversationId: input.conversationId, body: input.aiResult.response_message };
    },
  },
});
const realSms = await import(lib("lib/automation/sms.ts"));
mock.module(lib("lib/automation/sms.ts"), {
  namedExports: {
    ...realSms,
    sendSms: async () => {
      calls.provider += 1;
      await providerHeld;
      return providerOk ? { ok: true, providerMessageId: "SM-1" } : { ok: false, error: "Twilio error 30003" };
    },
  },
});
mock.module(lib("lib/settings/queries.ts"), { namedExports: { getAiSettings: async () => ({ ai_enabled: true }) } });
mock.module(lib("lib/scheduling/booking.ts"), {
  namedExports: { getAvailableBookingSlots: async () => ({ status: "available", slots: [] }), bookAppointment: async () => ({ success: false }), rescheduleAppointment: async () => ({ success: false }) },
});
mock.module(lib("lib/automation/booking-context.ts"), { namedExports: { getRecentBookingContext: async () => null } });
mock.module(lib("lib/automation/appointments.ts"), { namedExports: { cancelAppointmentAsService: async () => ({ ok: false, reason: "not_found" }) } });
mock.module(lib("lib/reviews-referrals/tracking.ts"), { namedExports: { recordPostJobFollowupOutcome: async () => undefined } });

process.env.N8N_WEBHOOK_SECRET = SECRET;
const { POST } = await import(lib("app/api/automation/n8n-callback/route.ts"));
const { sendOutboundMessage } = await import(lib("lib/messaging/outbound.ts"));
const { checkRetryEligibility } = await import(lib("lib/automation/retry-eligibility.ts"));

const DRAFT = {
  should_send: true,
  response_message: "Hi Riley, thanks for reaching out about your roof - when is a good time to talk?",
  qualification_status: "qualifying",
  missing_information: [],
  urgency: "normal",
  needs_human: false,
  model: "claude-sonnet-5",
  intent: null,
  summary: null,
};

/** An Instant Lead Follow-Up execution - the one n8n workflow A2 retries automatically. */
function seed() {
  const event = { id: EVENT, organization_id: ORG, event_type: "lead.created", entity_type: "lead", entity_id: LEAD, payload: { lead_id: LEAD, contact_id: CONTACT, conversation_id: CONV }, status: "processing", created_at: minutesAgo(1) };
  const execution = { id: EXEC, organization_id: ORG, automation_event_id: EVENT, workflow_name: "lead_created_followup", status: "running", attempt: 1, started_at: minutesAgo(1), error_message: null, metadata: {}, trigger_source: "event", automation_events: event };
  store = {
    automation_events: [event],
    workflow_executions: [execution],
    automation_settings: [{ organization_id: ORG, automation_id: "instant-lead-followup", enabled: true, config: null }],
    organizations: [{ id: ORG, automation_paused: false }],
    leads: [{ id: LEAD, organization_id: ORG, contact_id: CONTACT, status: "new" }],
    contacts: [{ id: CONTACT, organization_id: ORG, phone: "+15550142301", phone_normalized: "+15550142301", sms_opt_out: false }],
    conversations: [{ id: CONV, organization_id: ORG, contact_id: CONTACT, channel: "sms", status: "open", ai_enabled: true }],
    messages: [],
    ai_interactions: [],
    appointments: [],
    estimates: [],
    jobs: [],
  };
  return { event, execution };
}

function callback() {
  return POST(
    new Request("https://preview.example/api/automation/n8n-callback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trackpr-webhook-secret": SECRET },
      body: JSON.stringify({ execution_id: EXEC, event_id: EVENT, organization_id: ORG, ai_result: DRAFT }),
    }) as never,
  ) as Promise<Response>;
}

beforeEach(() => {
  ids = 0;
  calls.gate = 0;
  calls.provider = 0;
  calls.signals = [];
  gateArrivals = 0;
  gateOpen = new Promise((resolve) => (openGate = resolve));
  providerHeld = new Promise((resolve) => (releaseProvider = resolve));
  providerOk = true;
});

const outbound = () => store.messages!.filter((m) => m.direction === "outbound");

test("HIGH-1: a concurrent duplicate callback that loses the outbound index never fails the execution the winner is sending", async () => {
  const { execution, event } = seed();
  const first = callback();
  const second = callback();
  // Whichever callback lost the outbound insert answers while the winner's SMS is still in flight.
  const loser = await Promise.race([first, second]);
  assert.equal(calls.gate, 2, "both callbacks passed the gate - the real race window");
  assert.equal(calls.provider, 1, "only the winner reached the provider");
  assert.deepEqual(await loser.clone().json(), { ok: true, alreadyProcessed: true }, "the loser is an in-progress duplicate, not a send failure");
  assert.equal(execution.status, "running", "the loser did NOT fail the execution");
  assert.equal(event.status, "processing");
  assert.deepEqual(outbound().map((m) => m.status), ["queued"], "the winner's message row is still queued at this moment");

  releaseProvider();
  const responses = await Promise.all([first, second]);
  assert.deepEqual((await Promise.all(responses.map((r) => r.json()))).map((j) => JSON.stringify(j)).sort(), [JSON.stringify({ ok: true }), JSON.stringify({ ok: true, alreadyProcessed: true })].sort());
  // The winner's normal completion stands.
  assert.equal(execution.status, "completed");
  assert.equal(event.status, "completed");
  assert.deepEqual(
    { should_send: (execution.metadata as Row).should_send, message_id: (execution.metadata as Row).message_id, provider: (execution.metadata as Row).provider_message_id },
    { should_send: true, message_id: outbound()[0].id, provider: "SM-1" },
  );
  assert.deepEqual(outbound().map((m) => ({ status: m.status, execution: m.workflow_execution_id })), [{ status: "sent", execution: EXEC }], "exactly one outbound message");
  assert.equal(store.workflow_executions!.length, 1, "no second execution");
  assert.ok(!calls.signals.includes("sms_send_failed"), "no sms_send_failed incident");
  // Never retryable: A2's eligibility gate refuses a completed execution.
  const eligibility = await checkRetryEligibility(service as never, ORG, EXEC);
  assert.deepEqual({ ok: eligibility.ok, reason: (eligibility as Row).reason }, { ok: false, reason: "not_failed" });
});

test("HIGH-1: a genuine provider failure on the winning send still fails the execution (sms_send_failed) - unchanged", async () => {
  const { execution, event } = seed();
  providerOk = false;
  const first = callback();
  const second = callback();
  const loser = await Promise.race([first, second]);
  assert.deepEqual(await loser.clone().json(), { ok: true, alreadyProcessed: true });
  assert.equal(execution.status, "running");
  releaseProvider();
  await Promise.all([first, second]);
  assert.equal(execution.status, "failed", "the owner records its own genuine failure");
  assert.equal(execution.error_message, "Twilio error 30003");
  assert.equal(event.status, "failed");
  assert.deepEqual(calls.signals, ["sms_send_failed"], "exactly one failure incident - from the owner");
  assert.deepEqual(outbound().map((m) => m.status), ["failed"]);
  assert.equal(calls.provider, 1);
});

test("HIGH-1: a single callback's genuine send failure is unchanged", async () => {
  const { execution } = seed();
  providerOk = false;
  gateArrivals = 1; // a lone callback - open the barrier on arrival
  releaseProvider();
  const response = await callback();
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(execution.status, "failed");
  assert.deepEqual(calls.signals, ["sms_send_failed"]);
});

test("sendOutboundMessage: duplicateInProgress only for an index loss against an unsent owner row; a sent owner row is reported as the send; other errors carry no flag", async () => {
  seed();
  releaseProvider();
  store.messages!.push({ id: "owner", organization_id: ORG, conversation_id: CONV, direction: "outbound", status: "queued", workflow_execution_id: EXEC });
  const input = { organizationId: ORG, contactId: CONTACT, conversationId: CONV, channel: "sms" as const, body: "x", senderType: "ai" as const, workflowExecutionId: EXEC };
  const loser = await sendOutboundMessage(service as never, input);
  assert.deepEqual({ ok: loser.ok, flag: (loser as Row).duplicateInProgress, messageId: loser.messageId }, { ok: false, flag: true, messageId: "owner" });
  store.messages![0].status = "failed";
  assert.equal(((await sendOutboundMessage(service as never, input)) as Row).duplicateInProgress, true, "the owner (not this request) records its own failure");
  store.messages![0].status = "sent";
  store.messages![0].provider_message_id = "SM-owner";
  assert.deepEqual(await sendOutboundMessage(service as never, input), { ok: true, messageId: "owner", conversationId: CONV, providerMessageId: "SM-owner" });
  // An opted-out recipient and a provider failure are genuine failures - never flagged.
  store.messages = [];
  providerOk = false;
  const failed = await sendOutboundMessage(service as never, input);
  assert.deepEqual({ ok: failed.ok, flag: (failed as Row).duplicateInProgress }, { ok: false, flag: undefined });
  store.messages = [];
  store.contacts![0].sms_opt_out = true;
  const optedOut = await sendOutboundMessage(service as never, input);
  assert.deepEqual({ ok: optedOut.ok, flag: (optedOut as Row).duplicateInProgress }, { ok: false, flag: undefined });
  assert.equal(calls.provider, 1, "the provider is never called for a duplicate or an opted-out recipient");
});
