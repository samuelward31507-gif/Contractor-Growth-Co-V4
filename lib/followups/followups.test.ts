/**
 * P0 A4: the Follow-Up Engine.
 *
 * Runs the REAL engine (lib/followups), the REAL A3 lifecycle rule, the REAL
 * outbound gate, the REAL automation-event and execution functions, the
 * REAL A2 classifier + retry path and the REAL TEST-only "Run now" server
 * action against an in-memory store whose writes mirror the SQL:
 *   followups               unique (lead_id, stage); column defaults
 *   create_automation_event idempotency key per organization (is_duplicate)
 *   start_workflow_execution refuses an event already processing/completed;
 *                            numbers the attempt max+1
 *   complete/fail_workflow_execution only a 'running' row transitions;
 *                            outcome derived like the A2 trigger
 * The SMS provider, n8n, incident recording and business settings are
 * mocked and counted. Nothing reaches TEST, Production, Twilio or n8n.
 * RLS (tests 30-31) is proven against real Postgres by
 * supabase/pending/scratch/validate-followups.mjs; this file also asserts
 * the migration's policies/grants statically.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/followups/followups.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const OTHER_CONTACT = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const HOUR = 60 * 60 * 1000;
// Monday 2026-11-02 15:00 UTC.
const T0 = new Date("2026-11-02T15:00:00.000Z");
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

let store: Record<string, Row[]> = {};
let ids = 0;
let clock = T0;
const calls = { sends: 0, signals: [] as Row[], n8n: 0 };
const control = { sendOk: true, admin: true, hours: [] as Row[] };

function deriveOutcome(row: Row) {
  const metadata = (row.metadata ?? {}) as Row;
  row.outcome = row.status === "running" ? null : row.status === "completed" ? (metadata.blocked_reason ? "blocked" : "succeeded") : row.status === "failed" ? "failed" : null;
}
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

const DEFAULTS: Record<string, () => Row> = {
  followups: () => ({ state: "pending", waiting_on: "customer", next_action: "send_followup", next_action_at: null, attempt_count: 0, lease_until: null, paused_reason: null, exit_reason: null, last_execution_id: null, reactivated_at: null, created_at: clock.toISOString() }),
  conversations: () => ({ status: "open", ai_enabled: true }),
};

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private insertRows: Row[] | null = null;
  private sortBy: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private head = false;
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  select(_c?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.head = true;
    return this;
  }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, op: string, v: unknown) { this.filters.push((r) => (op === "is" ? (r[c] ?? null) !== v : true)); return this; }
  or(expr: string) {
    const parts = expr.split(",").map((part) => part.split("."));
    this.filters.push((r) => parts.some(([c, op, v]) => op === "eq" && String(r[c]) === v));
    return this;
  }
  gt(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) > v); return this; }
  gte(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) >= v); return this; }
  lt(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) < v); return this; }
  lte(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) <= v); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.sortBy = { column: c, ascending: o?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  update(v: Row) { this.updateValues = v; return this; }
  insert(v: Row | Row[]) { this.insertRows = Array.isArray(v) ? v : [v]; return this; }
  single() { return this.run(true); }
  maybeSingle() { return this.run(true); }
  then<T>(resolve: (v: { data: unknown; error: unknown; count?: number }) => T, reject?: (e: unknown) => T) { return this.run(false).then(resolve, reject); }
  private async run(single: boolean): Promise<{ data: unknown; error: unknown; count?: number }> {
    const rows = (store[this.table] ??= []);
    if (this.insertRows) {
      const inserted: Row[] = this.insertRows.map((r) => ({ id: uuid(), ...(DEFAULTS[this.table]?.() ?? {}), ...r }));
      if (this.table === "followups") {
        for (const r of inserted) {
          if (rows.some((x) => x.lead_id === r.lead_id && x.stage === r.stage)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint followups_lead_stage_unique" } };
        }
      }
      rows.push(...inserted);
      return { data: single ? { ...inserted[0] } : inserted.map((r) => ({ ...r })), error: null };
    }
    let matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.updateValues) for (const r of matched) Object.assign(r, this.updateValues);
    if (this.head) return { data: null, error: null, count: matched.length };
    if (this.sortBy) {
      const { column, ascending } = this.sortBy;
      matched = [...matched].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (ascending ? 1 : -1));
    }
    if (this.max !== null) matched = matched.slice(0, this.max);
    const copy = matched.map((r) => ({ ...r }));
    return { data: single ? (copy[0] ?? null) : copy, error: null };
  }
}

function rpc(name: string, args: Row) {
  const run = async () => {
    const executions = (store.workflow_executions ??= []);
    const events = (store.automation_events ??= []);
    if (name === "is_org_admin") return { data: control.admin, error: null };
    if (name === "create_automation_event") {
      const existing = events.find((e) => e.organization_id === args.p_organization_id && e.idempotency_key === args.p_idempotency_key);
      if (existing) return { data: { ...existing, is_duplicate: true }, error: null };
      const event = { id: uuid(), organization_id: args.p_organization_id, event_type: args.p_event_type, entity_type: args.p_entity_type, entity_id: args.p_entity_id, payload: args.p_payload, idempotency_key: args.p_idempotency_key, status: "pending", created_at: clock.toISOString() };
      events.push(event);
      return { data: { ...event, is_duplicate: false }, error: null };
    }
    if (name === "start_workflow_execution") {
      const event = events.find((e) => e.id === args.p_automation_event_id);
      if (!event) return { data: null, error: { message: "Automation event not found" } };
      if (event.status === "processing") return { data: null, error: { message: "Automation event is already being processed" } };
      if (event.status === "completed") return { data: null, error: { message: "Automation event has already completed" } };
      const attempt = Math.max(0, ...executions.filter((e) => e.automation_event_id === event.id).map((e) => Number(e.attempt))) + 1;
      const row: Row = { id: uuid(), organization_id: event.organization_id, automation_event_id: event.id, workflow_name: args.p_workflow_name, status: "running", attempt, started_at: clock.toISOString(), completed_at: null, error_message: null, metadata: args.p_metadata ?? {}, trigger_source: args.p_trigger_source, retry_state: null, next_retry_at: null, max_attempts: null, retry_detail: null };
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
      Object.assign(execution, { status: "completed", metadata: args.p_metadata ?? {}, completed_at: clock.toISOString() });
      if (event?.status === "processing") event.status = "completed";
    } else if (name === "fail_workflow_execution") {
      Object.assign(execution, { status: "failed", error_message: args.p_error_message, completed_at: clock.toISOString() });
      if (event?.status === "processing") event.status = "failed";
    } else return { data: null, error: { message: `unexpected rpc ${name}` } };
    deriveOutcome(execution);
    return { data: { ...execution }, error: null };
  };
  return { single: run, then: <T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) => run().then(resolve, reject) };
}

const db = { from: (t: string) => new Query(t), rpc, auth: { getUser: async () => ({ data: { user: { id: USER } } }) } };

const realNextServer = await import("next/server");
mock.module("next/server", { namedExports: { ...realNextServer, after: (fn: () => unknown) => void fn() } });
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("next/navigation", { namedExports: { redirect: (to: string) => { throw new Error(`redirect ${to}`); } } });
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => db } });
mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => db } });
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
      store.messages!.push({ id: uuid(), organization_id: input.organizationId, conversation_id: input.conversationId, workflow_execution_id: input.workflowExecutionId, direction: "outbound", created_at: clock.toISOString() });
      return control.sendOk ? { ok: true, messageId: "m", conversationId: input.conversationId, providerMessageId: "SM" } : { ok: false, error: "Twilio error 30003", messageId: null, conversationId: null };
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
const realSettings = await import(lib("lib/settings/queries.ts"));
mock.module(lib("lib/settings/queries.ts"), {
  namedExports: {
    ...realSettings,
    getBusinessProfile: async () => ({ name: "QA Fixture Roofing", timezone: "UTC" }),
    getBusinessHours: async () => control.hours,
    getOrganizationTimezone: async () => "UTC",
    getAiSettings: async () => ({ ai_enabled: true }),
  },
});

process.env.VERCEL_ENV = "preview";
const engine = await import(lib("lib/followups/engine.ts"));
const { ensureLeadFollowup, reactivateLeadFollowup } = await import(lib("lib/followups/producer.ts"));
const { transitionFollowup } = await import(lib("lib/followups/store.ts"));
const { canTransition, FOLLOWUP_TRANSITIONS, isTerminal } = await import(lib("lib/followups/state.ts"));
const { FOLLOWUP_CADENCE_HOURS, touchDueAt } = await import(lib("lib/followups/config.ts"));
const { classifyFailedExecutions, processDueRetries } = await import(lib("lib/automation/execution-retry.ts"));
const { buildFollowupAttentionItem, loadAutomationAttention } = await import(lib("lib/automation/execution-visibility.ts"));
const { runFollowupNow } = await import(lib("app/(app)/leads/actions.ts"));
const { dispatchFollowup, dispatchDueFollowups, nextBusinessOpening } = engine;

beforeEach(() => {
  store = {
    organizations: [
      { id: ORG, automation_mode: "live", payment_status: "active", automation_paused: false, name: "QA Fixture Roofing", vertical: "contractor" },
      { id: OTHER_ORG, automation_mode: "live", payment_status: "active", automation_paused: false },
    ],
    organization_members: [{ organization_id: ORG, user_id: USER, role: "owner", organizations: { name: "QA Fixture Roofing", payment_status: "active", vertical: "contractor" } }],
    contacts: [
      { id: CONTACT, organization_id: ORG, first_name: "Riley", phone: "+15550142301", phone_normalized: "+15550142301", sms_opt_out: false },
      { id: OTHER_CONTACT, organization_id: ORG, first_name: "Other", phone: "+15550142302", phone_normalized: "+15550142302", sms_opt_out: false },
    ],
    automation_settings: [{ organization_id: ORG, automation_id: "lead-followup-sequence", enabled: true }],
    leads: [],
    followups: [],
    conversations: [],
    messages: [],
    appointments: [],
    estimates: [],
    jobs: [],
    automation_events: [],
    workflow_executions: [],
  };
  ids = 100;
  clock = T0;
  calls.sends = 0;
  calls.signals = [];
  calls.n8n = 0;
  control.sendOk = true;
  control.admin = true;
  control.hours = [];
});

type Entity = Row & { id: string };

function addLead(extra: Row = {}): Entity {
  const lead = { id: uuid(), organization_id: ORG, contact_id: CONTACT, status: "new", source: "website", service: "Roofing", created_at: clock.toISOString(), ...extra };
  store.leads!.push(lead);
  return lead;
}
async function newFollowup(extra: Row = {}) {
  const lead = addLead(extra);
  const result = await ensureLeadFollowup(db as never, { organizationId: ORG, leadId: lead.id, now: clock });
  assert.equal(result.outcome, "created");
  return { lead, followup: fu(result.followup.id) };
}
const fu = (id: string) => store.followups!.find((f) => f.id === id)! as Entity;
const touchEvents = () => store.automation_events!.filter((e) => e.event_type === "followup.touch");
const touchExecutions = () => store.workflow_executions!.filter((e) => e.workflow_name === "lead_followup_touch");
const quiet = async <T>(fn: () => Promise<T>) => {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};
const WEEKDAYS_9_TO_17 = ["monday", "tuesday", "wednesday", "thursday", "friday"].map((day) => ({ day_of_week: day, is_open: true, open_time: "09:00", close_time: "17:00" }));

// ===========================================================================
// Data / state
// ===========================================================================

test("1. follow-up creation: a new lead gets one scheduled follow-up, first touch due at +24h, waiting on the customer", async () => {
  const { lead, followup } = await newFollowup();
  assert.equal(followup.organization_id, ORG);
  assert.equal(followup.lead_id, lead.id);
  assert.equal(followup.stage, "lead_no_reply");
  assert.equal(followup.state, "scheduled");
  assert.equal(followup.waiting_on, "customer");
  assert.equal(followup.next_action, "send_followup");
  assert.equal(followup.next_action_at, at(24).toISOString());
  assert.equal(followup.attempt_count, 0);
  assert.equal(calls.sends, 0, "a producer never sends");
  assert.equal(touchEvents().length, 0, "a producer never dispatches");
});

test("1b. default-off: with the automation not enabled, the producer records nothing", async () => {
  store.automation_settings = [];
  const lead = addLead();
  assert.deepEqual(await ensureLeadFollowup(db as never, { organizationId: ORG, leadId: lead.id, now: clock }), { outcome: "disabled" });
  assert.equal(store.followups!.length, 0);
});

test("2/21. repeated producer calls are idempotent: one record per lead + stage", async () => {
  const { lead, followup } = await newFollowup();
  const again = await ensureLeadFollowup(db as never, { organizationId: ORG, leadId: lead.id, now: at(1) });
  const third = await ensureLeadFollowup(db as never, { organizationId: ORG, leadId: lead.id, now: at(2) });
  assert.equal(again.outcome, "existing");
  assert.equal(third.outcome, "existing");
  assert.equal(again.followup.id, followup.id);
  assert.equal(store.followups!.length, 1);
  assert.equal(fu(followup.id).next_action_at, at(24).toISOString(), "the schedule is not reset by a repeat");
});

test("3. state transitions: the explicit table is enforced, terminal states have none, and a write is conditional on the current state", async () => {
  assert.ok(canTransition("pending", "scheduled"));
  assert.ok(canTransition("scheduled", "processing"));
  assert.ok(canTransition("processing", "failed"));
  assert.ok(canTransition("failed", "scheduled"));
  assert.ok(!canTransition("pending", "processing"), "pending must be scheduled first");
  assert.ok(!canTransition("completed", "scheduled"));
  assert.ok(!canTransition("exited", "scheduled"));
  assert.ok(!canTransition("paused", "processing"), "paused is never dispatched directly");
  assert.ok(isTerminal("completed") && isTerminal("exited"));
  assert.deepEqual(Object.keys(FOLLOWUP_TRANSITIONS).sort(), ["completed", "exited", "failed", "paused", "pending", "processing", "scheduled"]);

  const { followup } = await newFollowup();
  await assert.rejects(transitionFollowup(db as never, { ...followup, state: "completed" } as never, "scheduled"), /illegal transition/);
  // A stale writer (thinks the row is still 'pending') changes nothing.
  assert.equal(await transitionFollowup(db as never, { ...followup, state: "pending" } as never, "exited"), null);
  assert.equal(fu(followup.id).state, "scheduled");
});

test("4/5. next-action scheduling + attempt incrementing: each touch advances to the next cadence step, then the cadence completes", async () => {
  const { followup } = await newFollowup();
  assert.deepEqual(FOLLOWUP_CADENCE_HOURS.lead_no_reply, [24, 72, 168]);
  for (const [touch, due, next] of [[1, 24, 72], [2, 72, 168]] as const) {
    clock = at(due);
    const outcome = await dispatchFollowup(db as never, followup.id, clock);
    assert.equal(outcome.outcome, "sent");
    assert.equal(fu(followup.id).attempt_count, touch);
    assert.equal(fu(followup.id).state, "scheduled");
    assert.equal(fu(followup.id).next_action_at, at(next).toISOString());
    assert.equal(fu(followup.id).lease_until, null);
  }
  clock = at(168);
  assert.equal((await dispatchFollowup(db as never, followup.id, clock)).outcome, "sent");
  const done = fu(followup.id);
  assert.equal(done.attempt_count, 3);
  assert.equal(done.state, "completed");
  assert.equal(done.exit_reason, "cadence_complete");
  assert.equal(done.next_action, "none");
  assert.equal(done.next_action_at, null);
  assert.equal(calls.sends, 3);
  assert.equal(touchDueAt(T0, "lead_no_reply", 4), null);
});

test("6. pause: a touch more than 48 hours late is paused as dormant - never sent late; reactivation reschedules from now, not 'overdue now'", async () => {
  const { lead, followup } = await newFollowup();
  clock = at(24 + 49);
  const outcome = await dispatchFollowup(db as never, followup.id, clock);
  assert.deepEqual(outcome, { followupId: followup.id, outcome: "paused", reason: "dormant" });
  assert.equal(fu(followup.id).state, "paused");
  assert.equal(fu(followup.id).paused_reason, "dormant");
  assert.equal(calls.sends, 0);
  assert.equal(touchEvents().length, 0, "nothing recorded - the touch is still owed if the lead comes back");
  // A paused follow-up is not picked up by later ticks.
  assert.equal((await dispatchDueFollowups(db as never, at(24 * 30))).length, 0);

  clock = at(24 * 30);
  const reactivated = await reactivateLeadFollowup(db as never, { organizationId: ORG, leadId: lead.id, now: clock });
  assert.equal(reactivated.state, "scheduled");
  assert.equal(reactivated.next_action_at, at(24 * 30 + 24).toISOString(), "rescheduled one cadence step ahead");
  assert.equal(reactivated.reactivated_at, clock.toISOString());
  assert.equal(reactivated.attempt_count, 0, "state (attempts) is kept across dormancy");
  assert.equal(calls.sends, 0);
});

test("7. completion: an inbound customer reply since the follow-up began completes it - no touch", async () => {
  const { followup } = await newFollowup();
  store.conversations!.push({ id: "conv-1", organization_id: ORG, contact_id: CONTACT, lead_id: followup.lead_id, channel: "sms", status: "open", ai_enabled: true });
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: "conv-1", direction: "inbound", created_at: at(3).toISOString() });
  clock = at(24);
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, clock), { followupId: followup.id, outcome: "completed", reason: "customer_replied" });
  assert.equal(fu(followup.id).state, "completed");
  assert.equal(fu(followup.id).waiting_on, "none");
  assert.equal(calls.sends, 0);
  assert.equal(touchEvents().length, 0);
});

test("8. exit: the lead was closed (won/lost) - the follow-up exits", async () => {
  const { lead, followup } = await newFollowup();
  lead.status = "lost";
  clock = at(24);
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, clock), { followupId: followup.id, outcome: "exited", reason: "lead_closed" });
  assert.equal(fu(followup.id).state, "exited");
  assert.equal(fu(followup.id).exit_reason, "lead_closed");
  assert.equal(calls.sends, 0);
});

// ===========================================================================
// Dispatcher
// ===========================================================================

test("9. a due follow-up is claimed (leased) and dispatched by the tick", async () => {
  const { followup } = await newFollowup();
  clock = at(24);
  const outcomes = await dispatchDueFollowups(db as never, clock);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, "sent");
  assert.equal(touchExecutions().length, 1);
  assert.equal(touchExecutions()[0].outcome, "succeeded");
  assert.equal(fu(followup.id).last_execution_id, touchExecutions()[0].id);
});

test("10. concurrent dispatch: two workers on the same follow-up - exactly one claims it, one touch, one send", async () => {
  const { followup } = await newFollowup();
  clock = at(24);
  const [a, b] = await Promise.all([dispatchFollowup(db as never, followup.id, clock), dispatchFollowup(db as never, followup.id, clock)]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ["not_claimed", "sent"]);
  assert.equal(touchEvents().length, 1);
  assert.equal(touchExecutions().length, 1);
  assert.equal(calls.sends, 1);
  assert.equal(fu(followup.id).attempt_count, 1);
});

test("11. a follow-up that is not yet due is ignored", async () => {
  const { followup } = await newFollowup();
  clock = at(23);
  assert.equal((await dispatchDueFollowups(db as never, clock)).length, 0);
  assert.equal((await dispatchFollowup(db as never, followup.id, clock)).outcome, "not_claimed");
  assert.equal(fu(followup.id).state, "scheduled");
  assert.equal(touchEvents().length, 0);
});

test("12. an already-processing follow-up (live lease) is not duplicated", async () => {
  const { followup } = await newFollowup();
  Object.assign(fu(followup.id), { state: "processing", lease_until: at(24.1).toISOString() });
  clock = at(24);
  assert.equal((await dispatchDueFollowups(db as never, clock)).length, 0);
  assert.equal((await dispatchFollowup(db as never, followup.id, clock)).outcome, "not_claimed");
  assert.equal(touchEvents().length, 0);
  assert.equal(calls.sends, 0);
});

test("13/14. completed and exited follow-ups are ignored (by the tick and by a direct dispatch)", async () => {
  const done = (await newFollowup()).followup;
  const gone = (await newFollowup({ contact_id: OTHER_CONTACT })).followup;
  Object.assign(fu(done.id), { state: "completed", next_action_at: null });
  Object.assign(fu(gone.id), { state: "exited", next_action_at: null });
  clock = at(24 * 10);
  assert.equal((await dispatchDueFollowups(db as never, clock)).length, 0);
  assert.equal((await dispatchFollowup(db as never, done.id, clock, { runNow: true })).outcome, "not_claimed");
  assert.equal((await dispatchFollowup(db as never, gone.id, clock, { runNow: true })).outcome, "not_claimed");
  assert.equal(touchEvents().length, 0);
});

// ===========================================================================
// Business hours
// ===========================================================================

test("15/16. outside business hours: deferred to the next opening, attempt NOT consumed, nothing recorded; sent at the opening", async () => {
  control.hours = WEEKDAYS_9_TO_17;
  // Created Friday 20:00 UTC -> first touch due Saturday 20:00 -> next opening Monday 09:00.
  clock = new Date("2026-11-06T20:00:00.000Z");
  const { followup } = await newFollowup();
  clock = new Date("2026-11-07T20:00:00.000Z");
  const outcome = await dispatchFollowup(db as never, followup.id, clock);
  assert.deepEqual(outcome, { followupId: followup.id, outcome: "deferred", until: "2026-11-09T09:00:00.000Z" });
  assert.equal(fu(followup.id).state, "scheduled");
  assert.equal(fu(followup.id).next_action_at, "2026-11-09T09:00:00.000Z");
  assert.equal(fu(followup.id).attempt_count, 0, "16: deferral does not consume an attempt");
  assert.equal(touchEvents().length, 0, "16: the touch's idempotency key is not used up");
  assert.equal(touchExecutions().length, 0, "deferral is not a failure or a block");

  clock = new Date("2026-11-09T09:00:00.000Z");
  // The gate's own business-hours check reads the process clock (in production the same real clock the
  // dispatcher uses) - set it to the dispatcher's moment, not the suite's pinned 18:00 UTC.
  mock.timers.enable({ apis: ["Date"], now: clock });
  try {
    assert.equal((await dispatchFollowup(db as never, followup.id, clock)).outcome, "sent", "a weekend deferral is not mistaken for dormancy");
  } finally {
    mock.timers.reset();
  }
  assert.equal(fu(followup.id).attempt_count, 1);
});

test("15c. Final Batch 1: the quiet-hours floor defers a due touch overnight even with no business hours configured - not consumed, nothing recorded - and it sends at 08:00", async () => {
  control.hours = [];
  // Created Monday 22:30 UTC -> first touch due Tuesday 22:30 UTC, inside the floor (UTC organization).
  clock = new Date("2026-11-02T22:30:00.000Z");
  const { followup } = await newFollowup();
  clock = new Date("2026-11-03T22:30:00.000Z");
  const outcome = await dispatchFollowup(db as never, followup.id, clock);
  assert.deepEqual(outcome, { followupId: followup.id, outcome: "deferred", until: "2026-11-04T08:00:00.000Z" });
  assert.equal(fu(followup.id).attempt_count, 0);
  assert.equal(touchEvents().length, 0, "the touch's key is not used up");
  assert.equal(touchExecutions().length, 0);

  clock = new Date("2026-11-04T08:00:00.000Z");
  assert.equal((await dispatchFollowup(db as never, followup.id, clock)).outcome, "sent");
  assert.equal(fu(followup.id).attempt_count, 1);
});

test("15b. next opening helper: inside hours is now; no configured hours is always open; closed all week has no opening", () => {
  const monday10 = new Date("2026-11-02T10:00:00.000Z");
  assert.equal(nextBusinessOpening(monday10, "UTC", WEEKDAYS_9_TO_17).toISOString(), monday10.toISOString());
  assert.equal(nextBusinessOpening(new Date("2026-11-02T17:05:00.000Z"), "UTC", WEEKDAYS_9_TO_17).toISOString(), "2026-11-03T09:00:00.000Z");
  assert.equal(nextBusinessOpening(new Date("2026-11-07T03:00:00.000Z"), "UTC", []).toISOString(), "2026-11-07T03:00:00.000Z");
  assert.equal(nextBusinessOpening(monday10, "UTC", [{ day_of_week: "monday", is_open: false, open_time: null, close_time: null }]), null);
});

// ===========================================================================
// Lifecycle (A3 reuse)
// ===========================================================================

test("17. a newer open lead for the same customer supersedes the old follow-up - exits, no touch", async () => {
  const { followup } = await newFollowup();
  clock = at(2);
  addLead();
  clock = at(24);
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, clock), { followupId: followup.id, outcome: "exited", reason: "lead_superseded" });
  assert.equal(calls.sends, 0);
  assert.equal(touchEvents().length, 0);
});

test("18. active customer engagement (a scheduled appointment on any lead) exits the follow-up", async () => {
  const { followup } = await newFollowup();
  store.appointments!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: null, status: "scheduled" });
  clock = at(24);
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, clock), { followupId: followup.id, outcome: "exited", reason: "contact_active_engagement" });
  assert.equal(calls.sends, 0);
});

test("19. wrong-contact data is blocked: a lead with no contact exits (lead_contact_mismatch) before anything is recorded", async () => {
  const { followup } = await newFollowup({ contact_id: null });
  clock = at(24);
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, clock), { followupId: followup.id, outcome: "exited", reason: "lead_contact_mismatch" });
  assert.equal(touchEvents().length, 0);
  assert.equal(calls.sends, 0);
});

test("20. the A3 lifecycle rule is reused, not duplicated: the engine calls checkLifecycleEligibility with 'followup.touch'; the rule owns lead_closed", async () => {
  const source = readFileSync(path.join(process.cwd(), "lib/followups/engine.ts"), "utf8");
  assert.match(source, /checkLifecycleEligibility\(service, row\.organization_id, FOLLOWUP_EVENT_TYPE, row\.lead_id\)/);
  assert.doesNotMatch(source, /otherOpenLeads|ACTIVE_APPOINTMENT_STATUSES|lead_superseded/, "no copy of A3's superseded/active-engagement logic");
  const { evaluateLifecycleEligibility } = await import(lib("lib/automation/lifecycle-eligibility.ts"));
  const facts = (status: string) => ({ lead: { id: "L", contact_id: CONTACT, status, source: "website", created_at: T0.toISOString() }, contactId: CONTACT, otherOpenLeads: [], activeEngagement: null });
  assert.equal(evaluateLifecycleEligibility("followup.touch", facts("won")).reason, "lead_closed");
  assert.deepEqual(evaluateLifecycleEligibility("followup.touch", facts("contacted")), { eligible: true });
  assert.deepEqual(evaluateLifecycleEligibility("lead.lost_nurture", facts("lost")), { eligible: true }, "the new case does not change A3's existing automations");
});

// ===========================================================================
// Idempotency
// ===========================================================================

test("22. duplicate dispatcher ticks produce one execution and one send", async () => {
  await newFollowup();
  clock = at(24);
  await dispatchDueFollowups(db as never, clock);
  await dispatchDueFollowups(db as never, clock);
  await dispatchDueFollowups(db as never, at(24.5));
  assert.equal(touchEvents().length, 1);
  assert.equal(touchExecutions().length, 1);
  assert.equal(calls.sends, 1);
});

test("23. a late/repeated run after a crash cannot create a second send: the reclaimed touch finds its idempotency key and advances", async () => {
  const { followup } = await newFollowup();
  clock = at(24);
  await dispatchFollowup(db as never, followup.id, clock);
  assert.equal(calls.sends, 1);
  // Simulate the worker dying after the send but before it released the row.
  Object.assign(fu(followup.id), { state: "processing", lease_until: at(24.1).toISOString(), attempt_count: 0, next_action_at: at(24).toISOString() });
  clock = at(25);
  const [outcome] = await dispatchDueFollowups(db as never, clock);
  assert.deepEqual(outcome, { followupId: followup.id, outcome: "blocked", touch: 1, reason: "duplicate_touch" });
  assert.equal(calls.sends, 1, "no second send");
  assert.equal(touchExecutions().length, 1, "no second execution");
  assert.equal(fu(followup.id).attempt_count, 1);
  assert.equal(fu(followup.id).next_action_at, at(72).toISOString());
});

// ===========================================================================
// A2
// ===========================================================================

test("24. a retryable send failure flows through the existing A2 retry path and the follow-up advances on success", async () => {
  const { followup } = await newFollowup();
  control.sendOk = false;
  clock = at(24);
  const outcome = await dispatchFollowup(db as never, followup.id, clock);
  assert.equal(outcome.outcome, "failed");
  const [first] = touchExecutions();
  assert.equal(first.status, "failed");
  assert.equal(first.outcome, "failed");
  assert.equal(fu(followup.id).state, "failed");
  assert.equal(fu(followup.id).next_action, "retry");
  assert.equal(fu(followup.id).attempt_count, 0);

  await classifyFailedExecutions(db as never, clock);
  assert.equal(first.retry_state, "scheduled");
  control.sendOk = true;
  clock = at(25);
  const due = await processDueRetries(db as never, clock);
  assert.equal(due.started.length, 1);
  const retried = touchExecutions().find((e) => e.attempt === 2)!;
  assert.equal(retried.trigger_source, "retry");
  assert.equal(retried.outcome, "succeeded");
  assert.equal(first.retry_state, "retried");
  assert.equal(fu(followup.id).state, "scheduled");
  assert.equal(fu(followup.id).attempt_count, 1);
  assert.equal(fu(followup.id).last_execution_id, retried.id);
  assert.equal(calls.sends, 2, "one failed attempt, one successful retry");
});

test("25. a failure that is not retryable (policy ceiling reached) does not retry again", async () => {
  const { followup } = await newFollowup();
  control.sendOk = false;
  clock = at(24);
  await dispatchFollowup(db as never, followup.id, clock);
  for (let i = 0; i < 4; i += 1) {
    await classifyFailedExecutions(db as never, clock);
    clock = new Date(clock.getTime() + 2 * HOUR);
    await processDueRetries(db as never, clock);
  }
  const attempts = touchExecutions().map((e) => e.attempt).sort();
  assert.deepEqual(attempts, [1, 2, 3], "maxAttempts 3 - never a fourth");
  assert.equal(touchExecutions().find((e) => e.attempt === 3)!.retry_state, "exhausted");
  assert.equal(fu(followup.id).state, "failed");
});

test("26. a block/exit is recorded as blocked (outcome 'blocked'), never failed, and opens no incident", async () => {
  store.organizations![0].automation_mode = "test";
  const { followup } = await newFollowup();
  clock = at(24);
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, clock), { followupId: followup.id, outcome: "blocked", touch: 1, reason: "organization_not_live" });
  const [execution] = touchExecutions();
  assert.equal(execution.status, "completed");
  assert.equal(execution.outcome, "blocked");
  assert.equal((execution.metadata as Row).blocked_reason, "organization_not_live");
  assert.equal(calls.sends, 0);
  assert.equal(calls.signals.length, 0, "no failure incident");
  await classifyFailedExecutions(db as never, clock);
  assert.equal(execution.retry_state, null, "a blocked touch is not a retry candidate");
  // TEST mode consumes the touch (recorded, not sent) and moves on.
  assert.equal(fu(followup.id).attempt_count, 1);
  assert.equal(fu(followup.id).state, "scheduled");

  // An opted-out customer: the gate's compliance block exits the follow-up for good.
  store.organizations![0].automation_mode = "live";
  store.contacts![0].sms_opt_out = true;
  clock = at(72);
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, clock), { followupId: followup.id, outcome: "exited", reason: "contact_opted_out" });
  assert.equal(touchExecutions()[1].outcome, "blocked");
  assert.equal(calls.sends, 0);
});

test("26b. automation turned off (or organization automation paused) after scheduling: held, unconsumed - not a block or failure", async () => {
  const { followup } = await newFollowup();
  store.automation_settings![0].enabled = false;
  clock = at(24);
  assert.equal((await dispatchFollowup(db as never, followup.id, clock)).outcome, "skipped_disabled");
  assert.equal(fu(followup.id).state, "scheduled");
  assert.equal(fu(followup.id).attempt_count, 0);
  assert.equal(touchEvents().length, 0);
  store.automation_settings![0].enabled = true;
  store.organizations![0].automation_paused = true;
  assert.equal((await dispatchFollowup(db as never, followup.id, clock)).outcome, "skipped_disabled");
  assert.equal(touchEvents().length, 0);
});

// ===========================================================================
// Manual Run Now (TEST-only)
// ===========================================================================

const runNow = (followupId: string) => {
  const form = new FormData();
  form.set("followupId", followupId);
  return runFollowupNow({}, form);
};

test("27. Run Now uses the same dispatcher: same claim, same touch key, same execution path - just not waiting for the due time", async () => {
  store.organizations![0].automation_mode = "test";
  const { followup } = await newFollowup();
  clock = at(1);
  const result = await runNow(followup.id);
  assert.match(result.result, /Touch 1 recorded as blocked \(organization_not_live\)/);
  assert.equal(touchEvents()[0].idempotency_key, `followup.touch:${followup.id}:1`);
  assert.equal(touchExecutions().length, 1);
  assert.equal(fu(followup.id).attempt_count, 1);
  const source = readFileSync(path.join(process.cwd(), "app/(app)/leads/actions.ts"), "utf8");
  assert.match(source, /dispatchFollowup\(createServiceRoleClient\(\), followup\.id as string, new Date\(\), \{ runNow: true \}\)/);
});

test("27b. Run Now is TEST-only: refused on Production, for a non-admin, and outside TEST mode", async () => {
  const { followup } = await newFollowup();
  store.organizations![0].automation_mode = "test";
  process.env.VERCEL_ENV = "production";
  try {
    assert.match((await runNow(followup.id)).error, /only available on test deployments/);
  } finally {
    process.env.VERCEL_ENV = "preview";
  }
  control.admin = false;
  assert.match((await runNow(followup.id)).error, /owner or admin/);
  control.admin = true;
  store.organizations![0].automation_mode = "live";
  assert.match((await runNow(followup.id)).error, /TEST mode/);
  assert.equal(touchEvents().length, 0);
});

test("28. Run Now cannot bypass eligibility: a superseded lead exits instead of sending", async () => {
  store.organizations![0].automation_mode = "test";
  const { followup } = await newFollowup();
  clock = at(1);
  addLead();
  assert.match((await runNow(followup.id)).result, /Stopped \(lead_superseded\)/);
  assert.equal(touchEvents().length, 0);
  assert.equal(calls.sends, 0);
});

test("29. Run Now cannot bypass the outbound gate / compliance: in TEST the gate still denies (organization_not_live) - nothing is sent; concurrent Run Nows claim once", async () => {
  store.organizations![0].automation_mode = "test";
  store.contacts![0].sms_opt_out = true;
  const { followup } = await newFollowup();
  const [a, b] = await Promise.all([runNow(followup.id), runNow(followup.id)]);
  const results = [a.result, b.result].sort();
  assert.match(results[0], /Nothing to run/);
  assert.match(results[1], /Touch 1 recorded as blocked \(organization_not_live\) - nothing was sent/);
  assert.equal(calls.sends, 0);
  assert.equal(store.messages!.filter((m) => m.direction === "outbound").length, 0);
  assert.equal(touchExecutions().length, 1);
  assert.equal(touchExecutions()[0].outcome, "blocked");
  const source = readFileSync(path.join(process.cwd(), "lib/followups/engine.ts"), "utf8");
  assert.equal(source.match(/sendOutboundMessage\(/g)?.length, 1, "one send call site, after the gate");
  assert.ok(source.indexOf("evaluateOutboundGate(supabase") < source.indexOf("sendOutboundMessage(supabase"));
});

// ===========================================================================
// RLS (proven against Postgres by validate-followups.mjs) + Today
// ===========================================================================

test("30/31. RLS: members may only SELECT their own organization's follow-ups (payment-gated); no member write path exists", () => {
  const sql = readFileSync(path.join(process.cwd(), "supabase/pending/followups.sql"), "utf8");
  assert.match(sql, /alter table public\.followups enable row level security/);
  assert.match(sql, /create policy followups_select on public\.followups for select to authenticated using \(public\.is_org_member\(organization_id\)\)/);
  assert.match(sql, /followups_payment_active on public\.followups as restrictive for all/);
  assert.match(sql, /revoke insert, update, delete, truncate on public\.followups from authenticated/);
  assert.match(sql, /revoke all on public\.followups from anon/);
  assert.doesNotMatch(sql, /for (insert|update|delete|all) to authenticated/, "no permissive write policy");
  const validator = readFileSync(path.join(process.cwd(), "supabase/pending/scratch/validate-followups.mjs"), "utf8");
  assert.match(validator, /30: org A sees only its own follow-ups/);
  assert.match(validator, /31: cannot mutate org B/);
});

test("Today: one low-noise line for active follow-ups (never a row per lead), nothing when none, and no human alert for normal blocks", async () => {
  assert.equal(buildFollowupAttentionItem(0), null);
  assert.deepEqual(buildFollowupAttentionItem(2), { id: "followups-active", kind: "automation_retrying", title: "Lead Follow-Up Sequence", detail: "Trackpr is following up with 2 leads.", value: null, href: "/automations/lead-followup-sequence" });

  store.organizations![0].automation_mode = "test";
  await newFollowup();
  await newFollowup({ contact_id: OTHER_CONTACT });
  clock = at(24);
  await dispatchDueFollowups(db as never, clock);
  const items = await loadAutomationAttention(db as never, ORG, clock);
  assert.deepEqual(items.map((i: Row) => i.kind), ["automation_retrying"], "TEST-mode blocks are not a human alert");
  assert.equal(items[0].detail, "Trackpr is following up with 2 leads.");
  assert.deepEqual(await loadAutomationAttention(db as never, OTHER_ORG, clock), [], "another organization sees nothing");
});

test("cadence has ONE source: the dispatcher reads config.ts, nothing else hard-codes 24/72/168", () => {
  for (const file of ["lib/followups/engine.ts", "lib/followups/producer.ts", "lib/followups/store.ts"]) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /\b(72|168)\b/, `${file} hard-codes a cadence`);
  }
});

test("producer hook: lead.created records the follow-up intent only when enabled - and never sends or dispatches", async () => {
  const { emitLeadCreatedFollowupAsService } = await import(lib("lib/automation/lead-followup.ts"));
  const lead = addLead();
  await quiet(() => emitLeadCreatedFollowupAsService(db as never, { leadId: lead.id, contactId: CONTACT, organizationId: ORG, source: "website", service: "Roofing", status: "new", temperature: "warm", estimatedValue: null }));
  await quiet(() => emitLeadCreatedFollowupAsService(db as never, { leadId: lead.id, contactId: CONTACT, organizationId: ORG, source: "website", service: "Roofing", status: "new", temperature: "warm", estimatedValue: null }));
  const rows = store.followups!.filter((f) => f.lead_id === lead.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "scheduled");
  assert.equal(touchEvents().length, 0);
  assert.equal(calls.sends, 0);
});

test("the TEST-only panel is on the page lead links actually reach: /leads/:id redirects to the person page, so the panel lives there and Run now refreshes it", () => {
  const config = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
  assert.match(config, /source: "\/leads\/:id", destination: "\/customers\/:id\?from=lead"/, "if this redirect is ever removed, revisit where the panel lives");
  const people = readFileSync(path.join(process.cwd(), "app/(app)/people/[id]/page.tsx"), "utf8");
  assert.match(people, /import \{ FollowupRunNow \} from/);
  assert.match(people, /<FollowupRunNow/);
  assert.match(people, /isCustomerReplySimulationEnvironment\(\) &&\s+\(membership\.role === "owner" \|\| membership\.role === "admin"\) &&/);
  assert.match(people, /automation_mode === "test"/);
  const retired = readFileSync(path.join(process.cwd(), "app/(app)/leads/[id]/page.tsx"), "utf8");
  assert.doesNotMatch(retired, /FollowupRunNow/, "never on the retired, unreachable lead page");
  const actions = readFileSync(path.join(process.cwd(), "app/(app)/leads/actions.ts"), "utf8");
  assert.match(actions, /revalidatePath\(`\/people\/\$\{lead\.contact_id as string\}`\)/);
});
