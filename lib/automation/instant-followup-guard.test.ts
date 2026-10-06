/**
 * P0-B B0: the final staleness re-check for an Instant Lead Follow-Up
 * (lead.created) draft. Runs the REAL guard (lib/automation/instant-
 * followup-guard.ts) and the REAL n8n callback route against an in-memory
 * store; the outbound gate is stubbed to ALLOW so the guard is the only
 * thing between the draft and the customer. n8n, incident recording,
 * business settings and the SMS provider are mocked and counted. Nothing
 * reaches TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/instant-followup-guard.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const SECRET = "test-webhook-secret";

let store: Record<string, Row[]> = {};
let ids = 0;
const calls = { n8n: 0, signals: [] as Row[], sends: 0, gate: 0, founder: 0 };
const NOW = new Date("2026-10-30T12:00:00.000Z");
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

function deriveOutcome(row: Row) {
  const metadata = (row.metadata ?? {}) as Row;
  row.outcome = row.status === "running" ? null : row.status === "completed" ? (metadata.blocked_reason ? "blocked" : "succeeded") : row.status === "failed" ? "failed" : null;
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private upsertRow: Row | null = null;
  private insertRows: Row[] | null = null;
  private sortBy: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private window: [number, number] | null = null;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, op: string, v: unknown) { this.filters.push((r) => (op === "is" ? (r[c] ?? null) !== v : true)); return this; }
  gt(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) > v); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.sortBy = { column: c, ascending: o?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  range(from: number, to: number) { this.window = [from, to]; return this; }
  update(v: Row) { this.updateValues = v; return this; }
  upsert(v: Row) { this.upsertRow = v; return this; }
  insert(v: Row | Row[]) { this.insertRows = Array.isArray(v) ? v : [v]; return this; }
  single() { return this.run(true); }
  maybeSingle() { return this.run(true); }
  then<T>(resolve: (v: { data: unknown; error: unknown }) => T, reject?: (e: unknown) => T) { return this.run(false).then(resolve, reject); }
  private async run(single: boolean): Promise<{ data: unknown; error: unknown }> {
    const rows = (store[this.table] ??= []);
    if (this.upsertRow) {
      rows.push({ ...this.upsertRow });
      return { data: null, error: null };
    }
    if (this.insertRows) {
      const inserted = this.insertRows.map((r) => ({ id: uuid(), status: "open", ai_enabled: true, ...r }));
      rows.push(...inserted);
      return { data: single ? inserted[0] : inserted, error: null };
    }
    let matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.updateValues) for (const r of matched) Object.assign(r, this.updateValues);
    if (this.sortBy) {
      const { column, ascending } = this.sortBy;
      matched = [...matched].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (ascending ? 1 : -1));
    }
    if (this.window) matched = matched.slice(this.window[0], this.window[1] + 1);
    if (this.max !== null) matched = matched.slice(0, this.max);
    return { data: single ? (matched[0] ?? null) : matched, error: null };
  }
}

function rpc(name: string, args: Row) {
  const run = async () => {
    const executions = (store.workflow_executions ??= []);
    if (name === "start_workflow_execution") {
      const event = store.automation_events!.find((e) => e.id === args.p_automation_event_id)!;
      const row: Row = { id: uuid(), organization_id: event.organization_id, automation_event_id: event.id, workflow_name: args.p_workflow_name, status: "running", attempt: 1, metadata: {}, started_at: NOW.toISOString() };
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
      Object.assign(execution, { status: "completed", metadata: args.p_metadata ?? {} });
      if (event) event.status = "completed";
    } else {
      Object.assign(execution, { status: "failed", error_message: args.p_error_message });
      if (event) event.status = "failed";
    }
    deriveOutcome(execution);
    return { data: { ...execution }, error: null };
  };
  return { single: run, then: <T>(resolve: (v: unknown) => T) => run().then(resolve) };
}

const db = { from: (t: string) => new Query(t), rpc };

const createEvent = async (_s: unknown, organizationId: string, input: Row) => {
  const events = (store.automation_events ??= []);
  const existing = events.find((e) => e.idempotency_key === input.idempotencyKey);
  if (existing) return { ok: true, duplicate: true, skipped: false, event: existing };
  const event = { id: uuid(), organization_id: organizationId, event_type: input.eventType, entity_type: input.entityType, entity_id: input.entityId, payload: input.payload, idempotency_key: input.idempotencyKey, status: "pending", created_at: NOW.toISOString() };
  events.push(event);
  return { ok: true, duplicate: false, skipped: false, event };
};

const realNextServer = await import("next/server");
mock.module("next/server", { namedExports: { ...realNextServer, after: (fn: () => unknown) => void fn() } });
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => db } });
mock.module(lib("lib/automation/events.ts"), { namedExports: { createAutomationEvent: createEvent, createAutomationEventAsService: createEvent } });
mock.module(lib("lib/automation/n8n.ts"), {
  namedExports: {
    triggerN8nWorkflow: async () => {
      calls.n8n += 1;
      return { ok: true };
    },
  },
});
mock.module(lib("lib/automation-health/service.ts"), {
  namedExports: {
    recordAutomationHealthSignal: async (_s: unknown, input: Row) => {
      calls.signals.push(input);
      return { occurrenceCount: 1 };
    },
    resolveAutomationFailureIncidents: async () => undefined,
  },
});
mock.module(lib("lib/settings/queries.ts"), {
  namedExports: {
    getAiSettings: async () => ({ ai_enabled: true, tone: null, business_introduction: null, general_instructions: null }),
    getBusinessProfile: async () => ({ name: "QA Fixture Roofing", timezone: "UTC" }),
    getBusinessHours: async () => [],
    getOrganizationTimezone: async () => "UTC",
  },
});
mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async () => {
      calls.sends += 1;
      return { ok: true, messageId: "m", conversationId: "c", providerMessageId: "SM" };
    },
  },
});
const realGate = await import(lib("lib/automation/outbound-gate.ts"));
mock.module(lib("lib/automation/outbound-gate.ts"), {
  namedExports: {
    ...realGate,
    // The gate itself is covered by its own suites; here it allows the send,
    // so the only thing between the draft and the customer is the B0 guard.
    evaluateOutboundGate: async (_s: unknown, input: Row) => {
      calls.gate += 1;
      return { allowed: true, contactId: input.contactId, conversationId: input.conversationId, body: (input.aiResult as Row).response_message };
    },
  },
});
mock.module(lib("lib/notifications/founder.ts"), {
  namedExports: {
    notifyFounder: async () => {
      calls.founder += 1;
    },
  },
});

mock.module(lib("lib/scheduling/booking.ts"), {
  namedExports: { getAvailableBookingSlots: async () => ({ status: "available", slots: [] }), bookAppointment: async () => ({ success: false }), rescheduleAppointment: async () => ({ success: false }) },
});
mock.module(lib("lib/automation/booking-context.ts"), { namedExports: { getRecentBookingContext: async () => null } });
mock.module(lib("lib/automation/appointments.ts"), { namedExports: { cancelAppointmentAsService: async () => ({ ok: false, reason: "not_found" }) } });
mock.module(lib("lib/reviews-referrals/tracking.ts"), { namedExports: { recordPostJobFollowupOutcome: async () => undefined } });


process.env.N8N_WEBHOOK_SECRET = SECRET;
const { evaluateInstantFollowup, checkInstantFollowupStillCurrent, INSTANT_FOLLOWUP_MAX_DRAFT_AGE_HOURS } = await import(lib("lib/automation/instant-followup-guard.ts"));
const { POST } = await import(lib("app/api/automation/n8n-callback/route.ts"));

beforeEach(() => {
  store = {
    organizations: [{ id: ORG, automation_mode: "live", payment_status: "active", automation_paused: false }],
    contacts: [{ id: CONTACT, organization_id: ORG, first_name: "Riley", last_name: "B0", phone: "+15550142301", email: null, sms_opt_out: false }],
    leads: [],
    conversations: [],
    messages: [],
    appointments: [],
    estimates: [],
    jobs: [],
    automation_events: [],
    automation_settings: [],
    workflow_executions: [],
    ai_interactions: [],
    ai_settings: [],
  };
  ids = 0;
  calls.n8n = 0;
  calls.signals = [];
  calls.sends = 0;
  calls.gate = 0;
  calls.founder = 0;
});

const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

/** A lead that arrived `arrivedHoursAgo` ago, its open SMS thread, and a dispatched lead.created execution awaiting n8n. */
function arrivedLead(arrivedHoursAgo: number, status = "new") {
  const arrived = hoursAgo(arrivedHoursAgo);
  const lead = { id: uuid(), organization_id: ORG, contact_id: CONTACT, status, source: "website", service: "Roofing", temperature: "warm", created_at: arrived };
  store.leads!.push(lead);
  const conversation = { id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: lead.id, channel: "sms", status: "open", ai_enabled: true };
  store.conversations!.push(conversation);
  const event = { id: uuid(), organization_id: ORG, event_type: "lead.created", entity_type: "lead", entity_id: lead.id, payload: { lead_id: lead.id, contact_id: CONTACT, conversation_id: conversation.id }, status: "processing", created_at: arrived };
  store.automation_events!.push(event);
  const execution: Row = { id: uuid(), organization_id: ORG, automation_event_id: event.id, workflow_name: "lead_created_followup", status: "running", attempt: 1, metadata: {}, automation_events: event };
  store.workflow_executions!.push(execution);
  return { lead, conversation, event, execution, arrived };
}
const callback = (execution: Row, event: Row) =>
  POST(
    new Request("https://preview.example/api/automation/n8n-callback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trackpr-webhook-secret": SECRET },
      body: JSON.stringify({ execution_id: execution.id, event_id: event.id, organization_id: ORG, ai_result: AI }),
    }) as never,
  ) as Promise<Response>;
const AI = { should_send: true, response_message: "Hi Riley, thanks for reaching out about your roof - when is a good time to talk?", qualification_status: "qualifying", missing_information: [], urgency: "normal", needs_human: false, model: "claude-sonnet-5", intent: null, summary: "new roofing lead" };
const later = (arrived: string, minutes: number) => new Date(new Date(arrived).getTime() + minutes * 60 * 1000).toISOString();
const facts = (over: Row = {}) => ({ leadStatus: "new", draftCreatedAt: hoursAgo(0.1), advancedSince: null, customerRepliedSince: false, staffMessagedSince: false, ...over }) as never;

// ---------------------------------------------------------------- pure rule

test("rule: a fresh draft for a new/contacted/qualified lead with nothing since -> eligible", () => {
  for (const leadStatus of ["new", "contacted", "qualified"]) assert.deepEqual(evaluateInstantFollowup(facts({ leadStatus }), new Date()), { eligible: true });
});

test("rule: lead gone / lead moved to appointment, estimate, won or lost -> blocked", () => {
  assert.equal(evaluateInstantFollowup(facts({ leadStatus: null }), new Date()).reason, "lead_not_found");
  for (const leadStatus of ["appointment", "estimate", "won", "lost"]) assert.equal(evaluateInstantFollowup(facts({ leadStatus }), new Date()).reason, "lead_status_ineligible", leadStatus);
});

test("rule: max draft age - exactly the limit still sends, past it is draft_expired", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const at = (h: number) => new Date(now.getTime() - h * HOUR).toISOString();
  assert.equal(INSTANT_FOLLOWUP_MAX_DRAFT_AGE_HOURS, 6);
  assert.deepEqual(evaluateInstantFollowup(facts({ draftCreatedAt: at(6) }), now), { eligible: true });
  assert.equal(evaluateInstantFollowup(facts({ draftCreatedAt: at(6.01) }), now).reason, "draft_expired");
  assert.equal(evaluateInstantFollowup(facts({ draftCreatedAt: at(72) }), now).reason, "draft_expired");
});

test("rule: advanced / customer replied / staff messaged since the lead arrived -> blocked", () => {
  assert.equal(evaluateInstantFollowup(facts({ advancedSince: "appointment" }), new Date()).reason, "lead_advanced");
  assert.equal(evaluateInstantFollowup(facts({ advancedSince: "job" }), new Date()).detail, "a job was created after the lead arrived");
  assert.equal(evaluateInstantFollowup(facts({ customerRepliedSince: true }), new Date()).reason, "customer_replied");
  assert.equal(evaluateInstantFollowup(facts({ staffMessagedSince: true }), new Date()).reason, "staff_replied");
});

// ------------------------------------------------- live facts (anchored on the lead.created event)

test("facts: history from BEFORE the lead arrived never blocks a returning customer's first reply", async () => {
  const { lead, conversation, arrived } = arrivedLead(0.5);
  store.jobs!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, status: "completed", created_at: hoursAgo(24 * 200) });
  store.appointments!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, status: "completed", created_at: hoursAgo(24 * 210) });
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: conversation.id, direction: "inbound", sender_type: "customer", created_at: hoursAgo(24 * 200) });
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: conversation.id, direction: "outbound", sender_type: "user", created_at: hoursAgo(24 * 199) });
  assert.deepEqual(await checkInstantFollowupStillCurrent(db as never, { organizationId: ORG, leadId: lead.id, contactId: CONTACT, draftCreatedAt: arrived }), { eligible: true });
});

test("facts: an appointment / estimate / job created after the lead arrived (on ANY lead of the customer) -> lead_advanced", async () => {
  for (const table of ["appointments", "estimates", "jobs"] as const) {
    store[table] = [];
    const { lead, arrived } = arrivedLead(1);
    store[table]!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: null, status: "scheduled", created_at: later(arrived, 20) });
    const decision = await checkInstantFollowupStillCurrent(db as never, { organizationId: ORG, leadId: lead.id, contactId: CONTACT, draftCreatedAt: arrived });
    assert.equal(decision.reason, "lead_advanced", table);
    store[table] = [];
  }
});

test("facts: a customer text or a staff message after the lead arrived -> blocked; an earlier AI message does not count as staff", async () => {
  const replied = arrivedLead(1);
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: replied.conversation.id, direction: "inbound", sender_type: "customer", created_at: later(replied.arrived, 5) });
  assert.equal((await checkInstantFollowupStillCurrent(db as never, { organizationId: ORG, leadId: replied.lead.id, contactId: CONTACT, draftCreatedAt: replied.arrived })).reason, "customer_replied");

  store.messages = [];
  const staff = arrivedLead(1);
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: staff.conversation.id, direction: "outbound", sender_type: "ai", created_at: later(staff.arrived, 5) });
  assert.deepEqual(await checkInstantFollowupStillCurrent(db as never, { organizationId: ORG, leadId: staff.lead.id, contactId: CONTACT, draftCreatedAt: staff.arrived }), { eligible: true });
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: staff.conversation.id, direction: "outbound", sender_type: "user", created_at: later(staff.arrived, 7) });
  assert.equal((await checkInstantFollowupStillCurrent(db as never, { organizationId: ORG, leadId: staff.lead.id, contactId: CONTACT, draftCreatedAt: staff.arrived })).reason, "staff_replied");
});

test("facts: another organization's records never count", async () => {
  const { lead, arrived } = arrivedLead(1);
  store.jobs!.push({ id: uuid(), organization_id: "99999999-9999-4999-8999-999999999999", contact_id: CONTACT, status: "scheduled", created_at: later(arrived, 5) });
  assert.deepEqual(await checkInstantFollowupStillCurrent(db as never, { organizationId: ORG, leadId: lead.id, contactId: CONTACT, draftCreatedAt: arrived }), { eligible: true });
});

// ------------------------------------------------- the REAL callback route

test("callback: a fresh, current draft is still sent (unchanged behaviour)", async () => {
  const { event, execution } = arrivedLead(0.2);
  const json = await (await callback(execution, event)).json();
  assert.equal(calls.gate, 1);
  assert.equal(calls.sends, 1, "the guard lets a current draft through");
  assert.equal(json.ok, true);
  assert.notEqual(json.sent, false);
});

for (const [label, setup, reason] of [
  ["the lead was marked lost", (x: ReturnType<typeof arrivedLead>) => { x.lead.status = "lost"; }, "lead_status_ineligible"],
  ["an appointment was booked", (x: ReturnType<typeof arrivedLead>) => { store.appointments!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: x.lead.id, status: "scheduled", created_at: later(x.arrived, 10) }); }, "lead_advanced"],
  ["the customer already texted back", (x: ReturnType<typeof arrivedLead>) => { store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: x.conversation.id, direction: "inbound", sender_type: "customer", created_at: later(x.arrived, 3) }); }, "customer_replied"],
  ["staff already replied", (x: ReturnType<typeof arrivedLead>) => { store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: x.conversation.id, direction: "outbound", sender_type: "user", created_at: later(x.arrived, 3) }); }, "staff_replied"],
] as const) {
  test(`callback: a stale draft after ${label} -> blocked (${reason}), recorded as blocked, nothing sent`, async () => {
    const x = arrivedLead(1);
    setup(x);
    const json = await (await callback(x.execution, x.event)).json();
    assert.deepEqual(json, { ok: true, sent: false, blockedReason: reason });
    assert.equal(calls.sends, 0);
    assert.equal(x.execution.status, "completed");
    assert.equal(x.execution.outcome, "blocked", "a business block - never a failure, never retried");
    assert.equal((x.execution.metadata as Row).blocked_reason, reason);
    assert.equal(calls.signals.length, 0, "no incident");
  });
}

test("callback: a draft that lands (e.g. via a late retry) more than the max age after the lead arrived -> draft_expired, nothing sent", async () => {
  const { event, execution } = arrivedLead(INSTANT_FOLLOWUP_MAX_DRAFT_AGE_HOURS + 1);
  const json = await (await callback(execution, event)).json();
  assert.deepEqual(json, { ok: true, sent: false, blockedReason: "draft_expired" });
  assert.equal(calls.sends, 0);
  assert.equal(execution.outcome, "blocked");
});

test("callback: the guard only applies to lead.created - other event types are untouched", async () => {
  const x = arrivedLead(INSTANT_FOLLOWUP_MAX_DRAFT_AGE_HOURS + 10);
  x.event.event_type = "customer.message.received";
  x.event.entity_type = "conversation";
  x.event.entity_id = x.conversation.id;
  await callback(x.execution, x.event);
  assert.equal(calls.sends, 1, "an old customer-reply draft is not affected by the instant follow-up guard");
});
