/**
 * P0-B B2.8c: lost-lead nurture and lead reactivation on the shared n8n
 * hand-off, end to end. The REAL producer claims the touch through
 * claimAndHandOffTouch (key + B0 start marked n8n_draft) and dispatches the
 * same contract to n8n as before (captured here, never sent); the REAL n8n
 * callback route then takes the strict draft (validateN8nDraftCallback)
 * into resumeClaimedTouch - B1, still owed (A3), the organization's AI
 * setting, the REAL outbound gate, the send and the record. Every other
 * event type keeps the legacy ai_result flow.
 *
 * In-memory store with B0-shaped RPCs; the SMS sender is mocked with the
 * outbound unique index (one outbound message per execution). Nothing
 * reaches TEST, Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test app/api/automation/n8n-callback/handoff-callback.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const SECRET = "test-webhook-secret";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let store: Record<string, Row[]> = {};
let ids = 0;
const trace: string[] = [];
const calls = { sends: 0, signals: [] as Row[], founder: [] as string[], contracts: [] as Row[], gateInputs: [] as Row[] };
const control = { dispatchOk: true, aiEnabled: true, snapshotFails: false, kindReadFails: false, sendHeld: Promise.resolve() as Promise<void>, gateBarrier: null as null | { arrivals: number; open: () => void; opened: Promise<void> } };
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

function deriveOutcome(row: Row) {
  const metadata = (row.metadata ?? {}) as Row;
  row.outcome = row.status === "running" ? null : row.status === "completed" ? (metadata.blocked_reason ? "blocked" : "succeeded") : row.status === "failed" ? "failed" : null;
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private insertRows: Row[] | null = null;
  private upsertRow: Row | null = null;
  private sorts: { column: string; ascending: boolean }[] = [];
  private window: [number, number] | null = null;
  private max: number | null = null;
  private columns = "";
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select(columns?: string) { this.columns = columns ?? ""; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, op: string, v: unknown) { this.filters.push((r) => (op === "is" ? (r[c] ?? null) !== v : true)); return this; }
  or(expr: string) { const parts = expr.split(",").map((p) => p.split(".")); this.filters.push((r) => parts.some(([c, op, v]) => op === "eq" && String(r[c]) === v)); return this; }
  gt(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) > v); return this; }
  gte(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) >= v); return this; }
  lt(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) < v); return this; }
  lte(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) <= v); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.sorts.push({ column: c, ascending: o?.ascending !== false }); return this; }
  range(from: number, to: number) { this.window = [from, to]; return this; }
  limit(n: number) { this.max = n; return this; }
  update(v: Row) { this.updateValues = v; return this; }
  insert(v: Row | Row[]) { this.insertRows = Array.isArray(v) ? v : [v]; return this; }
  upsert(v: Row) { this.upsertRow = v; return this; }
  single() { return this.run(true); }
  maybeSingle() { return this.run(true); }
  then<T>(resolve: (v: { data: unknown; error: unknown }) => T, reject?: (e: unknown) => T) { return this.run(false).then(resolve, reject); }
  private async run(single: boolean): Promise<{ data: unknown; error: unknown }> {
    if (this.table === "opportunities") {
      trace.push("snapshot");
      if (control.snapshotFails) return { data: null, error: { message: "snapshot read failed (test)" } };
    }
    const rows = (store[this.table] ??= []);
    if (this.upsertRow) {
      if (!rows.some((r) => r.workflow_execution_id === this.upsertRow!.workflow_execution_id)) rows.push({ id: uuid(), ...this.upsertRow });
      return { data: null, error: null };
    }
    if (this.insertRows) {
      const inserted = this.insertRows.map((r) => ({ id: uuid(), ...(this.table === "conversations" ? { status: "open", ai_enabled: true } : {}), ...r }));
      rows.push(...inserted);
      return { data: single ? { ...inserted[0] } : inserted.map((r) => ({ ...r })), error: null };
    }
    let matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.updateValues) for (const r of matched) Object.assign(r, this.updateValues);
    if (this.sorts.length) matched = [...matched].sort((a, b) => { for (const { column, ascending } of this.sorts) { const d = String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0; if (d) return d * (ascending ? 1 : -1); } return 0; });
    if (this.window) matched = matched.slice(this.window[0], this.window[1] + 1);
    if (this.max !== null) matched = matched.slice(0, this.max);
    // The route reads an execution with its event embedded, as Supabase returns it.
    const embed = this.table === "workflow_executions" && this.columns.includes("automation_events(");
    if (embed && control.kindReadFails) return { data: null, error: { message: "execution read failed (test)" } };
    const copy = matched.map((r) => (embed ? { ...r, automation_events: store.automation_events!.find((e) => e.id === r.automation_event_id) ?? null } : { ...r }));
    return { data: single ? (copy[0] ?? null) : copy, error: null };
  }
}

function rpc(name: string, args: Row) {
  const run = async () => {
    const executions = (store.workflow_executions ??= []);
    const events = (store.automation_events ??= []);
    if (name === "create_automation_event") {
      trace.push("event");
      const existing = events.find((e) => e.organization_id === args.p_organization_id && e.idempotency_key === args.p_idempotency_key);
      if (existing) return { data: { ...existing, is_duplicate: true }, error: null };
      const event = { id: uuid(), organization_id: args.p_organization_id, event_type: args.p_event_type, entity_type: args.p_entity_type, entity_id: args.p_entity_id, payload: args.p_payload, idempotency_key: args.p_idempotency_key, status: "pending", created_at: NOW.toISOString() };
      events.push(event);
      return { data: { ...event, is_duplicate: false }, error: null };
    }
    if (name === "start_workflow_execution") {
      trace.push("start");
      const event = events.find((e) => e.id === args.p_automation_event_id);
      if (!event) return { data: null, error: { message: "Automation event not found" } };
      if (event.status === "processing") return { data: null, error: { message: "Automation event is already being processed" } };
      if (event.status === "completed") return { data: null, error: { message: "Automation event has already completed" } };
      const attempt = Math.max(0, ...executions.filter((e) => e.automation_event_id === event.id).map((e) => Number(e.attempt))) + 1;
      const row: Row = { id: uuid(), organization_id: event.organization_id, automation_event_id: event.id, workflow_name: args.p_workflow_name, status: "running", attempt, started_at: NOW.toISOString(), completed_at: null, error_message: null, metadata: args.p_metadata ?? {}, trigger_source: args.p_trigger_source, retry_state: null };
      deriveOutcome(row);
      executions.push(row);
      event.status = "processing";
      return { data: { ...row }, error: null };
    }
    const execution = executions.find((e) => e.id === args.p_execution_id);
    if (!execution) return { data: null, error: { message: "Execution not found" } };
    if (execution.status !== "running") return { data: null, error: { message: "Execution is not running" } };
    const event = events.find((e) => e.id === execution.automation_event_id);
    if (name === "complete_workflow_execution") {
      trace.push("complete");
      Object.assign(execution, { status: "completed", metadata: args.p_metadata ?? {}, completed_at: NOW.toISOString() });
      if (event?.status === "processing") event.status = "completed";
    } else if (name === "fail_workflow_execution") {
      trace.push("fail");
      Object.assign(execution, { status: "failed", error_message: args.p_error_message, completed_at: NOW.toISOString() });
      if (event?.status === "processing") event.status = "failed";
    } else return { data: null, error: { message: `unexpected rpc ${name}` } };
    deriveOutcome(execution);
    return { data: { ...execution }, error: null };
  };
  return { single: run, then: <T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) => run().then(resolve, reject) };
}
const db = { from: (t: string) => new Query(t), rpc };

const realNextServer = await import("next/server");
mock.module("next/server", { namedExports: { ...realNextServer, after: (fn: () => unknown) => void fn() } });
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => db } });
mock.module(lib("lib/automation-health/service.ts"), {
  namedExports: {
    recordAutomationHealthSignal: async (_s: unknown, input: Row) => (calls.signals.push(input), { occurrenceCount: 1 }),
    resolveAutomationFailureIncidents: async () => undefined,
  },
});
mock.module(lib("lib/notifications/founder.ts"), { namedExports: { notifyFounder: async (_s: unknown, input: Row) => void calls.founder.push(String(input.kind)) } });
const realN8n = await import(lib("lib/automation/n8n.ts"));
mock.module(lib("lib/automation/n8n.ts"), {
  namedExports: {
    ...realN8n,
    triggerN8nWorkflow: async (contract: Row) => {
      trace.push("dispatch");
      calls.contracts.push(contract);
      return control.dispatchOk ? { ok: true } : { ok: false, error: "Could not reach the automation orchestrator." };
    },
  },
});
const realGate = await import(lib("lib/automation/outbound-gate.ts"));
mock.module(lib("lib/automation/outbound-gate.ts"), {
  namedExports: {
    ...realGate,
    evaluateOutboundGate: async (...args: Parameters<typeof realGate.evaluateOutboundGate>) => {
      trace.push("gate");
      calls.gateInputs.push(args[1] as Row);
      const result = await realGate.evaluateOutboundGate(...args);
      // The real race window: hold every caller after the gate until two have passed it.
      const barrier = control.gateBarrier;
      if (barrier) {
        barrier.arrivals += 1;
        if (barrier.arrivals >= 2) barrier.open();
        await barrier.opened;
      }
      return result;
    },
  },
});
mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async (_s: unknown, input: Row) => {
      // The outbound unique index: one outbound message per execution.
      const owner = store.messages!.find((m) => m.direction === "outbound" && m.workflow_execution_id === input.workflowExecutionId);
      if (owner && owner.status !== "sent") return { ok: false, error: "This workflow execution already has an outbound message in progress.", messageId: owner.id, conversationId: input.conversationId, duplicateInProgress: true };
      calls.sends += 1;
      trace.push("send");
      const message: Row = { id: uuid(), organization_id: input.organizationId, conversation_id: input.conversationId, workflow_execution_id: input.workflowExecutionId, direction: "outbound", body: input.body, sender_type: input.senderType, status: "queued", created_at: NOW.toISOString() };
      store.messages!.push(message);
      await control.sendHeld;
      message.status = "sent";
      return { ok: true, messageId: message.id, conversationId: input.conversationId, providerMessageId: "SM" };
    },
  },
});
const realSettings = await import(lib("lib/settings/queries.ts"));
mock.module(lib("lib/settings/queries.ts"), {
  namedExports: {
    ...realSettings,
    getAiSettings: async () => ({ ai_enabled: control.aiEnabled, tone: "friendly", business_introduction: null, general_instructions: null }),
    getBusinessProfile: async () => ({ name: "QA Fixture Roofing", timezone: "UTC" }),
    getBusinessHours: async () => [],
    getOrganizationTimezone: async () => "UTC",
  },
});

process.env.N8N_WEBHOOK_SECRET = SECRET;
const { POST, DRAFT_HANDOFF_EVENT_TYPES, DRAFT_AI_MODEL_FAILURE } = await import(lib("app/api/automation/n8n-callback/route.ts"));
const { processLeadNurture, LOST_LEAD_NURTURE_ADAPTER } = await import(lib("lib/automation/lead-nurture.ts"));
const { processLeadReactivation, LEAD_REACTIVATION_ADAPTER } = await import(lib("lib/automation/lead-reactivation.ts"));
const { SAFE_RETRY_AUTOMATION_IDS, AUTOMATIC_RETRY_POLICY, checkRetryEligibility } = await import(lib("lib/automation/retry-eligibility.ts"));

beforeEach(() => {
  store = {
    organizations: [
      { id: ORG, automation_mode: "live", payment_status: "active", automation_paused: false, name: "QA Fixture Roofing", timezone: "UTC" },
      { id: OTHER_ORG, automation_mode: "live", payment_status: "active", automation_paused: false },
    ],
    contacts: [{ id: CONTACT, organization_id: ORG, first_name: "Riley", phone: "+15550142301", phone_normalized: "+15550142301", sms_opt_out: false }],
    automation_settings: [
      { organization_id: ORG, automation_id: "lost-lead-nurture", enabled: true, config: { touch_1_days: 3, touch_2_days: 14 } },
      { organization_id: ORG, automation_id: "lead-reactivation", enabled: true, config: { touch_1_days: 7, touch_2_days: 21 } },
      { organization_id: ORG, automation_id: "instant-lead-followup", enabled: true, config: null },
    ],
    leads: [], conversations: [], messages: [], appointments: [], estimates: [], jobs: [], invoices: [], opportunities: [], automation_events: [], workflow_executions: [], ai_interactions: [],
  };
  ids = 100;
  trace.length = 0;
  calls.sends = 0; calls.signals = []; calls.founder = []; calls.contracts = []; calls.gateInputs = [];
  control.dispatchOk = true; control.aiEnabled = true; control.snapshotFails = false; control.kindReadFails = false; control.sendHeld = Promise.resolve(); control.gateBarrier = null;
});

const addLead = (status: string, extra: Row = {}) => {
  const lead = { id: uuid(), organization_id: ORG, contact_id: CONTACT, status, source: "web_form", service: "Roof repair", ai_summary: null, created_at: ago(60), updated_at: ago(60), ...extra };
  store.leads!.push(lead);
  return lead as Row & { id: string };
};
/** A lost lead whose touch 1 is due now (3.5 days after it went lost - 12 hours late, inside the 48-hour rule). */
function lostLead() {
  const lead = addLead("lost");
  store.automation_events!.push({ id: uuid(), organization_id: ORG, event_type: "lead.lost", entity_type: "lead", entity_id: lead.id, payload: {}, idempotency_key: `lead.lost:${lead.id}`, status: "completed", created_at: ago(3.5) });
  return lead;
}
/** A contacted lead with its own open SMS conversation whose last inbound message was 7.5 days ago - touch 1 due. */
function quietLead() {
  const lead = addLead("contacted");
  // One open SMS conversation per contact: an earlier fixture's conversation is closed first.
  for (const c of store.conversations!) if (c.contact_id === CONTACT && c.status === "open") c.status = "closed";
  const conversation = { id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: lead.id, channel: "sms", status: "open", ai_enabled: true };
  store.conversations!.push(conversation);
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: conversation.id, direction: "inbound", body: "hi", created_at: ago(7.5) });
  return { lead, conversation };
}
const eventOf = (type: string, leadId?: string) => store.automation_events!.find((e) => e.event_type === type && (leadId === undefined || e.entity_id === leadId))!;
const executionOf = (event: Row) => store.workflow_executions!.find((e) => e.automation_event_id === event.id)!;
const outbound = () => store.messages!.filter((m) => m.direction === "outbound");

const DRAFT = { body: "Hi Riley - QA Fixture Roofing here, checking in on your roof repair. Still interested?", needs_human: false, classification: { qualification_status: "qualified", urgency: "normal", intent: "Lost lead nurture - touch 1", summary: "Routine nurture touch.", missing_information: [] }, model: "claude-sonnet-5", usage: { input_tokens: 812, output_tokens: 64, total_tokens: 876 } };
const strictBody = (event: Row, overrides: Row = {}, draft: unknown = DRAFT) => ({ execution_id: executionOf(event).id, event_id: event.id, organization_id: ORG, automation_id: event.event_type === "lead.lost_nurture" ? "lost-lead-nurture" : "lead-reactivation", draft, ...overrides });
const post = (body: unknown, secret = SECRET) =>
  POST(new Request("https://preview.example/api/automation/n8n-callback", { method: "POST", headers: { "content-type": "application/json", "x-trackpr-webhook-secret": secret }, body: JSON.stringify(body) }) as never) as Promise<Response>;
const reply = async (body: unknown) => {
  const response = await post(body);
  return { status: response.status, json: await response.json() };
};
async function handedOffNurture() {
  const lead = lostLead();
  const result = await processLeadNurture(db as never, NOW);
  assert.equal(result.outcomes.find((o: Row) => o.leadId === lead.id)!.outcome, "dispatched", JSON.stringify(result.outcomes));
  return { lead, event: eventOf("lead.lost_nurture", lead.id) };
}
async function handedOffReactivation() {
  const { lead, conversation } = quietLead();
  const result = await processLeadReactivation(db as never, NOW);
  assert.equal(result.outcomes.find((o: Row) => o.leadId === lead.id)!.outcome, "dispatched", JSON.stringify(result.outcomes));
  return { lead, conversation, event: eventOf("lead.reactivation", lead.id) };
}

// ---------------------------------------------------------------- hand-off

test("1. nurture producer: claims the touch through the shared runtime - the same key and payload, the B0 execution marked n8n_draft, the same n8n contract, nothing sent", async () => {
  const lead = lostLead();
  const result = await processLeadNurture(db as never, NOW);
  const event = eventOf("lead.lost_nurture");
  const execution = executionOf(event);
  assert.deepEqual(result.outcomes, [{ leadId: lead.id, outcome: "dispatched", occurrence: 1, executionId: execution.id }]);
  assert.equal(event.idempotency_key, `lead.lost_nurture:${lead.id}:1`);
  const conversation = store.conversations![0];
  assert.deepEqual(event.payload, { lead_id: lead.id, contact_id: CONTACT, conversation_id: conversation.id, occurrence: 1 });
  assert.deepEqual({ workflow: execution.workflow_name, metadata: execution.metadata, trigger: execution.trigger_source, status: execution.status }, { workflow: "lead_lost_nurture_followup", metadata: { handoff: "n8n_draft" }, trigger: "event", status: "running" });
  const [contract] = calls.contracts as Row[];
  assert.deepEqual(contract.event, { id: event.id, type: "lead.lost_nurture", organization_id: ORG, entity_type: "lead", entity_id: lead.id, payload: { lead_id: lead.id, contact_id: CONTACT, conversation_id: conversation.id, service: "Roof repair", source: "web_form", ai_summary: null, status: "lost", occurrence: 1 } });
  assert.deepEqual(contract.execution, { id: execution.id, workflow_name: "lead_lost_nurture_followup", attempt: 1 });
  assert.deepEqual((contract.context as Row).organization, { id: ORG, name: "QA Fixture Roofing", timezone: "UTC" });
  assert.ok(trace.indexOf("snapshot") < trace.indexOf("event") && trace.indexOf("start") < trace.indexOf("dispatch"), `B1 -> claim -> dispatch: ${trace}`);
  assert.deepEqual([calls.sends, trace.includes("gate")], [0, false]);
});

test("2. reactivation producer: same - its own key and payload, marked n8n_draft, the same contract (fresh status), nothing sent", async () => {
  const { lead, conversation } = quietLead();
  await processLeadReactivation(db as never, NOW);
  const event = eventOf("lead.reactivation");
  const execution = executionOf(event);
  assert.equal(event.idempotency_key, `lead.reactivation:${lead.id}:1`);
  assert.deepEqual(event.payload, { lead_id: lead.id, contact_id: CONTACT, conversation_id: conversation.id, occurrence: 1 });
  assert.deepEqual(execution.metadata, { handoff: "n8n_draft" });
  const [contract] = calls.contracts as Row[];
  assert.equal(((contract.event as Row).payload as Row).status, "contacted");
  assert.deepEqual(contract.execution, { id: execution.id, workflow_name: "lead_reactivation_followup", attempt: 1 });
  assert.equal(((contract.context as Row).contact as Row).id, CONTACT);
  assert.equal(calls.sends, 0);
});

test("3. a failed dispatch fails the claimed execution exactly as before (n8n_dispatch_failed); the touch is not re-claimed and A2 never retries it", async () => {
  control.dispatchOk = false;
  lostLead();
  const result = await processLeadNurture(db as never, NOW);
  assert.equal(result.outcomes[0].outcome, "dispatched", "the dispatch is deferred, as before");
  const execution = executionOf(eventOf("lead.lost_nurture"));
  assert.deepEqual({ status: execution.status, error: execution.error_message }, { status: "failed", error: "Could not reach the automation orchestrator." });
  assert.ok(calls.signals.some((s) => s.category === "n8n_dispatch_failed"));
  const again = await processLeadNurture(db as never, NOW);
  assert.equal(again.outcomes[0].outcome, "skipped_duplicate");
  const eligibility = await checkRetryEligibility(db as never, ORG, execution.id as string);
  assert.deepEqual({ ok: eligibility.ok, reason: (eligibility as Row).reason }, { ok: false, reason: "not_safely_retryable" });
  assert.ok(!SAFE_RETRY_AUTOMATION_IDS.has("lost-lead-nurture") && !SAFE_RETRY_AUTOMATION_IDS.has("lead-reactivation"));
  assert.equal(AUTOMATIC_RETRY_POLICY["lead_lost_nurture_followup"], undefined);
  assert.equal(AUTOMATIC_RETRY_POLICY["lead_reactivation_followup"], undefined);
});

test("4. the producers keep their own recorded blocks: a touch more than 48 hours late is followup_overdue, never handed off", async () => {
  const lead = addLead("lost");
  store.automation_events!.push({ id: uuid(), organization_id: ORG, event_type: "lead.lost", entity_type: "lead", entity_id: lead.id, payload: {}, idempotency_key: `lead.lost:${lead.id}`, status: "completed", created_at: ago(6) });
  const result = await processLeadNurture(db as never, NOW);
  assert.deepEqual(result.outcomes, [{ leadId: lead.id, outcome: "blocked", reason: "followup_overdue" }]);
  assert.equal(calls.contracts.length, 0);
  assert.notDeepEqual(executionOf(eventOf("lead.lost_nurture")).metadata, { handoff: "n8n_draft" });
});

// ---------------------------------------------------------------- the strict draft callback

test("5. nurture: a strict draft resumes the claimed touch - B1, still owed, the gate, the send, the record; the draft is the body", async () => {
  const { lead, event } = await handedOffNurture();
  trace.length = 0;
  const { status, json } = await reply(strictBody(event));
  assert.deepEqual([status, json], [200, { ok: true }]);
  const order = ["snapshot", "gate", "send", "complete"].map((s) => trace.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && [...order].sort((a, b) => a - b).join() === order.join(), `B1 -> gate -> send -> record: ${trace}`);
  const [message] = outbound();
  assert.deepEqual({ body: message.body, sender: message.sender_type }, { body: DRAFT.body, sender: "ai" });
  const execution = executionOf(event);
  assert.deepEqual(execution.metadata, { should_send: true, message_id: message.id, conversation_id: message.conversation_id, provider_message_id: "SM", lead_id: lead.id, occurrence: 1 });
  const [interaction] = store.ai_interactions!;
  assert.deepEqual({ type: interaction.interaction_type, model: interaction.model, tokens: interaction.tokens_used, execution: interaction.workflow_execution_id }, { type: "lead_lost_nurture_response", model: "claude-sonnet-5", tokens: 876, execution: execution.id });
  assert.match(String(store.leads!.find((l) => l.id === lead.id)!.ai_summary), /^Qualification: qualified · Urgency: normal · Routine nurture touch\.$/);
});

test("6. reactivation: the same path under automation id lead-reactivation", async () => {
  const { conversation, event } = await handedOffReactivation();
  const { json } = await reply(strictBody(event));
  assert.deepEqual(json, { ok: true });
  const [message] = outbound();
  assert.deepEqual({ body: message.body, conversation: message.conversation_id }, { body: DRAFT.body, conversation: conversation.id });
  assert.equal(executionOf(event).status, "completed");
  assert.equal(store.ai_interactions![0].interaction_type, "lead_reactivation_response");
});

test("7. contract: a missing or wrong automation id, a malformed draft and unknown fields never send", async () => {
  const { event } = await handedOffNurture();
  const execution = executionOf(event);
  const missing = strictBody(event);
  delete (missing as Row).automation_id;
  assert.equal((await reply(missing)).status, 400, "missing automation id: nothing recorded");
  assert.deepEqual(await reply(strictBody(event, { automation_id: "lead-reactivation" })), { status: 400, json: { ok: false, error: "Rejected: automation_mismatch." } });
  assert.equal(execution.status, "running", "a rejected callback records nothing");
  // A strict-invalid draft for the claimed execution fails it (fail closed) - never a send, never a decision.
  const unknown = await reply(strictBody(event, {}, { ...DRAFT, send_authorized: true }));
  assert.deepEqual(unknown, { status: 200, json: { ok: true, failed: true } });
  assert.deepEqual({ status: execution.status, error: execution.error_message }, { status: "failed", error: "draft_invalid: unexpected field: draft.send_authorized" });
  assert.deepEqual([calls.sends, outbound().length, store.ai_interactions!.length], [0, 0, 0]);
  // The legacy ai_result shape is not accepted for a handed-off kind.
  const { event: second } = await handedOffReactivation();
  const legacy = await reply({ execution_id: executionOf(second).id, event_id: second.id, organization_id: ORG, ai_result: { should_send: true, response_message: "x", qualification_status: "new", missing_information: [], urgency: "normal", needs_human: false, model: "m" } });
  assert.equal(legacy.status, 400);
  assert.equal(executionOf(second).status, "running");
  for (const bad of [{ ...DRAFT, body: "" }, { ...DRAFT, body: "x".repeat(1601) }, { ...DRAFT, needs_human: "no" }]) {
    store.leads = []; store.conversations = []; // a fresh customer each round (a newer lead would supersede the lost one - A3)
    const { event: e } = await handedOffNurture();
    const r = await reply(strictBody(e, {}, bad));
    assert.deepEqual(r.json, { ok: true, failed: true });
    assert.match(String(executionOf(e).error_message), /^draft_invalid: /);
  }
  assert.equal(calls.sends, 0);
});

test("8. AI failure stays a FAILED execution - never a needs-human decision: no lock, no escalation, no AI record, no send", async () => {
  const { lead, event } = await handedOffNurture();
  const conversation = store.conversations![0];
  const failure = { body: null, needs_human: true, classification: null, model: null, usage: null };
  const { json } = await reply(strictBody(event, {}, failure));
  assert.deepEqual(json, { ok: true, failed: true });
  const execution = executionOf(event);
  assert.deepEqual({ status: execution.status, outcome: execution.outcome, error: execution.error_message }, { status: "failed", outcome: "failed", error: DRAFT_AI_MODEL_FAILURE });
  assert.equal(DRAFT_AI_MODEL_FAILURE, "ai_model_failure: AI model call failed or returned no usable result");
  assert.equal(conversation.ai_enabled, true, "an outage never locks the conversation");
  assert.deepEqual([calls.founder, store.ai_interactions!.length, calls.sends], [[], 0, 0]);
  assert.ok(!calls.signals.some((s) => s.category === "human_escalation_requested"));
  assert.equal(store.leads!.find((l) => l.id === lead.id)!.ai_summary, null);
});

test("9. a valid needs-human draft is a recorded human-required decision: blocked needs_human (completed), conversation locked once, escalation recorded - never sent", async () => {
  const { event } = await handedOffNurture();
  const conversation = store.conversations![0];
  const { json } = await reply(strictBody(event, {}, { ...DRAFT, needs_human: true }));
  assert.deepEqual(json, { ok: true, sent: false, blockedReason: "needs_human" });
  const execution = executionOf(event);
  assert.deepEqual({ status: execution.status, outcome: execution.outcome, reason: (execution.metadata as Row).blocked_reason }, { status: "completed", outcome: "blocked", reason: "needs_human" });
  assert.equal(conversation.ai_enabled, false);
  assert.ok(calls.signals.some((s) => s.category === "human_escalation_requested"));
  assert.deepEqual(calls.founder, ["ai_escalation"]);
  assert.equal(store.ai_interactions!.length, 1);
  assert.equal(calls.sends, 0);
  // A declined draft (no body) is a recorded decision too - not a failure.
  const { event: declined } = await handedOffReactivation();
  assert.deepEqual((await reply(strictBody(declined, {}, { ...DRAFT, body: null }))).json, { ok: true, sent: false, blockedReason: "draft_declined" });
  assert.equal(executionOf(declined).outcome, "blocked");
});

// ---------------------------------------------------------------- re-verification after the draft

test("10. lifecycle moved on after the hand-off: the draft is blocked on Trackpr's fresh state, before any AI side effect - never sent", async () => {
  const cases: [string, (lead: Row) => void, string][] = [
    ["lead no longer lost", (lead) => { lead.status = "contacted"; }, "lead_not_lost"],
    ["lead deleted", (lead) => { store.leads = store.leads!.filter((l) => l.id !== lead.id); }, "lead_not_lost"],
    ["the customer came back (newer lead)", () => { addLead("new", { created_at: NOW.toISOString() }); }, "lead_superseded"],
    ["appointment booked", () => { store.appointments!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: null, status: "scheduled" }); }, "contact_active_engagement"],
    ["estimate created", () => { store.estimates!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: null, status: "sent" }); }, "contact_active_engagement"],
    ["job created", () => { store.jobs!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: null, status: "scheduled" }); }, "contact_active_engagement"],
  ];
  for (const [label, change, reason] of cases) {
    const { lead, event } = await handedOffNurture();
    change(lead);
    const { json } = await reply(strictBody(event, {}, { ...DRAFT, needs_human: true }));
    assert.deepEqual(json, { ok: true, sent: false, blockedReason: reason }, label);
    assert.equal(executionOf(event).outcome, "blocked", label);
    assert.equal(store.conversations!.every((c) => c.ai_enabled !== false), true, `${label}: a stale needs-human draft never locks`);
    assert.equal(store.ai_interactions!.length, 0, `${label}: no AI record`);
    store.appointments = []; store.estimates = []; store.jobs = []; store.leads = []; store.conversations = [];
  }
  assert.equal(calls.sends, 0);
});

test("11. the contact is gone, B1 cannot read, the organization paused, the automation disabled, AI off for the business, opted out - never sent", async () => {
  const run = async (label: string, change: () => void, expected: Row) => {
    const { event } = await handedOffNurture();
    change();
    const { json } = await reply(strictBody(event));
    assert.deepEqual(json, expected, label);
    store.leads = []; store.conversations = [];
  };
  await run("contact deleted", () => { store.contacts = []; }, { ok: true, sent: false, blockedReason: "contact_not_found" });
  store.contacts = [{ id: CONTACT, organization_id: ORG, first_name: "Riley", phone: "+15550142301", phone_normalized: "+15550142301", sms_opt_out: false }];
  await run("B1 read fails", () => { control.snapshotFails = true; }, { ok: true, failed: true });
  control.snapshotFails = false;
  await run("organization paused", () => { store.organizations![0].automation_paused = true; }, { ok: true, sent: false, blockedReason: "organization_automation_paused" });
  store.organizations![0].automation_paused = false;
  await run("automation disabled", () => { store.automation_settings![0].enabled = false; }, { ok: true, sent: false, blockedReason: "automation_disabled" });
  store.automation_settings![0].enabled = true;
  await run("payment inactive", () => { store.organizations![0].payment_status = "past_due"; }, { ok: true, sent: false, blockedReason: "organization_payment_inactive" });
  store.organizations![0].payment_status = "active";
  await run("AI not allowed to represent the business", () => { control.aiEnabled = false; }, { ok: true, sent: false, blockedReason: "organization_ai_disabled" });
  control.aiEnabled = true;
  await run("opted out", () => { store.contacts![0].sms_opt_out = true; }, { ok: true, sent: false, blockedReason: "contact_opted_out" });
  assert.equal(calls.sends, 0);
});

test("12. reactivation re-checks its own rules after the draft: status, its own open conversation (never recreated), active engagement", async () => {
  const cases: [string, (ctx: { lead: Row; conversation: Row }) => void, string][] = [
    ["status moved to appointment", ({ lead }) => { lead.status = "appointment"; }, "not_eligible_status"],
    ["conversation closed", ({ conversation }) => { conversation.status = "closed"; }, "no_open_conversation"],
    ["appointment on this lead", ({ lead }) => { store.appointments!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: lead.id, status: "scheduled" }); }, "contact_active_engagement"],
  ];
  for (const [label, change, reason] of cases) {
    const ctx = await handedOffReactivation();
    change(ctx);
    const { json } = await reply(strictBody(ctx.event));
    assert.deepEqual(json, { ok: true, sent: false, blockedReason: reason }, label);
    assert.equal(store.conversations!.filter((c) => c.lead_id === ctx.lead.id && c.status === "open").length, label === "conversation closed" ? 0 : 1, `${label}: no conversation created`);
    store.appointments = []; store.leads = []; store.conversations = []; store.messages = [];
  }
  assert.equal(calls.sends, 0);
});

// ---------------------------------------------------------------- identity, duplicates, replay

test("13. identity: unknown execution, another organization, another event, a never-handed-off execution - rejected, nothing recorded or sent", async () => {
  const { lead, event } = await handedOffNurture();
  const execution = executionOf(event);
  assert.equal((await reply(strictBody(event, { execution_id: "00000000-0000-4000-8000-999999999999" }))).status, 404, "unknown execution: no hand-off kind, the legacy path rejects it (unchanged)");
  assert.deepEqual(await reply(strictBody(event, { organization_id: OTHER_ORG })), { status: 403, json: { ok: false, error: "Rejected: organization_mismatch." } });
  assert.deepEqual(await reply(strictBody(event, { event_id: "00000000-0000-4000-8000-999999999998" })), { status: 400, json: { ok: false, error: "Rejected: event_mismatch." } });
  // A real event of the same organization and kind - but not the one this execution was claimed on.
  store.leads = store.leads!.filter((l) => l.id !== lead.id);
  const { event: other } = await handedOffNurture();
  store.leads!.push(lead);
  assert.deepEqual(await reply(strictBody(event, { event_id: other.id })), { status: 400, json: { ok: false, error: "Rejected: event_mismatch." } });
  assert.equal(executionOf(other).status, "running");
  execution.organization_id = OTHER_ORG;
  assert.equal((await reply(strictBody(event))).status, 403, "an execution of another organization");
  execution.organization_id = ORG;
  execution.metadata = {};
  assert.deepEqual(await reply(strictBody(event)), { status: 400, json: { ok: false, error: "Rejected: not_handed_off." } });
  execution.metadata = { handoff: "n8n_draft" };
  assert.deepEqual([execution.status, calls.sends], ["running", 0]);
  assert.equal((await post(strictBody(event), "wrong-secret-value!")).status, 401, "authentication unchanged");
  // The kind cannot be read: fail closed - never the legacy flow (n8n still posts ai_result this phase).
  control.kindReadFails = true;
  const legacyShape = { execution_id: execution.id, event_id: event.id, organization_id: ORG, ai_result: { should_send: true, response_message: "x", qualification_status: "new", missing_information: [], urgency: "normal", needs_human: false, model: "m" } };
  assert.deepEqual(await reply(legacyShape), { status: 500, json: { ok: false, error: "Could not read the automation execution." } });
  control.kindReadFails = false;
  assert.deepEqual([execution.status, calls.sends, trace.includes("gate")], ["running", 0, false]);
});

test("14. duplicates: concurrent callbacks send once (the other is already processed, never a failure); a replay after completion or failure does nothing", async () => {
  const { event } = await handedOffNurture();
  let release: () => void = () => undefined;
  control.sendHeld = new Promise((resolve) => (release = resolve));
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  control.gateBarrier = { arrivals: 0, open, opened };
  const first = reply(strictBody(event));
  const second = reply(strictBody(event));
  const loser = await Promise.race([first, second]);
  assert.equal(control.gateBarrier.arrivals, 2, "both callbacks passed the gate - the real race window");
  control.gateBarrier = null;
  assert.deepEqual(loser.json, { ok: true, alreadyProcessed: true });
  assert.equal(executionOf(event).status, "running", "the loser never failed the owner's execution");
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((r) => JSON.stringify(r.json)).sort(), [JSON.stringify({ ok: true }), JSON.stringify({ ok: true, alreadyProcessed: true })].sort());
  assert.deepEqual([executionOf(event).status, outbound().length, calls.sends], ["completed", 1, 1]);
  assert.deepEqual((await reply(strictBody(event))).json, { ok: true, alreadyProcessed: true }, "replay after completion");
  const { event: failed } = await handedOffNurture();
  await reply(strictBody(failed, {}, { ...DRAFT, model: null }));
  assert.deepEqual((await reply(strictBody(failed))).json, { ok: true, alreadyProcessed: true }, "replay after an AI failure (or a timeout)");
  assert.equal(calls.sends, 1);
});

test("15. the final send is impossible without the gate: an opted-out contact blocks even a perfect draft", async () => {
  const { event } = await handedOffNurture();
  store.contacts![0].sms_opt_out = true;
  const { json } = await reply(strictBody(event));
  assert.deepEqual(json, { ok: true, sent: false, blockedReason: "contact_opted_out" });
  assert.ok(trace.includes("gate"));
  assert.equal(calls.sends, 0);
  // The gate re-checks each kind's own lead rules itself (defence in depth, as before the migration).
  assert.deepEqual(calls.gateInputs.map((g) => [g.executionId, g.leadEligibleStatuses, g.leadMustHaveNoActiveEngagement ?? false]), [[executionOf(event).id, ["lost"], false]]);
  calls.gateInputs = [];
  const { event: reactivation } = await handedOffReactivation();
  await reply(strictBody(reactivation));
  assert.deepEqual(calls.gateInputs.map((g) => [g.executionId, g.leadEligibleStatuses, g.leadMustHaveNoActiveEngagement]), [[executionOf(reactivation).id, LEAD_REACTIVATION_ADAPTER.gateOptions().leadEligibleStatuses, true]]);
});

// ---------------------------------------------------------------- legacy

test("16. legacy automations keep the ai_result flow unchanged: a lead.created callback reaches the legacy gate path", async () => {
  const lead = addLead("new");
  const conversation = { id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: lead.id, channel: "sms", status: "open", ai_enabled: true };
  store.conversations!.push(conversation);
  const event = { id: uuid(), organization_id: ORG, event_type: "lead.created", entity_type: "lead", entity_id: lead.id, payload: { lead_id: lead.id, contact_id: CONTACT, conversation_id: conversation.id }, status: "processing", created_at: NOW.toISOString(), idempotency_key: `lead.created:${lead.id}` };
  store.automation_events!.push(event);
  const execution = { id: uuid(), organization_id: ORG, automation_event_id: event.id, workflow_name: "lead_created_followup", status: "running", attempt: 1, metadata: {} };
  store.workflow_executions!.push(execution);
  const response = await post({ execution_id: execution.id, event_id: event.id, organization_id: ORG, ai_result: { should_send: true, response_message: "Hi Riley, thanks for reaching out!", qualification_status: "new", missing_information: [], urgency: "normal", needs_human: false, model: "claude-sonnet-5", intent: null, summary: null } });
  assert.equal(response.status, 200);
  assert.ok(trace.includes("gate"), "the legacy flow evaluated the gate");
  assert.equal(outbound().length, 1);
  assert.equal(store.ai_interactions![0].interaction_type, "lead_followup_response");
  assert.deepEqual([...DRAFT_HANDOFF_EVENT_TYPES].sort(), [LOST_LEAD_NURTURE_ADAPTER.identity.eventType, LEAD_REACTIVATION_ADAPTER.identity.eventType].sort(), "exactly the two migrated kinds take the draft path");
});
