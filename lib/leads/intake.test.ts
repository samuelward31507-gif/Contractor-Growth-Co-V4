/**
 * P0 A1: lead attribution for automated intake - one customer, one SMS
 * thread, possibly many opportunities over time.
 *
 * Runs the REAL intake helper (lib/leads/intake.ts), the REAL contact
 * resolver and conversation helper, the REAL outbound gate, and the REAL
 * entry points: the web-form capture route, the inbound SMS webhook route
 * (+ processInboundCustomerMessage), the missed-call handler and the
 * referral -> lead action - all against an in-memory table store that
 * enforces the two uniqueness rules these paths rely on (one open SMS
 * conversation per contact; messages.provider_message_id). Automation
 * events/executions are in-memory with real idempotency-key semantics; the
 * n8n-bound emitters, Twilio, cost capture and founder notifications are
 * mocked and only counted. Nothing reaches TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/leads/intake.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "org-1";
const ORG_NUMBER = "+15550001111";
const TOKEN = "intake-token-0123456789";

let store: Record<string, Row[]> = {};
let ids = 0;
let clock = Date.UTC(2026, 9, 5, 12, 0, 0);
const iso = () => new Date(clock).toISOString();
const advanceMinutes = (minutes: number) => {
  clock += minutes * 60_000;
  mock.timers.setTime(clock);
};
const calls = {
  leadCreated: [] as Row[],
  stageChanged: [] as Row[],
  customerReply: [] as Row[],
  sends: 0,
  founder: 0,
};

class Query {
  private filters: ((row: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private insertRows: Row[] | null = null;
  private sortBy: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private head = false;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select(_columns?: string, options?: { head?: boolean }) { this.head = !!options?.head; return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  is(column: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  gte(column: string, value: string) { this.filters.push((row) => String(row[column]) >= value); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.sortBy = { column, ascending: options?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  update(values: Row) { this.updateValues = values; return this; }
  insert(values: Row | Row[]) { this.insertRows = Array.isArray(values) ? values : [values]; return this; }
  single() { return this.run(true); }
  maybeSingle() { return this.run(true); }
  then<T>(resolve: (value: { data: unknown; error: unknown; count?: number }) => T, reject?: (reason: unknown) => T) { return this.run(false).then(resolve, reject); }
  private async run(single: boolean): Promise<{ data: unknown; error: unknown; count?: number }> {
    const rows = (store[this.table] ??= []);
    if (this.insertRows) {
      const inserted: Row[] = [];
      for (const raw of this.insertRows) {
        const row: Row = { id: `${this.table}-${++ids}`, created_at: iso(), updated_at: iso(), ...raw };
        if (this.table === "conversations") {
          row.status ??= "open";
          row.ai_enabled ??= true;
          if (rows.some((r) => r.organization_id === row.organization_id && r.contact_id === row.contact_id && r.channel === row.channel && r.status === "open")) {
            return { data: null, error: { code: "23505", message: "duplicate open conversation" } };
          }
        }
        // Mirrors the A3 partial unique index leads_one_new_sms_intake_per_contact.
        if (
          this.table === "leads" &&
          row.source === "sms_inbound" &&
          (row.status ?? "new") === "new" &&
          row.contact_id &&
          rows.some((r) => r.organization_id === row.organization_id && r.contact_id === row.contact_id && r.source === "sms_inbound" && r.status === "new")
        ) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"leads_one_new_sms_intake_per_contact\"" } };
        }
        if (this.table === "messages" && row.provider_message_id && rows.some((r) => r.provider_message_id === row.provider_message_id)) {
          return { data: null, error: { code: "23505", message: "duplicate provider_message_id" } };
        }
        if (this.table === "contacts") {
          row.sms_opt_out ??= false;
          row.merged_into_id ??= null;
        }
        rows.push(row);
        inserted.push(row);
      }
      return { data: single ? inserted[0] : inserted, error: null };
    }
    let matched = rows.filter((row) => this.filters.every((f) => f(row)));
    if (this.updateValues) for (const row of matched) Object.assign(row, this.updateValues, { updated_at: iso() });
    if (this.sortBy) {
      const { column, ascending } = this.sortBy;
      matched = [...matched].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (ascending ? 1 : -1));
    }
    if (this.max !== null) matched = matched.slice(0, this.max);
    if (this.head) return { data: null, error: null, count: matched.length };
    return { data: single ? (matched[0] ?? null) : matched, error: null, count: matched.length };
  }
}
const db = { from: (table: string) => new Query(table), rpc: async () => ({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } };

// In-memory automation events/executions with the real idempotency-key contract.
const createEvent = async (_s: unknown, organizationId: string | Row, maybeInput?: Row) => {
  const input = (maybeInput ?? organizationId) as Row;
  const events = (store.automation_events ??= []);
  const existing = events.find((e) => e.idempotency_key === input.idempotencyKey);
  if (existing) return { ok: true, duplicate: true, skipped: false, event: existing };
  const event = { id: `evt-${++ids}`, organization_id: typeof organizationId === "string" ? organizationId : ORG, event_type: input.eventType, entity_type: input.entityType, entity_id: input.entityId, payload: input.payload, idempotency_key: input.idempotencyKey, status: "pending", created_at: iso() };
  events.push(event);
  return { ok: true, duplicate: false, skipped: false, event };
};
const startExecution = async (_s: unknown, eventId: string, workflowName: string) => {
  const execution = { id: `exec-${++ids}`, organization_id: ORG, automation_event_id: eventId, workflow_name: workflowName, status: "running", started_at: iso() };
  (store.workflow_executions ??= []).push(execution);
  return { ok: true, execution };
};
const completeExecution = async (_s: unknown, id: string, metadata?: Row) => {
  const execution = store.workflow_executions!.find((e) => e.id === id)!;
  Object.assign(execution, { status: "completed", metadata });
  return { ok: true, execution };
};
const failExecution = async (_s: unknown, id: string) => {
  Object.assign(store.workflow_executions!.find((e) => e.id === id)!, { status: "failed" });
  return { ok: true };
};

mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => db } });
mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => db } });
mock.module(lib("lib/automation/events.ts"), { namedExports: { createAutomationEvent: createEvent, createAutomationEventAsService: createEvent } });
mock.module(lib("lib/automation/executions.ts"), {
  namedExports: {
    startWorkflowExecution: startExecution,
    startWorkflowExecutionAsService: startExecution,
    completeWorkflowExecution: completeExecution,
    completeWorkflowExecutionAsService: completeExecution,
    failWorkflowExecution: failExecution,
    failWorkflowExecutionAsService: failExecution,
  },
});
const captureLeadCreated = async (_s: unknown, input: Row) => {
  calls.leadCreated.push(input);
};
mock.module(lib("lib/automation/lead-followup.ts"), { namedExports: { emitLeadCreatedFollowup: captureLeadCreated, emitLeadCreatedFollowupAsService: captureLeadCreated } });
const captureStage = async (_s: unknown, orgOrInput: unknown, maybeInput?: Row) => {
  calls.stageChanged.push((maybeInput ?? orgOrInput) as Row);
};
mock.module(lib("lib/automation/lead-stage-history.ts"), { namedExports: { emitLeadStageChanged: captureStage, emitLeadStageChangedAsService: captureStage } });
mock.module(lib("lib/automation/customer-reply.ts"), {
  namedExports: {
    emitCustomerReplyFollowup: async (_s: unknown, input: Row) => {
      calls.customerReply.push(input);
    },
  },
});
mock.module(lib("lib/automation/estimate-reply.ts"), { namedExports: { classifyAndProcessEstimateReply: async () => undefined } });
mock.module(lib("lib/automation/booking-reply.ts"), { namedExports: { classifyAndProcessBookingReply: async () => false, handleBareCancelAppointmentReply: async () => false } });
mock.module(lib("lib/reviews-referrals/tracking.ts"), { namedExports: { recordRequestResponses: async () => undefined, classifyAndEscalateReviewReply: async () => undefined } });
mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async () => {
      calls.sends += 1;
      return { ok: true, messageId: "m", conversationId: "c", providerMessageId: "SM" };
    },
  },
});
mock.module(lib("lib/messaging/twilio-signature.ts"), { namedExports: { isValidTwilioSignature: () => true } });
mock.module(lib("lib/costs/sms-cost-events.ts"), { namedExports: { recordSmsCostEventForMessage: async () => ({ outcome: "recorded" }) } });
mock.module(lib("lib/notifications/founder.ts"), {
  namedExports: {
    notifyFounder: async () => {
      calls.founder += 1;
    },
  },
});
mock.module(lib("lib/settings/queries.ts"), {
  namedExports: { getBusinessHours: async () => [], getOrganizationTimezone: async () => "UTC", getAiSettings: async () => ({ ai_enabled: true }), getBusinessProfile: async () => null },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("next/navigation", { namedExports: { redirect: () => { throw new Error("redirect"); } } });
mock.module(lib("lib/auth/organization.ts"), { namedExports: { getUserOrganization: async () => ({ organizationId: ORG }) } });
mock.module(lib("lib/jobs/queries.ts"), { namedExports: { getJob: async () => ({ id: "job-1", title: "Roof replacement" }) } });
mock.module(lib("lib/automation/jobs.ts"), { namedExports: { emitJobLifecycleEvent: async () => undefined, emitJobCreatedEvent: async () => undefined } });
mock.module(lib("lib/automation/post-job-followup.ts"), { namedExports: { emitPostJobFollowup: async () => undefined } });

process.env.TWILIO_AUTH_TOKEN = "test-only-not-a-real-token";
const { resolveLeadForIntake } = await import(lib("lib/leads/intake.ts"));
const { evaluateOutboundGate } = await import(lib("lib/automation/outbound-gate.ts"));
const { POST: captureLead } = await import(lib("app/api/leads/capture/[token]/route.ts"));
const { POST: inboundSms } = await import(lib("app/api/webhooks/sms/inbound/route.ts"));
const { handleMissedCall } = await import(lib("app/api/webhooks/voice/inbound/route.ts"));
const { createLeadFromReferralForOrganization } = await import(lib("app/(app)/jobs/actions.ts"));

const PHONE = "+15557770001";

beforeEach(() => {
  store = {
    organizations: [{ id: ORG, name: "QA Fixture Roofing", phone: null, email: null, lead_intake_token: TOKEN, sms_phone_number: ORG_NUMBER, automation_mode: "live", payment_status: "active", automation_paused: false }],
    contacts: [],
    leads: [],
    conversations: [],
    messages: [],
    automation_events: [],
    workflow_executions: [],
    referral_requests: [],
  };
  ids = 0;
  clock = Date.UTC(2026, 9, 5, 12, 0, 0);
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: clock });
  calls.leadCreated = [];
  calls.stageChanged = [];
  calls.customerReply = [];
  calls.sends = 0;
  calls.founder = 0;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const leads = () => store.leads!;
const openLeads = (contactId: string) => leads().filter((l) => l.contact_id === contactId && ["new", "contacted", "qualified", "appointment", "estimate"].includes(String(l.status)));
const conversationOf = (contactId: string) => store.conversations!.find((c) => c.contact_id === contactId && c.status === "open")!;
const contactByPhone = (phone: string) => store.contacts!.find((c) => c.phone_normalized === phone)!;

function addContact(phone = PHONE, extra: Row = {}) {
  const contact = { id: `contact-${++ids}`, organization_id: ORG, first_name: "Riley", last_name: "Test", phone, phone_normalized: phone, email: null, email_normalized: null, sms_opt_out: false, merged_into_id: null, created_at: iso(), ...extra };
  store.contacts!.push(contact);
  return contact;
}
function addLead(contactId: string, status: string, source = "lead_capture_api") {
  const lead = { id: `lead-${++ids}`, organization_id: ORG, contact_id: contactId, status, source, service: "Roof inspection", temperature: "cold", created_at: iso(), notes: "historical" };
  store.leads!.push(lead);
  return lead;
}
function addConversation(contactId: string, leadId: string | null) {
  const conversation = { id: `conv-${++ids}`, organization_id: ORG, contact_id: contactId, lead_id: leadId, channel: "sms", status: "open", ai_enabled: true, created_at: iso() };
  store.conversations!.push(conversation);
  return conversation;
}

/** The real gate, for a fresh running execution, as every lead send evaluates it. */
async function gateFor(contactId: string, conversationId: string, leadId: string) {
  const execution = { id: `exec-${++ids}`, organization_id: ORG, status: "running" };
  store.workflow_executions!.push(execution);
  return evaluateOutboundGate(db as never, {
    organizationId: ORG,
    executionId: execution.id,
    contactId,
    conversationId,
    leadId,
    aiResult: { should_send: true, response_message: "Thanks for reaching out - we'll be in touch shortly.", needs_human: false },
  });
}

const webForm = (body: Row) =>
  captureLead(
    new Request(`https://preview.example/api/leads/capture/${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never,
    { params: Promise.resolve({ token: TOKEN }) },
  ) as Promise<Response>;
const FORM = { first_name: "Riley", last_name: "Test", phone: PHONE, service: "Roof inspection", source: "website" };

const sms = (body: string, sid: string, from = PHONE) => {
  const form = new URLSearchParams({ MessageSid: sid, From: from, To: ORG_NUMBER, Body: body });
  return inboundSms(
    new Request("https://preview.example/api/webhooks/sms/inbound", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "test" },
      body: form.toString(),
    }) as never,
  ) as Promise<Response>;
};

// ===========================================================================
// Gate: ONE condition changed (lead must be the conversation's contact's)
// ===========================================================================

test("gate 1: same contact + same lead -> allowed", async () => {
  const contact = addContact();
  const lead = addLead(contact.id as string, "new");
  const conversation = addConversation(contact.id as string, lead.id);
  assert.equal((await gateFor(contact.id as string, conversation.id, lead.id)).allowed, true);
});

test("gate 2: same contact + a different lead than the conversation's pointer -> passes the lead/conversation check (allowed)", async () => {
  const contact = addContact();
  const oldLead = addLead(contact.id as string, "lost");
  const newLead = addLead(contact.id as string, "new");
  const conversation = addConversation(contact.id as string, oldLead.id);
  assert.equal((await gateFor(contact.id as string, conversation.id, newLead.id)).allowed, true);
});

test("gate 3: a lead belonging to a DIFFERENT contact -> still blocked as lead_conversation_mismatch", async () => {
  const contact = addContact();
  const other = addContact("+15557770999");
  const othersLead = addLead(other.id as string, "new");
  const conversation = addConversation(contact.id as string, null);
  const result = await gateFor(contact.id as string, conversation.id, othersLead.id);
  assert.deepEqual(result, { allowed: false, reason: "lead_conversation_mismatch", detail: undefined });
});

test("gate 3b: a lead with no contact at all -> still blocked", async () => {
  const contact = addContact();
  const orphan = { ...addLead(contact.id as string, "new"), contact_id: null };
  store.leads![store.leads!.length - 1] = orphan;
  const conversation = addConversation(contact.id as string, null);
  assert.equal((await gateFor(contact.id as string, conversation.id, orphan.id)).reason, "lead_conversation_mismatch");
});

for (const [label, arrange, reason] of [
  ["4: opt-out", (c: Row) => (c.sms_opt_out = true), "contact_opted_out"],
  ["5: paused org", () => (store.organizations![0]!.automation_paused = true), "organization_automation_paused"],
  ["6: non-live (TEST) org", () => (store.organizations![0]!.automation_mode = "test"), "organization_not_live"],
  ["7: locked conversation", (_c: Row, conv: Row) => (conv.ai_enabled = false), "conversation_ai_disabled"],
  ["8: payment inactive", () => (store.organizations![0]!.payment_status = "payment_required"), "organization_payment_inactive"],
  ["8b: closed conversation", (_c: Row, conv: Row) => (conv.status = "closed"), "conversation_not_open"],
  ["8c: duplicate send for the execution", () => undefined, "duplicate_outbound_send"],
] as const) {
  test(`gate ${label}: same contact + different lead is STILL blocked by the other check (${reason})`, async () => {
    const contact = addContact();
    const oldLead = addLead(contact.id as string, "lost");
    const newLead = addLead(contact.id as string, "new");
    const conversation = addConversation(contact.id as string, oldLead.id);
    (arrange as (c: Row, conv: Row) => unknown)(contact, conversation);
    if (reason === "duplicate_outbound_send") {
      const execution = { id: "exec-dup", organization_id: ORG, status: "running" };
      store.workflow_executions!.push(execution);
      store.messages!.push({ id: "m-dup", workflow_execution_id: "exec-dup", direction: "outbound" });
      const result = await evaluateOutboundGate(db as never, {
        organizationId: ORG,
        executionId: "exec-dup",
        contactId: contact.id as string,
        conversationId: conversation.id,
        leadId: newLead.id,
        aiResult: { should_send: true, response_message: "Thanks - we'll be in touch.", needs_human: false },
      });
      assert.equal(result.reason, reason);
      return;
    }
    assert.equal((await gateFor(contact.id as string, conversation.id, newLead.id)).reason, reason);
  });
}

test("gate: lead status / active-engagement checks still apply to the (same-contact) lead", async () => {
  const contact = addContact();
  const lead = addLead(contact.id as string, "won");
  const conversation = addConversation(contact.id as string, null);
  const execution = { id: "exec-st", organization_id: ORG, status: "running" };
  store.workflow_executions!.push(execution);
  const result = await evaluateOutboundGate(db as never, {
    organizationId: ORG,
    executionId: "exec-st",
    contactId: contact.id as string,
    conversationId: conversation.id,
    leadId: lead.id,
    aiResult: { should_send: true, response_message: "Checking in on your project.", needs_human: false },
    leadEligibleStatuses: ["lost"],
  });
  assert.equal(result.reason, "lead_status_ineligible");
});

// ===========================================================================
// Intake helper
// ===========================================================================

test("helper: contact with an open lead elsewhere but a conversation already on an open lead keeps that pointer (never moved)", async () => {
  const contact = addContact();
  const pointed = addLead(contact.id as string, "contacted");
  addLead(contact.id as string, "new"); // a newer, manually created open lead
  const conversation = addConversation(contact.id as string, pointed.id);
  const result = await resolveLeadForIntake(db as never, { organizationId: ORG, contactId: contact.id, source: "website" });
  assert.deepEqual(result, { ok: true, leadId: pointed.id, created: false, conversationId: conversation.id, previousConversationLeadId: pointed.id });
  assert.equal(conversation.lead_id, pointed.id);
});

test("helper: repeated calls are idempotent (one lead, one conversation)", async () => {
  const contact = addContact();
  for (let i = 0; i < 3; i++) await resolveLeadForIntake(db as never, { organizationId: ORG, contactId: contact.id, source: "sms_inbound" });
  assert.equal(leads().length, 1);
  assert.equal(store.conversations!.length, 1);
  assert.equal(conversationOf(contact.id as string).lead_id, leads()[0]!.id);
});

// ===========================================================================
// Web form
// ===========================================================================

test("web form 1: new contact -> contact, lead, conversation pointing at it, first response passes the gate", async () => {
  const response = await webForm(FORM);
  const json = await response.json();
  assert.equal(response.status, 201);

  const contact = contactByPhone(PHONE);
  assert.equal(leads().length, 1);
  assert.equal(leads()[0]!.source, "website", "existing source value preserved");
  const conversation = conversationOf(contact.id as string);
  assert.equal(conversation.lead_id, json.leadId);
  assert.equal(calls.leadCreated.length, 1);
  assert.equal((await gateFor(contact.id as string, conversation.id as string, json.leadId)).allowed, true);
});

test("web form 2: returning contact with an OPEN lead (and a conversation pointing elsewhere) -> lead reused, intake recorded, no duplicate lead, no mismatch", async () => {
  const contact = addContact();
  const old = addLead(contact.id as string, "lost");
  const open = addLead(contact.id as string, "contacted");
  const conversation = addConversation(contact.id as string, old.id);
  advanceMinutes(60);

  const json = await (await webForm(FORM)).json();

  assert.equal(json.leadId, open.id);
  assert.equal(json.attachedToExistingLead, true);
  assert.equal(openLeads(contact.id as string).length, 1, "no duplicate parallel open lead");
  assert.equal(leads().length, 2);
  assert.equal(conversation.lead_id, open.id, "the stale (lost) pointer moved to the open opportunity");
  assert.equal(store.automation_events!.filter((e) => e.event_type === "lead.intake_received").length, 1);
  assert.equal(calls.leadCreated.length, 0, "the open lead's own first response already ran; no second one");
  const gate = await gateFor(contact.id as string, conversation.id, open.id);
  assert.notEqual(gate.reason, "lead_conversation_mismatch");
  assert.equal(gate.allowed, true);
});

test("web form 3: returning contact with only a CLOSED lead -> new lead, pointer moves, old lead intact, first response passes", async () => {
  const contact = addContact();
  const old = addLead(contact.id as string, "won");
  const snapshot = { ...old };
  const conversation = addConversation(contact.id as string, old.id);
  store.messages!.push({ id: "hist-1", conversation_id: conversation.id, direction: "inbound", body: "old thread" });
  advanceMinutes(60);

  const response = await webForm(FORM);
  const json = await response.json();

  assert.equal(response.status, 201);
  assert.notEqual(json.leadId, old.id);
  assert.equal(leads().length, 2);
  assert.equal(conversation.lead_id, json.leadId, "pointer moved to the new opportunity");
  assert.deepEqual(old, snapshot, "historical lead untouched");
  assert.equal(store.messages!.find((m) => m.id === "hist-1")!.conversation_id, conversation.id, "history stays in the thread");
  assert.equal(store.conversations!.length, 1, "still one SMS thread");
  assert.equal(calls.leadCreated.length, 1);
  assert.equal(calls.leadCreated[0]!.leadId, json.leadId);
  assert.equal((await gateFor(contact.id as string, conversation.id, json.leadId)).allowed, true);
});

test("web form 4: duplicate request (immediate redelivery) -> no duplicate lead; a redelivered attach is not a second intake", async () => {
  await webForm(FORM);
  const second = await (await webForm(FORM)).json();
  assert.equal(second.duplicate, true);
  assert.equal(leads().length, 1);
  assert.equal(calls.leadCreated.length, 1);

  advanceMinutes(30);
  await webForm(FORM); // a genuine later submission -> attached + recorded
  advanceMinutes(2);
  const redelivered = await (await webForm(FORM)).json();
  assert.equal(redelivered.duplicate, true);
  assert.equal(leads().length, 1);
  assert.equal(store.automation_events!.filter((e) => e.event_type === "lead.intake_received").length, 1);
});

// ===========================================================================
// Inbound SMS
// ===========================================================================

test("sms 1: unknown number -> contact + one sms_inbound lead + conversation pointing at it; customer reply carries that lead", async () => {
  await sms("Hi, do you do gutter repairs?", "SM-1", "+15557770111");
  const contact = contactByPhone("+15557770111");
  assert.ok(contact);
  assert.equal(leads().length, 1);
  assert.equal(leads()[0]!.source, "sms_inbound");
  assert.equal(conversationOf(contact.id as string).lead_id, leads()[0]!.id);
  assert.equal(calls.customerReply.length, 1);
  assert.equal(calls.customerReply[0]!.leadId, leads()[0]!.id);
  assert.equal(calls.stageChanged.length, 1);
});

test("sms 2: known contact + open lead -> attached to it, no new lead", async () => {
  const contact = addContact();
  const open = addLead(contact.id as string, "qualified");
  addConversation(contact.id as string, null);
  await sms("Following up on my quote", "SM-2");
  assert.equal(leads().length, 1);
  assert.equal(calls.customerReply[0]!.leadId, open.id);
  assert.equal(conversationOf(contact.id as string).lead_id, open.id);
});

test("sms 3: known contact + only closed leads -> one new sms_inbound lead; old leads intact", async () => {
  const contact = addContact();
  const lost = addLead(contact.id as string, "lost");
  const snapshot = { ...lost };
  addConversation(contact.id as string, lost.id);
  await sms("We're ready to move forward now", "SM-3");
  assert.equal(leads().length, 2);
  const created = leads().find((l) => l.id !== lost.id)!;
  assert.equal(created.source, "sms_inbound");
  assert.equal(conversationOf(contact.id as string).lead_id, created.id);
  assert.deepEqual(lost, snapshot);
});

test("sms 4: repeated messages -> still one lead", async () => {
  await sms("Hello?", "SM-4a", "+15557770222");
  await sms("Anyone there?", "SM-4b", "+15557770222");
  await sms("Need a roof quote", "SM-4c", "+15557770222");
  assert.equal(leads().length, 1);
  assert.equal(calls.customerReply.length, 3);
});

test("sms 5: duplicate webhook (same MessageSid) -> no duplicate lead, message or reply", async () => {
  await sms("Need a roof quote", "SM-5", "+15557770333");
  await sms("Need a roof quote", "SM-5", "+15557770333");
  assert.equal(leads().length, 1);
  assert.equal(store.messages!.filter((m) => m.provider_message_id === "SM-5").length, 1);
  assert.equal(calls.customerReply.length, 1);
});

for (const [keyword, expectOptOut] of [["STOP", true], ["START", false], ["HELP", null]] as const) {
  test(`sms ${keyword}: existing compliance behavior, and never creates a lead or reaches the AI`, async () => {
    const contact = addContact("+15557770444", { sms_opt_out: keyword === "START" });
    await sms(keyword, `SM-${keyword}`, "+15557770444");
    assert.equal(leads().length, 0, "compliance keywords never create a lead");
    assert.equal(calls.customerReply.length, 0);
    if (expectOptOut !== null) assert.equal(contact.sms_opt_out, expectOptOut);
    assert.equal(calls.sends, keyword === "HELP" ? 1 : 0, "HELP still gets its one deterministic reply");
  });
}

// ===========================================================================
// Referral -> lead
// ===========================================================================

function addReferral() {
  const referral = { id: `ref-${++ids}`, organization_id: ORG, job_id: `job-${ids}`, status: "requested", referred_lead_id: null };
  store.referral_requests!.push(referral);
  return referral;
}
const referIn = (referral: Row, phone = "+15557770555") => createLeadFromReferralForOrganization(db as never, ORG, "user-1", referral.job_id as string, { firstName: "Jordan", phone });

test("referral 1: unknown contact -> one referral lead, conversation points at it", async () => {
  const referral = addReferral();
  const result = await referIn(referral);
  assert.equal(result.ok, true);
  assert.equal(leads().length, 1);
  assert.equal(leads()[0]!.source, "referral");
  assert.equal(referral.referred_lead_id, leads()[0]!.id);
  assert.equal(calls.leadCreated.length, 1);
  assert.equal(conversationOf(leads()[0]!.contact_id as string).lead_id, leads()[0]!.id);
});

test("referral 2: referred person already has an open lead -> attributed to it, no duplicate, no second new-lead lifecycle", async () => {
  const contact = addContact("+15557770555");
  const open = addLead(contact.id as string, "new");
  const referral = addReferral();
  const result = await referIn(referral);
  assert.equal(result.ok && result.id, open.id);
  assert.equal(leads().length, 1);
  assert.equal(referral.referred_lead_id, open.id);
  assert.equal(calls.leadCreated.length, 0);
});

test("referral 3: referred person's prior lead is closed -> new active lead, pointer moves, old lead intact", async () => {
  const contact = addContact("+15557770555");
  const closed = addLead(contact.id as string, "lost");
  const snapshot = { ...closed };
  const conversation = addConversation(contact.id as string, closed.id);
  const result = await referIn(addReferral());
  assert.equal(leads().length, 2);
  assert.ok(result.ok && result.id !== closed.id);
  assert.equal(conversation.lead_id, result.ok ? result.id : null);
  assert.deepEqual(closed, snapshot);
});

test("referral 4: duplicate conversion of the same referral -> no duplicate lead", async () => {
  const referral = addReferral();
  await referIn(referral);
  const second = await referIn(referral);
  assert.equal(second.ok, false);
  assert.equal(leads().length, 1);
});

// ===========================================================================
// Missed call
// ===========================================================================

const call = (sid: string, from = "+15557770666") => handleMissedCall(db as never, { callSid: sid, from, to: ORG_NUMBER }, async () => ({ ok: true, sid: "SM" }) as never);
const missedCallExecution = () => store.workflow_executions!.find((e) => e.workflow_name !== undefined && String(e.workflow_name).includes("missed"));

test("missed call 1: unknown caller -> contact + phone lead + conversation, follow-up passes the gate", async () => {
  await call("CA-1");
  const contact = contactByPhone("+15557770666");
  assert.equal(leads().length, 1);
  assert.equal(leads()[0]!.source, "phone");
  assert.equal(conversationOf(contact.id as string).lead_id, leads()[0]!.id);
  assert.equal(calls.sends, 1);
  assert.equal(missedCallExecution()?.status, "completed");
});

test("missed call 2: existing open lead -> reused", async () => {
  const contact = addContact("+15557770666");
  const open = addLead(contact.id as string, "contacted", "website");
  addConversation(contact.id as string, open.id);
  await call("CA-2");
  assert.equal(leads().length, 1);
  assert.equal(calls.sends, 1);
});

test("missed call 3+5: only a closed lead + a stale conversation pointer -> new lead, pointer moved, follow-up NOT blocked by the stale lead_id", async () => {
  const contact = addContact("+15557770666");
  const closed = addLead(contact.id as string, "won", "website");
  const conversation = addConversation(contact.id as string, closed.id);
  await call("CA-3");
  assert.equal(leads().length, 2);
  const created = leads().find((l) => l.id !== closed.id)!;
  assert.equal(created.source, "phone");
  assert.equal(conversation.lead_id, created.id);
  assert.equal(store.conversations!.length, 1, "4: the existing conversation remains the thread");
  assert.equal(calls.sends, 1, "the missed-call text went through the gate");
  assert.notEqual((missedCallExecution()?.metadata as Row | undefined)?.blocked_reason, "lead_conversation_mismatch");
});

test("missed call: a Twilio retry of the same call -> no duplicate lead or text", async () => {
  await call("CA-4");
  await call("CA-4");
  assert.equal(leads().length, 1);
  assert.equal(calls.sends, 1);
});

// ===========================================================================
// Old-lead behaviour (Rule 11) and manual leads (Rule 12)
// ===========================================================================

test("old lead open + a new opportunity arrives -> attached to Lead A; never two competing automated open leads", async () => {
  const contact = addContact();
  const leadA = addLead(contact.id as string, "qualified");
  addConversation(contact.id as string, leadA.id);
  advanceMinutes(60);
  await webForm(FORM);
  await sms("Also need gutters looked at", "SM-R11");
  await call("CA-R11", PHONE);
  assert.equal(openLeads(contact.id as string).length, 1);
  assert.equal(openLeads(contact.id as string)[0]!.id, leadA.id);
});

test("manual second lead is never blocked by the automated rule, and its first response passes the gate", async () => {
  const contact = addContact();
  const leadA = addLead(contact.id as string, "contacted");
  const conversation = addConversation(contact.id as string, leadA.id);
  const manualB = addLead(contact.id as string, "new", "manual");
  assert.equal(openLeads(contact.id as string).length, 2, "a contractor may deliberately create a second open lead");
  assert.equal(conversation.lead_id, leadA.id);
  assert.equal((await gateFor(contact.id as string, conversation.id, manualB.id)).allowed, true);
});

// ===========================================================================
// P0 A3: concurrent intake
// ===========================================================================

test("A3 concurrency: two simultaneous first texts from a brand-new number -> exactly one open lead, both deliveries attributed to it", async () => {
  const contact = addContact("+15557770777");
  const [a, b] = await Promise.all([
    resolveLeadForIntake(db as never, { organizationId: ORG, contactId: contact.id, source: "sms_inbound" }),
    resolveLeadForIntake(db as never, { organizationId: ORG, contactId: contact.id, source: "sms_inbound" }),
  ]);
  assert.equal(openLeads(contact.id as string).length, 1, "the unique index refuses the second insert");
  assert.ok(a.ok && b.ok, "the losing delivery re-reads the winner instead of failing");
  assert.equal(a.ok && a.leadId, b.ok && b.leadId);
  assert.deepEqual([a.ok && a.created, b.ok && b.created].sort(), [false, true], "exactly one created it");
});

test("A3 concurrency: after the first SMS lead is closed, a later text creates a new one; a qualified one is reused", async () => {
  const contact = addContact("+15557770778");
  const first = await resolveLeadForIntake(db as never, { organizationId: ORG, contactId: contact.id, source: "sms_inbound" });
  assert.ok(first.ok);
  leads().find((l) => l.id === (first.ok && first.leadId))!.status = "lost";
  const second = await resolveLeadForIntake(db as never, { organizationId: ORG, contactId: contact.id, source: "sms_inbound" });
  assert.ok(second.ok && second.created && second.leadId !== (first.ok && first.leadId));
  leads().find((l) => l.id === (second.ok && second.leadId))!.status = "contacted";
  const third = await resolveLeadForIntake(db as never, { organizationId: ORG, contactId: contact.id, source: "sms_inbound" });
  assert.equal(third.ok && third.leadId, second.ok && second.leadId, "an open (qualified) lead is reused, never duplicated");
  assert.equal(openLeads(contact.id as string).length, 1);
});
