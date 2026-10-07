/**
 * Final Batch 2: Twilio 21610 ("attempt to send to unsubscribed recipient")
 * is a recipient opt-out, not a transient send failure.
 *
 * Runs the REAL n8n callback route (legacy ai_result send), the REAL
 * sendOutboundMessage, the REAL opt-out writer and the REAL A2 retry
 * classifier against an in-memory store (harness shape from
 * duplicate-callback.test.ts). The gate is mocked to allow unless the
 * contact's persisted sms_opt_out is set; the provider is mocked to answer
 * 21610 / 30003 / success. Nothing reaches TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/api/automation/n8n-callback/provider-opt-out.test.ts
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

/** What the provider answers next: a send, Twilio 21610 (unsubscribed recipient), or another rejection. */
let providerMode: "ok" | "21610" | "30003" = "ok";
/** Fault injection: the next N contacts updates fail. */
let failContactUpdates = 0;

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
  is(column: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
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
    if (this.updateValues && this.table === "contacts" && failContactUpdates > 0) {
      failContactUpdates -= 1;
      return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
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
    // Allows, except for the contact's persisted opt-out - the one gate check this file exercises (the real gate's
    // own contact_opted_out check is covered in lib/leads/intake.test.ts and the gate suites).
    evaluateOutboundGate: async (_s: unknown, input: { contactId: string; conversationId: string; aiResult: { response_message: string } }) => {
      calls.gate += 1;
      const contact = store.contacts!.find((row) => row.id === input.contactId);
      if (contact?.sms_opt_out) return { allowed: false, reason: "contact_opted_out" };
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
      if (providerMode === "21610") return { ok: false, error: "The SMS provider rejected the request.", providerErrorCode: "21610" };
      if (providerMode === "30003") return { ok: false, error: "The SMS provider rejected the request.", providerErrorCode: "30003" };
      return { ok: true, providerMessageId: `SM-${calls.provider}` };
    },
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
const { POST } = await import(lib("app/api/automation/n8n-callback/route.ts"));
const { sendOutboundMessage } = await import(lib("lib/messaging/outbound.ts"));
const { checkRetryEligibility } = await import(lib("lib/automation/retry-eligibility.ts"));
const { classifyFailedExecutions } = await import(lib("lib/automation/execution-retry.ts"));

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
  providerMode = "ok";
  failContactUpdates = 0;
});

const outbound = () => store.messages!.filter((m) => m.direction === "outbound");
const contact = () => store.contacts![0];

test("21610 maps to a persisted opt-out and a blocked (not failed) execution", async () => {
  const { execution, event } = seed();
  providerMode = "21610";
  const response = await callback();
  assert.deepEqual(await response.json(), { ok: true, sent: false, blockedReason: "contact_opted_out" });
  assert.equal(contact().sms_opt_out, true, "the opt-out is persisted on the contact");
  assert.deepEqual(outbound().map((m) => ({ status: m.status, code: m.provider_error_code })), [{ status: "failed", code: "21610" }]);
  assert.equal(execution.status, "completed", "a business block - never a failed execution");
  assert.equal((execution.metadata as Row).should_send, false);
  assert.equal((execution.metadata as Row).blocked_reason, "contact_opted_out");
  assert.equal((execution.metadata as Row).blocked_detail, "provider_opt_out");
  assert.equal(event.status, "completed");
  assert.deepEqual(calls.signals, [], "no sms_send_failed incident");
  assert.equal(calls.provider, 1);
});

test("21610: no retry loop - nothing is retryable and the provider is called exactly once", async () => {
  seed();
  providerMode = "21610";
  await callback();
  const classified = await classifyFailedExecutions(service as never, new Date(Date.now() + 60 * 60_000));
  assert.deepEqual(classified.decided, [], "no failed execution exists to schedule a retry for");
  assert.equal(classified.errors, 0);
  const eligibility = await checkRetryEligibility(service as never, ORG, EXEC);
  assert.deepEqual({ ok: eligibility.ok, reason: (eligibility as Row).reason }, { ok: false, reason: "not_failed" });
  assert.equal(calls.provider, 1);
});

test("21610: every subsequent automated send to the contact is blocked before the provider", async () => {
  seed();
  providerMode = "21610";
  await callback();
  providerMode = "ok";
  // A later automation run for the same contact: the gate refuses it...
  const laterExec = "77777777-7777-4777-8777-777777777777";
  const laterEvent = "88888888-8888-4888-8888-888888888888";
  store.automation_events!.push({ id: laterEvent, organization_id: ORG, event_type: "lead.created", entity_type: "lead", entity_id: LEAD, payload: { lead_id: LEAD, contact_id: CONTACT, conversation_id: CONV }, status: "processing", created_at: minutesAgo(0) });
  store.workflow_executions!.push({ id: laterExec, organization_id: ORG, automation_event_id: laterEvent, workflow_name: "lead_created_followup", status: "running", attempt: 1, started_at: minutesAgo(0), metadata: {}, trigger_source: "event", automation_events: store.automation_events!.at(-1) });
  const later = await POST(
    new Request("https://preview.example/api/automation/n8n-callback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trackpr-webhook-secret": SECRET },
      body: JSON.stringify({ execution_id: laterExec, event_id: laterEvent, organization_id: ORG, ai_result: DRAFT }),
    }) as never,
  );
  assert.deepEqual(await later.json(), { ok: true, sent: false, blockedReason: "contact_opted_out" });
  // ...and the sender itself refuses too (defense in depth), never calling the provider.
  const direct = await sendOutboundMessage(service as never, { organizationId: ORG, contactId: CONTACT, conversationId: CONV, channel: "sms", body: "x", senderType: "ai" });
  assert.equal(direct.ok, false);
  assert.equal(calls.provider, 1, "only the original 21610 attempt reached the provider");
});

test("21610: idempotent - a redelivered callback and a second 21610 for the same contact leave one opt-out and no error", async () => {
  const { execution } = seed();
  providerMode = "21610";
  await callback();
  const again = await callback();
  assert.deepEqual(await again.json(), { ok: true, alreadyProcessed: true });
  assert.equal(execution.status, "completed");
  assert.equal(calls.provider, 1, "the redelivery never reaches the provider");
  // Two concurrent sends that both meet 21610 (the contact not yet marked when each started):
  contact().sms_opt_out = false;
  const input = { organizationId: ORG, contactId: CONTACT, conversationId: CONV, channel: "sms" as const, body: "x", senderType: "user" as const };
  const results = await Promise.all([sendOutboundMessage(service as never, input), sendOutboundMessage(service as never, input)]);
  for (const result of results) {
    assert.deepEqual({ ok: result.ok, optedOut: (result as Row).recipientOptedOut, persisted: (result as Row).optOutPersisted }, { ok: false, optedOut: true, persisted: true });
  }
  assert.equal(contact().sms_opt_out, true);
  assert.equal(store.contacts!.length, 1);
});

test("a non-21610 provider failure is unchanged: failed execution, sms_send_failed, no opt-out", async () => {
  const { execution } = seed();
  providerMode = "30003";
  const response = await callback();
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(execution.status, "failed");
  assert.deepEqual(calls.signals, ["sms_send_failed"]);
  assert.equal(contact().sms_opt_out, false, "only 21610 is an opt-out");
  // Control for the no-retry-loop test: in this same harness a genuine failure IS classified for retry.
  const classified = await classifyFailedExecutions(service as never, new Date(Date.now() + 60 * 60_000));
  assert.deepEqual(classified.decided.map((d: { id: string }) => d.id), [EXEC]);
  const result = await sendOutboundMessage(service as never, { organizationId: ORG, contactId: CONTACT, conversationId: CONV, channel: "sms", body: "x", senderType: "user" });
  assert.equal((result as Row).recipientOptedOut, undefined);
});

test("21610 with an opt-out write that fails twice: still a block (never a retryable failure), and reported as not persisted", async () => {
  const { execution } = seed();
  providerMode = "21610";
  failContactUpdates = 2;
  const response = await callback();
  assert.deepEqual(await response.json(), { ok: true, sent: false, blockedReason: "contact_opted_out" });
  assert.equal(execution.status, "completed");
  assert.equal(contact().sms_opt_out, false, "the write failed (and was retried once)");
  // The sender reports it, so a caller can tell; a later attempt meets 21610 again and is blocked again - never a loop.
  failContactUpdates = 2;
  const result = await sendOutboundMessage(service as never, { organizationId: ORG, contactId: CONTACT, conversationId: CONV, channel: "sms", body: "x", senderType: "user" });
  assert.deepEqual({ optedOut: (result as Row).recipientOptedOut, persisted: (result as Row).optOutPersisted }, { optedOut: true, persisted: false });
});

test("21610 handling never logs the destination number or message body", async () => {
  seed();
  providerMode = "21610";
  failContactUpdates = 2;
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(JSON.stringify(args));
  try {
    await callback();
  } finally {
    console.error = original;
  }
  assert.ok(logged.length > 0, "the failed opt-out write is logged");
  for (const line of logged) {
    assert.ok(!line.includes("+15550142301") && !line.includes("5550142301"), "no phone number");
    assert.ok(!line.includes(DRAFT.response_message), "no message body");
  }
});
