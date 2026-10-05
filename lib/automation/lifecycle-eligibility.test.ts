/**
 * P0 A3: lifecycle eligibility for lead re-engagement automations.
 *
 * Runs the REAL shared rule (lib/automation/lifecycle-eligibility.ts), the
 * REAL lost-lead nurture and lead reactivation schedulers, the REAL
 * execution functions, and the REAL n8n callback route against an
 * in-memory store whose RPCs mirror the SQL (only a 'running' execution
 * completes; outcome derived like the A2 trigger). n8n, incident recording
 * and business settings are mocked and counted. Nothing reaches TEST,
 * Production, Twilio or n8n.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/lifecycle-eligibility.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const OTHER_CONTACT = "33333333-3333-4333-8333-333333333333";
const SECRET = "test-webhook-secret";

let store: Record<string, Row[]> = {};
let ids = 0;
const calls = { n8n: 0, signals: [] as Row[], sends: 0, gate: 0, founder: 0 };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-30T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
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
mock.module(lib("lib/automation/outbound-gate.ts"), {
  namedExports: {
    evaluateOutboundGate: async () => {
      calls.gate += 1;
      return { allowed: false, reason: "organization_not_live" };
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
const { evaluateLifecycleEligibility, checkLifecycleEligibility } = await import(lib("lib/automation/lifecycle-eligibility.ts"));
const { processLeadNurture } = await import(lib("lib/automation/lead-nurture.ts"));
const { processLeadReactivation } = await import(lib("lib/automation/lead-reactivation.ts"));
const { POST } = await import(lib("app/api/automation/n8n-callback/route.ts"));

beforeEach(() => {
  store = {
    organizations: [{ id: ORG }],
    contacts: [
      { id: CONTACT, organization_id: ORG, first_name: "Riley", last_name: "A3", phone: "+15550142301", email: null, sms_opt_out: false },
      { id: OTHER_CONTACT, organization_id: ORG, first_name: "Other", last_name: "A3", phone: "+15550142302", email: null, sms_opt_out: false },
    ],
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
  };
  ids = 0;
  calls.n8n = 0;
  calls.signals = [];
  calls.sends = 0;
  calls.gate = 0;
  calls.founder = 0;
});

function addLead(status: string, createdDaysAgo: number, extra: Row = {}) {
  const lead = { id: uuid(), organization_id: ORG, contact_id: CONTACT, status, source: "website", service: "Roofing", temperature: "cold", ai_summary: null, estimated_value: null, notes: null, created_at: daysAgo(createdDaysAgo), updated_at: daysAgo(createdDaysAgo), ...extra };
  store.leads!.push(lead);
  return lead;
}
function lostEvent(leadId: string, lostDaysAgo: number) {
  store.automation_events!.push({ id: uuid(), organization_id: ORG, event_type: "lead.lost", entity_type: "lead", entity_id: leadId, payload: {}, idempotency_key: `lead.lost:${leadId}`, status: "completed", created_at: daysAgo(lostDaysAgo) });
}
function conversationFor(leadId: string, lastInboundDaysAgo: number) {
  const conversation = { id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: leadId, channel: "sms", status: "open", ai_enabled: true };
  store.conversations!.push(conversation);
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: conversation.id, direction: "inbound", created_at: daysAgo(lastInboundDaysAgo) });
  return conversation;
}
const executionsFor = (eventType: string) =>
  store.workflow_executions!.filter((e) => store.automation_events!.find((ev) => ev.id === e.automation_event_id)?.event_type === eventType);
const facts = (lead: Row, over: Row = {}) => ({ lead: { id: "L", contact_id: CONTACT, status: "lost", source: "website", created_at: daysAgo(30), ...lead }, contactId: CONTACT, otherOpenLeads: [], activeEngagement: null, ...over }) as never;

// ===========================================================================
// The shared rule (pure)
// ===========================================================================

test("1. the current open lead -> eligible (reactivation); a lost lead with no open lead -> eligible (nurture)", () => {
  assert.deepEqual(evaluateLifecycleEligibility("lead.reactivation", facts({ status: "contacted" })), { eligible: true });
  assert.deepEqual(evaluateLifecycleEligibility("lead.lost_nurture", facts({ status: "lost" })), { eligible: true });
});

test("2. an old open lead with a NEWER open lead -> superseded; an older other open lead does not supersede it", () => {
  const newer = { id: "B", created_at: daysAgo(1) };
  const older = { id: "C", created_at: daysAgo(90) };
  assert.equal(evaluateLifecycleEligibility("lead.reactivation", facts({ status: "contacted" }, { otherOpenLeads: [newer] })).reason, "lead_superseded");
  assert.deepEqual(evaluateLifecycleEligibility("lead.reactivation", facts({ status: "contacted" }, { otherOpenLeads: [older] })), { eligible: true });
});

test("3. a lost lead while the contact has any open lead -> superseded", () => {
  assert.equal(evaluateLifecycleEligibility("lead.lost_nurture", facts({ status: "lost" }, { otherOpenLeads: [{ id: "B", created_at: daysAgo(90) }] })).reason, "lead_superseded");
});

test("5. an sms_inbound lead nobody has qualified -> not eligible for reactivation; once qualified (or for nurture) the source alone does not block", () => {
  assert.equal(evaluateLifecycleEligibility("lead.reactivation", facts({ status: "new", source: "sms_inbound" })).reason, "sms_intake_not_qualified");
  assert.deepEqual(evaluateLifecycleEligibility("lead.reactivation", facts({ status: "contacted", source: "sms_inbound" })), { eligible: true });
  assert.deepEqual(evaluateLifecycleEligibility("lead.reactivation", facts({ status: "new", source: "website" })), { eligible: true });
});

test("6. the contact's active appointment / estimate / job (on any lead) -> contact_active_engagement", () => {
  for (const kind of ["appointment", "estimate", "job"]) {
    const decision = evaluateLifecycleEligibility("lead.lost_nurture", facts({}, { activeEngagement: kind }));
    assert.equal(decision.reason, "contact_active_engagement");
  }
});

test("7. another contact's lead -> lead_contact_mismatch", () => {
  assert.equal(evaluateLifecycleEligibility("lead.lost_nurture", facts({ contact_id: OTHER_CONTACT })).reason, "lead_contact_mismatch");
  assert.equal(evaluateLifecycleEligibility("lead.lost_nurture", facts({ contact_id: null })).reason, "lead_contact_mismatch");
});

test("loader: reads open leads and contact-level engagement from the store (on any lead or none)", async () => {
  const lost = addLead("lost", 60);
  assert.deepEqual(await checkLifecycleEligibility(db as never, ORG, "lead.lost_nurture", lost.id), { eligible: true });
  store.jobs!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: null, status: "scheduled" });
  assert.equal((await checkLifecycleEligibility(db as never, ORG, "lead.lost_nurture", lost.id) as Row).reason, "contact_active_engagement");
  store.jobs![0]!.status = "completed";
  addLead("new", 2);
  assert.equal((await checkLifecycleEligibility(db as never, ORG, "lead.lost_nurture", lost.id) as Row).reason, "lead_superseded");
});

// ===========================================================================
// Lost-lead nurture (real scheduler)
// ===========================================================================

test("nurture: a lost lead alone is still nurtured (unchanged behavior)", async () => {
  const lost = addLead("lost", 60);
  lostEvent(lost.id, 3);
  const result = await processLeadNurture(db as never, NOW);
  assert.equal(result.outcomes[0]!.outcome, "dispatched");
  assert.equal(calls.n8n, 1);
});

test("nurture 3/11/12: lost Lead A + newer open Lead B -> touch recorded as blocked (lead_superseded); nothing dispatched or sent; no escalation; never re-tried", async () => {
  const leadA = addLead("lost", 60);
  addLead("new", 1);
  lostEvent(leadA.id, 3);

  const first = await processLeadNurture(db as never, NOW);
  const second = await processLeadNurture(db as never, NOW);

  assert.deepEqual(first.outcomes[0], { leadId: leadA.id, outcome: "blocked", reason: "lead_superseded" });
  assert.deepEqual(second.outcomes[0], { leadId: leadA.id, outcome: "skipped_duplicate" });
  const [execution] = executionsFor("lead.lost_nurture");
  assert.equal(execution!.status, "completed");
  assert.equal(execution!.outcome, "blocked", "a business block, not a failure");
  assert.equal((execution!.metadata as Row).blocked_reason, "lead_superseded");
  assert.equal(executionsFor("lead.lost_nurture").length, 1);
  assert.equal(calls.n8n, 0);
  assert.equal(calls.sends, 0);
  assert.equal(calls.signals.length, 0, "no incident / escalation");
  assert.equal(calls.founder, 0);
});

test("nurture 6: lost lead while the contact has an active job on another lead -> blocked (contact_active_engagement)", async () => {
  const lost = addLead("lost", 60);
  const won = addLead("won", 30);
  store.jobs!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: won.id, status: "in_progress" });
  lostEvent(lost.id, 3);
  const result = await processLeadNurture(db as never, NOW);
  assert.deepEqual(result.outcomes[0], { leadId: lost.id, outcome: "blocked", reason: "contact_active_engagement" });
  assert.equal(calls.n8n, 0);
});

// ===========================================================================
// Lead reactivation (real scheduler)
// ===========================================================================

test("reactivation: the contact's only open lead, silent 8 days -> still reactivated (unchanged behavior)", async () => {
  const lead = addLead("contacted", 30);
  conversationFor(lead.id, 8);
  const result = await processLeadReactivation(db as never, NOW);
  assert.equal(result.outcomes[0]!.outcome, "dispatched");
  assert.equal(calls.n8n, 1);
});

test("reactivation 4: old open Lead A (conversation still on it) + a newer open Lead B -> blocked (lead_superseded), nothing sent", async () => {
  const leadA = addLead("contacted", 30);
  conversationFor(leadA.id, 8);
  addLead("new", 1, { source: "manual" });
  const result = await processLeadReactivation(db as never, NOW);
  const outcome = result.outcomes.find((o: Row) => o.leadId === leadA.id);
  assert.deepEqual(outcome, { leadId: leadA.id, outcome: "blocked", reason: "lead_superseded" });
  assert.equal(calls.n8n, 0);
  assert.equal(executionsFor("lead.reactivation")[0]!.outcome, "blocked");
});

test("reactivation 5: a new sms_inbound lead (closed-only history) silent 8 days -> not reactivated (sms_intake_not_qualified)", async () => {
  addLead("lost", 200);
  const sms = addLead("new", 9, { source: "sms_inbound" });
  conversationFor(sms.id, 8);
  const result = await processLeadReactivation(db as never, NOW);
  assert.deepEqual(result.outcomes.find((o: Row) => o.leadId === sms.id), { leadId: sms.id, outcome: "blocked", reason: "sms_intake_not_qualified" });
  assert.equal(calls.n8n, 0);
});

test("reactivation 6: the contact has an upcoming appointment on another lead -> blocked (contact_active_engagement)", async () => {
  const lead = addLead("contacted", 30);
  conversationFor(lead.id, 8);
  store.appointments!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: null, status: "scheduled" });
  const result = await processLeadReactivation(db as never, NOW);
  assert.deepEqual(result.outcomes[0], { leadId: lead.id, outcome: "blocked", reason: "contact_active_engagement" });
  assert.equal(calls.n8n, 0);
});

// ===========================================================================
// n8n callback re-check (a newer lead appeared after dispatch)
// ===========================================================================

function dispatchedTouch(eventType: string, leadId: string) {
  const event = { id: uuid(), organization_id: ORG, event_type: eventType, entity_type: "lead", entity_id: leadId, payload: { lead_id: leadId, contact_id: CONTACT, conversation_id: null }, status: "processing" };
  store.automation_events!.push(event);
  const execution: Row = { id: uuid(), organization_id: ORG, automation_event_id: event.id, workflow_name: "lead_lost_nurture_followup", status: "running", attempt: 1, metadata: {}, automation_events: event };
  store.workflow_executions!.push(execution);
  return { event, execution };
}
const callback = (execution: Row, event: Row, aiResult: Row) =>
  POST(
    new Request("https://preview.example/api/automation/n8n-callback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trackpr-webhook-secret": SECRET },
      body: JSON.stringify({ execution_id: execution.id, event_id: event.id, organization_id: ORG, ai_result: aiResult }),
    }) as never,
  ) as Promise<Response>;
const AI = { should_send: true, response_message: "Hi Riley, just checking in.", qualification_status: "qualifying", missing_information: [], urgency: "normal", needs_human: true, model: "claude-sonnet-5", intent: null, summary: "check-in" };

test("callback 11/12: a nurture touch whose lead was superseded after dispatch -> blocked before any AI handling: no lock, no escalation, no AI record, no send", async () => {
  const leadA = addLead("lost", 60);
  const conversation = { id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: leadA.id, channel: "sms", status: "open", ai_enabled: true };
  store.conversations!.push(conversation);
  const { event, execution } = dispatchedTouch("lead.lost_nurture", leadA.id);
  addLead("new", 0); // the customer came back meanwhile

  const json = await (await callback(execution, event, AI)).json();

  assert.deepEqual(json, { ok: true, sent: false, blockedReason: "lead_superseded" });
  assert.equal(execution.outcome, "blocked");
  assert.equal(conversation.ai_enabled, true, "needs_human from a stale touch never locks the conversation");
  assert.equal(calls.founder, 0);
  assert.equal(calls.signals.length, 0);
  assert.equal(store.ai_interactions!.length, 0);
  assert.equal(calls.gate + calls.sends, 0);
});

test("callback: an eligible touch still flows to the normal path (gate evaluated)", async () => {
  const lead = addLead("lost", 60);
  store.conversations!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: lead.id, channel: "sms", status: "open", ai_enabled: true });
  const { event, execution } = dispatchedTouch("lead.lost_nurture", lead.id);
  await callback(execution, event, { ...AI, needs_human: false });
  assert.equal(calls.gate, 1, "reached the unchanged outbound gate");
});
