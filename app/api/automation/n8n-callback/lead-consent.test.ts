/**
 * Final Batch 2: a lead captured by the public form without affirmative SMS
 * consent never receives an automated text - proven end to end through the
 * REAL n8n callback route, the REAL outbound gate (unmocked) and the REAL
 * sendOutboundMessage, with only the SMS provider mocked. Harness shape from
 * provider-opt-out.test.ts. Nothing reaches TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/api/automation/n8n-callback/lead-consent.test.ts
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
/** Final Batch 2: leads.sms_consent of the seeded lead, as the public lead-capture route writes it (undefined = not a form lead). */
let leadConsent: string | undefined = undefined;
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
mock.module(lib("lib/settings/queries.ts"), { namedExports: { ...realSettings, getAiSettings: async () => ({ ai_enabled: true }), getBusinessHours: async () => [], getOrganizationTimezone: async () => "UTC" } });
mock.module(lib("lib/scheduling/booking.ts"), {
  namedExports: { getAvailableBookingSlots: async () => ({ status: "available", slots: [] }), bookAppointment: async () => ({ success: false }), rescheduleAppointment: async () => ({ success: false }) },
});
mock.module(lib("lib/automation/booking-context.ts"), { namedExports: { getRecentBookingContext: async () => null } });
mock.module(lib("lib/automation/appointments.ts"), { namedExports: { cancelAppointmentAsService: async () => ({ ok: false, reason: "not_found" }) } });
mock.module(lib("lib/reviews-referrals/tracking.ts"), { namedExports: { recordPostJobFollowupOutcome: async () => undefined } });

process.env.N8N_WEBHOOK_SECRET = SECRET;
const { POST } = await import(lib("app/api/automation/n8n-callback/route.ts"));
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
    organizations: [{ id: ORG, automation_paused: false, automation_mode: "live", payment_status: "active" }],
    leads: [{ id: LEAD, organization_id: ORG, contact_id: CONTACT, status: "new", source: "website", sms_consent: leadConsent }],
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
  leadConsent = undefined;
});

const outbound = () => store.messages!.filter((m) => m.direction === "outbound");

for (const state of ["not_provided", "declined"]) {
  test(`instant follow-up for a form lead with sms_consent '${state}': blocked by the real gate (lead_sms_consent_missing) - the provider is never called`, async () => {
    leadConsent = state;
    const { execution } = seed();
    const response = await callback();
    assert.deepEqual(await response.json(), { ok: true, sent: false, blockedReason: "lead_sms_consent_missing" });
    assert.equal(calls.provider, 0);
    assert.deepEqual(outbound(), [], "nothing reaches the sender - not even a failed message row");
    assert.equal(execution.status, "completed", "a business block, never a failed (retryable) execution");
    assert.equal((execution.metadata as Row).blocked_reason, "lead_sms_consent_missing");
    assert.equal(store.contacts![0].sms_opt_out, false, "no STOP is manufactured");
    const eligibility = await checkRetryEligibility(service as never, ORG, EXEC);
    assert.equal(eligibility.ok, false);
  });
}

test("instant follow-up for a form lead with affirmative consent ('granted'): sent through the canonical path", async () => {
  leadConsent = "granted";
  const { execution } = seed();
  assert.deepEqual(await (await callback()).json(), { ok: true });
  assert.equal(calls.provider, 1);
  assert.deepEqual(outbound().map((m) => m.status), ["sent"]);
  assert.equal(execution.status, "completed");
});

test("a lead that is not a form lead (sms_consent null) is unchanged: sent", async () => {
  const { execution } = seed();
  assert.deepEqual(await (await callback()).json(), { ok: true });
  assert.equal(calls.provider, 1);
  assert.equal(execution.status, "completed");
});

test("an AI reply to the same contact's thread (customer.message.received, lead carried in the payload) is blocked too", async () => {
  leadConsent = "not_provided";
  const { event } = seed();
  Object.assign(event, { event_type: "customer.message.received", entity_type: "conversation", entity_id: CONV, payload: { lead_id: LEAD, contact_id: CONTACT, conversation_id: CONV } });
  store.workflow_executions![0].workflow_name = "customer_reply_followup";
  store.automation_settings!.push({ organization_id: ORG, automation_id: "inbound-customer-reply", enabled: true, config: null });
  const json = await (await callback()).json();
  assert.equal(json.sent, false);
  assert.equal(json.blockedReason, "lead_sms_consent_missing");
  assert.equal(calls.provider, 0);
});
