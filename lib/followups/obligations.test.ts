/**
 * P0-B B2.1: the generic obligation dispatcher, with lead_no_reply (A4) as
 * its first and only registered kind.
 *
 * Reuses the A4 harness (followups.test.ts): the REAL engine, producer, A3
 * rule, outbound gate, event/execution functions, A2 classifier + retry
 * path and Run Now action, against the same in-memory store. In addition the
 * B1 snapshot loader and A3's checkLifecycleEligibility are wrapped (the real
 * functions still run) so call ORDER is observable, the snapshot read can be
 * made to fail, and start_workflow_execution can be made to lose B0's claim.
 * The A4 suite itself is unchanged; these tests prove the generalization
 * kept every A4 value and added the snapshot-first, fail-closed re-check.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/followups/obligations.test.ts
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
const calls = { sends: 0, signals: [] as Row[], n8n: 0, log: [] as string[], snapshotArgs: [] as Row[], sendStates: [] as Row[] };
const control = { sendOk: true, admin: true, hours: [] as Row[], snapshotFails: false, startLoses: false };

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
      calls.log.push("event");
      const existing = events.find((e) => e.organization_id === args.p_organization_id && e.idempotency_key === args.p_idempotency_key);
      if (existing) return { data: { ...existing, is_duplicate: true }, error: null };
      const event = { id: uuid(), organization_id: args.p_organization_id, event_type: args.p_event_type, entity_type: args.p_entity_type, entity_id: args.p_entity_id, payload: args.p_payload, idempotency_key: args.p_idempotency_key, status: "pending", created_at: clock.toISOString() };
      events.push(event);
      return { data: { ...event, is_duplicate: false }, error: null };
    }
    if (name === "start_workflow_execution") {
      const event = events.find((e) => e.id === args.p_automation_event_id);
      if (!event) return { data: null, error: { message: "Automation event not found" } };
      // B0: the atomic claim's loser - another attempt already holds this event.
      if (control.startLoses) return { data: null, error: { message: "Automation event is already being processed" } };
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
      calls.log.push("send");
      const execution = store.workflow_executions!.find((e) => e.id === input.workflowExecutionId);
      const event = store.automation_events!.find((e) => e.id === execution?.automation_event_id);
      const owner = store.followups!.find((f) => f.id === (event?.payload as Row | undefined)?.followup_id);
      if (owner) calls.sendStates.push({ state: owner.state, lease_until: owner.lease_until });
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

const realSnapshotLoader = await import(lib("lib/lifecycle/snapshot-loader.ts"));
mock.module(lib("lib/lifecycle/snapshot-loader.ts"), {
  namedExports: {
    ...realSnapshotLoader,
    loadLifecycleSnapshot: async (supabase: unknown, organizationId: string, contactId: string, options: { asOf?: Date } = {}) => {
      calls.log.push("snapshot");
      calls.snapshotArgs.push({ organizationId, contactId, asOf: options.asOf?.toISOString() ?? null });
      if (control.snapshotFails) return { snapshot: null, failed: true, error: "snapshot read failed (test)" };
      return realSnapshotLoader.loadLifecycleSnapshot(supabase, organizationId, contactId, options);
    },
  },
});
const realEligibility = await import(lib("lib/automation/lifecycle-eligibility.ts"));
mock.module(lib("lib/automation/lifecycle-eligibility.ts"), {
  namedExports: {
    ...realEligibility,
    checkLifecycleEligibility: async (...args: unknown[]) => {
      calls.log.push("a3");
      return (realEligibility.checkLifecycleEligibility as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  },
});

process.env.VERCEL_ENV = "preview";
const engine = await import(lib("lib/followups/engine.ts"));
const { ensureLeadFollowup } = await import(lib("lib/followups/producer.ts"));
const { classifyFailedExecutions, processDueRetries } = await import(lib("lib/automation/execution-retry.ts"));
const { runFollowupNow } = await import(lib("app/(app)/leads/actions.ts"));
const { dispatchFollowup, dispatchDueFollowups, getObligationKind, registeredObligationKinds } = engine;
const { ensureObligation } = await import(lib("lib/followups/producer.ts"));
const { OBLIGATION_KIND_DESCRIPTORS, getObligationKindDescriptor } = await import(lib("lib/followups/kinds.ts"));
const { FOLLOWUP_STAGES, FOLLOWUP_LEASE_MINUTES } = await import(lib("lib/followups/config.ts"));
const { AUTOMATION_CATALOG } = await import(lib("lib/automation/catalog.ts"));
const { AUTOMATIC_RETRY_POLICY, SAFE_RETRY_AUTOMATION_IDS } = await import(lib("lib/automation/retry-eligibility.ts"));
const { SNAPSHOT_MESSAGE_LIMIT } = realSnapshotLoader;


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
  control.snapshotFails = false;
  control.startLoses = false;
  calls.log = [];
  calls.snapshotArgs = [];
  calls.sendStates = [];
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
const formFor = (followupId: string) => {
  const form = new FormData();
  form.set("followupId", followupId);
  return form;
};

const OBLIGATION_KEY = (followupId: string, touch: number) => `followup.touch:${followupId}:${touch}`;
const followupFields = (id: string) => {
  const row = fu(id);
  return { state: row.state, waiting_on: row.waiting_on, next_action: row.next_action, next_action_at: row.next_action_at, attempt_count: row.attempt_count, exit_reason: row.exit_reason, paused_reason: row.paused_reason, lease_until: row.lease_until };
};
const outbound = () => store.messages!.filter((m) => m.direction === "outbound").length;
/** A row of a kind nobody registered (inserted directly - no producer would create it). */
function unregisteredRow(stage: string) {
  const lead = addLead();
  const row = { id: uuid(), organization_id: ORG, lead_id: lead.id, stage, state: "scheduled", waiting_on: "customer", next_action: "send_followup", next_action_at: T0.toISOString(), attempt_count: 0, lease_until: null, paused_reason: null, exit_reason: null, last_execution_id: null, reactivated_at: null, created_at: T0.toISOString() };
  store.followups!.push(row);
  return row as Entity;
}

// ===========================================================================
// Registry
// ===========================================================================

test("1. registered kind: exactly one kind, lead_no_reply, with A4's identity, cadence and handler", () => {
  const kinds = registeredObligationKinds();
  assert.deepEqual(kinds.map((kind: Row) => kind.stage), ["lead_no_reply"]);
  assert.deepEqual(Object.keys(OBLIGATION_KIND_DESCRIPTORS), ["lead_no_reply"]);
  assert.deepEqual(Object.keys(OBLIGATION_KIND_DESCRIPTORS).sort(), [...FOLLOWUP_STAGES].sort(), "every cadence stage is a registered kind and vice versa");
  const kind = getObligationKind("lead_no_reply")!;
  assert.equal(kind.automationId, "lead-followup-sequence");
  assert.equal(kind.eventType, "followup.touch");
  assert.equal(kind.workflowName, "lead_followup_touch");
  assert.equal(kind.subjectType, "lead");
  assert.equal(kind.subjectMissingReason, "lead_not_found");
  assert.deepEqual(kind.gateOptions, { leadEligibleStatuses: ["new", "contacted", "qualified"], leadMustHaveNoActiveEngagement: true, respectBusinessHours: true });
  assert.deepEqual([...kind.terminalGateReasons].sort(), ["contact_not_found", "contact_opted_out", "conversation_ai_disabled", "invalid_destination", "lead_conversation_mismatch", "lead_has_active_engagement", "lead_not_found", "lead_status_ineligible", "lead_wrong_organization"]);
  assert.equal(kind.compose(1), engine.composeFollowupTouchBody(1));
  assert.equal(engine.FOLLOWUP_EVENT_TYPE, kind.eventType, "A4's exported names are the kind's values");
  assert.equal(engine.FOLLOWUP_WORKFLOW, kind.workflowName);
  assert.equal(engine.FOLLOWUP_AUTOMATION_ID, kind.automationId);
  assert.equal(engine.dispatchFollowup, engine.dispatchObligation, "A4 names are aliases of the generic dispatcher, not a second path");
  assert.equal(engine.dispatchDueFollowups, engine.dispatchDueObligations);
  assert.equal(engine.retryFollowupTouch, engine.retryObligationTouch);
});

test("2. catalog IDs valid: the kind's automation, event type and workflow exist in the catalog, the A2 retry policy and the safe-retry set", () => {
  for (const kind of registeredObligationKinds() as Row[]) {
    const entry = AUTOMATION_CATALOG.find((automation: Row) => automation.id === kind.automationId);
    assert.ok(entry, `${kind.automationId} is a catalog automation`);
    assert.ok((entry.eventTypes as string[]).includes(kind.eventType as string));
    assert.ok((entry.workflowNames as string[]).includes(kind.workflowName as string));
    assert.equal(entry.dispatch, "trackpr");
    assert.ok(AUTOMATIC_RETRY_POLICY[kind.workflowName as string], "A2 has a retry policy for the workflow");
    assert.ok(SAFE_RETRY_AUTOMATION_IDS.has(kind.automationId), "A2 may retry it");
  }
});

test("3. dispatcher selects the correct kind - by exact stage only; an unregistered stage is never claimed, defaulted or acted on", async () => {
  for (const key of ["toString", "__proto__", "constructor", "hasOwnProperty", "", "LEAD_NO_REPLY", "lead_no_reply ", "estimate_no_reply"]) {
    assert.equal(getObligationKind(key), null, `"${key}" is not a kind`);
    assert.equal(getObligationKindDescriptor(key), null);
  }
  assert.equal(getObligationKind("lead_no_reply")!.stage, "lead_no_reply");

  const stray = unregisteredRow("estimate_no_reply");
  const before = { ...fu(stray.id) };
  assert.deepEqual(await dispatchFollowup(db as never, stray.id, at(24)), { followupId: stray.id, outcome: "error", error: "unregistered_obligation_kind:estimate_no_reply" });
  assert.deepEqual(fu(stray.id), before, "not claimed: the row is untouched");
  const [tick] = await dispatchDueFollowups(db as never, at(24));
  assert.deepEqual(tick, { followupId: stray.id, outcome: "error", error: "unregistered_obligation_kind:estimate_no_reply" });
  assert.equal(store.automation_events!.length, 0);
  assert.equal(calls.sends, 0);
  assert.equal(calls.log.length, 0, "no snapshot, no lifecycle check - nothing ran");

  // Selection is independent of input order: a registered row dispatches the same next to an unregistered one.
  const { followup } = await newFollowup({ contact_id: OTHER_CONTACT });
  clock = at(24);
  const outcomes = await dispatchDueFollowups(db as never, clock);
  assert.deepEqual(outcomes.map((o: Row) => o.outcome).sort(), ["error", "sent"]);
  assert.equal(touchEvents()[0].idempotency_key, OBLIGATION_KEY(followup.id, 1));
  assert.equal(touchExecutions()[0].workflow_name, "lead_followup_touch");
  assert.equal(fu(stray.id).state, "scheduled");
});

// ===========================================================================
// Producer
// ===========================================================================

test("4. producer path: ensureLeadFollowup is ensureObligation('lead_no_reply'); an unregistered kind records nothing", async () => {
  const lead = addLead();
  const created = await ensureObligation(db as never, { stage: "lead_no_reply", organizationId: ORG, leadId: lead.id, now: clock });
  assert.equal(created.outcome, "created");
  assert.deepEqual(followupFields(created.followup.id), { state: "scheduled", waiting_on: "customer", next_action: "send_followup", next_action_at: at(24).toISOString(), attempt_count: 0, exit_reason: null, paused_reason: null, lease_until: null });
  const viaA4 = await ensureLeadFollowup(db as never, { organizationId: ORG, leadId: lead.id, now: at(1) });
  assert.equal(viaA4.outcome, "existing");
  assert.equal(viaA4.followup.id, created.followup.id);

  const other = addLead({ contact_id: OTHER_CONTACT });
  assert.deepEqual(await ensureObligation(db as never, { stage: "estimate_no_reply", organizationId: ORG, leadId: other.id, now: clock }), { outcome: "failed", error: "unregistered_obligation_kind:estimate_no_reply" });
  assert.deepEqual(await ensureObligation(db as never, { stage: "toString", organizationId: ORG, leadId: other.id, now: clock }), { outcome: "failed", error: "unregistered_obligation_kind:toString" });
  assert.equal(store.followups!.length, 1);

  store.automation_settings = [];
  assert.deepEqual(await ensureObligation(db as never, { stage: "lead_no_reply", organizationId: ORG, leadId: other.id, now: clock }), { outcome: "disabled" }, "default-off unchanged");
  assert.equal(calls.sends + touchEvents().length, 0, "a producer never sends or dispatches");
  const source = readFileSync(path.join(process.cwd(), "lib/followups/producer.ts"), "utf8");
  assert.match(source, /return ensureObligation\(service, \{ stage: LEAD_NO_REPLY\.stage,/);
});

// ===========================================================================
// Lifecycle (B1 snapshot)
// ===========================================================================

test("5. the B1 snapshot is loaded (scoped to the subject's organization + contact, as of now) before the lifecycle eligibility check", async () => {
  const { followup } = await newFollowup();
  clock = at(24);
  assert.equal((await dispatchFollowup(db as never, followup.id, clock)).outcome, "sent");
  assert.deepEqual(calls.log, ["snapshot", "a3", "event", "send"]);
  assert.deepEqual(calls.snapshotArgs, [{ organizationId: ORG, contactId: CONTACT, asOf: clock.toISOString() }]);
  const source = readFileSync(path.join(process.cwd(), "lib/followups/engine.ts"), "utf8");
  const dispatch = source.slice(source.indexOf("export async function dispatchObligation"));
  assert.ok(dispatch.indexOf("loadLifecycle(service, row, subject, now)") < dispatch.indexOf("kind.stillOwed("), "snapshot before the still-owed check");
});

test("6. a failed snapshot read never produces an outbound: released unconsumed, nothing recorded - by the tick, by Run Now and by an A2 retry", async () => {
  const { followup } = await newFollowup();
  control.snapshotFails = true;
  clock = at(24);
  const before = followupFields(followup.id);
  assert.deepEqual(await quiet(() => dispatchFollowup(db as never, followup.id, clock)), { followupId: followup.id, outcome: "error", error: "lifecycle_snapshot_failed: snapshot read failed (test)" });
  assert.deepEqual(followupFields(followup.id), before, "same state, same due time, attempt not consumed, lease released");
  assert.equal(touchEvents().length + touchExecutions().length + calls.sends + outbound(), 0);
  assert.ok(!calls.log.includes("a3"), "nothing decides on a failed read");

  store.organizations![0].automation_mode = "test";
  assert.match((await runFollowupNow({}, formFor(followup.id))).result ?? "", /lifecycle_snapshot_failed/);
  assert.equal(touchEvents().length + calls.sends, 0);

  // Retry path: a failed touch whose retry finds the snapshot unreadable fails again - never resends.
  store.organizations![0].automation_mode = "live";
  control.snapshotFails = false;
  control.sendOk = false;
  await dispatchFollowup(db as never, followup.id, clock);
  assert.equal(fu(followup.id).state, "failed");
  await classifyFailedExecutions(db as never, clock);
  control.snapshotFails = true;
  control.sendOk = true;
  const sendsBefore = calls.sends;
  await quiet(() => processDueRetries(db as never, at(25)));
  const retried = touchExecutions().find((e) => e.attempt === 2)!;
  assert.equal(retried.status, "failed");
  assert.match(String(retried.error_message), /lifecycle_snapshot_failed/);
  assert.equal(calls.sends, sendsBefore, "no send on the retry");
  assert.equal(fu(followup.id).state, "failed");
});

test("7. lifecycle re-check equivalent: reply -> completed; closed / superseded / active engagement / no contact -> exited (A3's reasons)", async () => {
  const replied = (await newFollowup()).followup;
  store.conversations!.push({ id: "conv-1", organization_id: ORG, contact_id: CONTACT, lead_id: replied.lead_id, channel: "sms", status: "open", ai_enabled: true });
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: "conv-1", direction: "inbound", created_at: at(3).toISOString() });
  assert.deepEqual(await dispatchFollowup(db as never, replied.id, at(24)), { followupId: replied.id, outcome: "completed", reason: "customer_replied" });
  assert.deepEqual(followupFields(replied.id), { state: "completed", waiting_on: "none", next_action: "none", next_action_at: null, attempt_count: 0, exit_reason: "customer_replied", paused_reason: null, lease_until: null });

  // Precedence is A4's: a reply wins over a lifecycle exit (checked first).
  clock = T0;
  const both = await newFollowup({ contact_id: OTHER_CONTACT });
  store.conversations!.push({ id: "conv-b", organization_id: ORG, contact_id: OTHER_CONTACT, lead_id: both.lead.id, channel: "sms", status: "open", ai_enabled: true });
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: "conv-b", direction: "inbound", created_at: at(3).toISOString() });
  both.lead.status = "won";
  assert.deepEqual(await dispatchFollowup(db as never, both.followup.id, at(24)), { followupId: both.followup.id, outcome: "completed", reason: "customer_replied" });
  store.conversations = store.conversations!.filter((c) => c.id !== "conv-b");

  const cases: [string, (lead: Entity) => void, string][] = [
    ["closed", (lead) => (lead.status = "won"), "lead_closed"],
    ["superseded", () => addLead({ contact_id: OTHER_CONTACT, created_at: at(2).toISOString() }), "lead_superseded"],
    ["engaged", () => store.appointments!.push({ id: uuid(), organization_id: ORG, contact_id: OTHER_CONTACT, lead_id: null, status: "confirmed" }), "contact_active_engagement"],
  ];
  for (const [, mutate, reason] of cases) {
    store.appointments = [];
    store.leads = store.leads!.filter((lead) => lead.contact_id !== OTHER_CONTACT);
    clock = T0;
    const { lead, followup } = await newFollowup({ contact_id: OTHER_CONTACT });
    mutate(lead);
    assert.deepEqual(await dispatchFollowup(db as never, followup.id, at(24)), { followupId: followup.id, outcome: "exited", reason });
    assert.equal(fu(followup.id).exit_reason, reason);
  }
  clock = T0;
  const orphan = (await newFollowup({ contact_id: null })).followup;
  assert.deepEqual(await dispatchFollowup(db as never, orphan.id, at(24)), { followupId: orphan.id, outcome: "exited", reason: "lead_contact_mismatch" });
  assert.equal(calls.sends, 0);
  assert.equal(touchEvents().length, 0);
});

test("7b. reply equivalence at the edges: a reply hidden beyond the snapshot's 200-message window is still found; microsecond-precise anchor", async () => {
  const { followup } = await newFollowup();
  store.conversations!.push({ id: "conv-1", organization_id: ORG, contact_id: CONTACT, lead_id: followup.lead_id, channel: "sms", status: "open", ai_enabled: true });
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: "conv-1", direction: "inbound", created_at: at(1).toISOString() });
  for (let i = 0; i < SNAPSHOT_MESSAGE_LIMIT; i += 1) store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: "conv-1", direction: "outbound", created_at: new Date(at(2).getTime() + i * 1000).toISOString() });
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, at(24)), { followupId: followup.id, outcome: "completed", reason: "customer_replied" }, "A4 found it; so must the snapshot path");

  // Microseconds: an inbound 1us after the anchor is a reply; one at the anchor is not (A4's strict '>').
  clock = T0;
  const precise = (await newFollowup({ contact_id: OTHER_CONTACT })).followup;
  fu(precise.id).created_at = "2026-11-02T15:00:00.123456+00:00";
  store.conversations!.push({ id: "conv-2", organization_id: ORG, contact_id: OTHER_CONTACT, lead_id: precise.lead_id, channel: "sms", status: "open", ai_enabled: true });
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: "conv-2", direction: "inbound", created_at: "2026-11-02T15:00:00.123456+00:00" });
  const sameInstant = await dispatchFollowup(db as never, precise.id, at(24));
  assert.notEqual(sameInstant.outcome, "completed", "a message at the anchor itself is not after it");
  clock = T0;
  const later = (await newFollowup({ contact_id: OTHER_CONTACT, status: "contacted" })).followup;
  fu(later.id).created_at = "2026-11-02T15:00:00.123456+00:00";
  store.leads!.find((l) => l.id === precise.lead_id)!.status = "lost";
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: "conv-2", direction: "inbound", created_at: "2026-11-02T15:00:00.123457+00:00" });
  assert.deepEqual(await dispatchFollowup(db as never, later.id, at(24)), { followupId: later.id, outcome: "completed", reason: "customer_replied" });
});

// ===========================================================================
// A4 behaviour, characterized through the generic dispatcher
// ===========================================================================

test("8/9/10/11. cadence, state transitions, touch numbers and touch keys are A4's: 24h/72h/168h, scheduled->processing->scheduled... ->completed", async () => {
  const { lead, followup } = await newFollowup();
  const seen: Row[] = [];
  for (const [touch, due] of [[1, 24], [2, 72], [3, 168]] as const) {
    clock = at(due);
    const outcome = await dispatchFollowup(db as never, followup.id, clock);
    assert.deepEqual({ ...outcome, messageId: undefined }, { followupId: followup.id, outcome: "sent", touch, messageId: undefined });
    seen.push(followupFields(followup.id));
    const event = touchEvents()[touch - 1];
    assert.equal(event.idempotency_key, OBLIGATION_KEY(followup.id, touch), "11: the touch key is followup.touch:<id>:<touch>, byte for byte");
    assert.equal(event.event_type, "followup.touch");
    assert.equal(event.entity_type, "lead");
    assert.equal(event.entity_id, lead.id);
    assert.deepEqual(event.payload, { followup_id: followup.id, lead_id: lead.id, contact_id: CONTACT, stage: "lead_no_reply", touch });
    assert.equal(touchExecutions()[touch - 1].outcome, "succeeded");
    assert.equal(fu(followup.id).last_execution_id, touchExecutions()[touch - 1].id);
  }
  assert.deepEqual(calls.sendStates.map((s) => s.state), ["processing", "processing", "processing"], "9: every send happens under the claim");
  assert.deepEqual(seen, [
    { state: "scheduled", waiting_on: "customer", next_action: "send_followup", next_action_at: at(72).toISOString(), attempt_count: 1, exit_reason: null, paused_reason: null, lease_until: null },
    { state: "scheduled", waiting_on: "customer", next_action: "send_followup", next_action_at: at(168).toISOString(), attempt_count: 2, exit_reason: null, paused_reason: null, lease_until: null },
    { state: "completed", waiting_on: "none", next_action: "none", next_action_at: null, attempt_count: 3, exit_reason: "cadence_complete", paused_reason: null, lease_until: null },
  ]);
  assert.equal(calls.sends, 3);
  assert.equal(outbound(), 3);
  assert.equal((await dispatchFollowup(db as never, followup.id, at(500), { runNow: true })).outcome, "not_claimed", "a completed obligation is never dispatched");
});

test("12. lease intact: the claim leases for FOLLOWUP_LEASE_MINUTES; a live lease is not reclaimed; an expired lease is; two workers -> one claim", async () => {
  const { followup } = await newFollowup();
  clock = at(24);
  const [a, b] = await Promise.all([dispatchFollowup(db as never, followup.id, clock), dispatchFollowup(db as never, followup.id, clock)]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ["not_claimed", "sent"]);
  assert.equal(calls.sends, 1);
  assert.equal(calls.sendStates[0].lease_until, new Date(clock.getTime() + FOLLOWUP_LEASE_MINUTES * 60 * 1000).toISOString());

  Object.assign(fu(followup.id), { state: "processing", lease_until: at(72.1).toISOString(), next_action_at: at(72).toISOString() });
  assert.equal((await dispatchFollowup(db as never, followup.id, at(72))).outcome, "not_claimed", "live lease");
  assert.equal((await dispatchDueFollowups(db as never, at(72))).length, 0);
  assert.equal((await dispatchFollowup(db as never, followup.id, at(72.2))).outcome, "sent", "expired lease is reclaimed");
  assert.equal(calls.sends, 2);
});

test("13. B0 atomic claim intact: the touch's event, the kind's workflow and the run's trigger source reach start_workflow_execution; a refused start records no execution and sends nothing", async () => {
  // Behavioural (P0-B B2.5a, replacing a source-text pin): capture every B0 start call.
  const starts: Row[] = [];
  const realRpc = db.rpc;
  (db as Row).rpc = (name: string, args: Row) => {
    if (name === "start_workflow_execution") starts.push({ ...args });
    return realRpc(name, args);
  };
  try {
    const { followup } = await newFollowup();
    const refused = (await newFollowup({ contact_id: OTHER_CONTACT })).followup;
    clock = at(24);
    assert.equal((await dispatchFollowup(db as never, followup.id, clock)).outcome, "sent");
    const [event] = touchEvents();
    assert.deepEqual(starts, [{ p_automation_event_id: event.id, p_workflow_name: getObligationKind("lead_no_reply")!.workflowName, p_metadata: {}, p_trigger_source: "event" }]);
    assert.equal(touchExecutions()[0].automation_event_id, event.id);

    starts.length = 0;
    control.startLoses = true;
    const outcome = (await quiet(() => dispatchFollowup(db as never, refused.id, clock))) as Row;
    assert.equal(outcome.outcome, "failed");
    const refusedEvent = touchEvents().find((e) => (e.payload as Row).followup_id === refused.id)!;
    assert.deepEqual(starts, [{ p_automation_event_id: refusedEvent.id, p_workflow_name: "lead_followup_touch", p_metadata: {}, p_trigger_source: "event" }], "the refused start was asked for this touch's event");
    assert.equal(touchExecutions().length, 1, "no execution for the refused start");
    assert.equal(calls.sends, 1, "no send for the refused start");
    assert.deepEqual({ state: fu(refused.id).state, next_action: fu(refused.id).next_action, lease_until: fu(refused.id).lease_until }, { state: "failed", next_action: "human_review", lease_until: null });
    assert.match(readFileSync(path.join(process.cwd(), "lib/automation/executions.ts"), "utf8"), /rpc\("start_workflow_execution"/);
  } finally {
    (db as Row).rpc = realRpc;
  }
});

test("14. A2 retry intact: failed send -> failed execution (A2-classified) -> retry re-runs the kind's checks + gate + send -> obligation advances", async () => {
  const { followup } = await newFollowup();
  control.sendOk = false;
  clock = at(24);
  assert.equal((await dispatchFollowup(db as never, followup.id, clock)).outcome, "failed");
  assert.deepEqual({ state: fu(followup.id).state, next_action: fu(followup.id).next_action, attempt_count: fu(followup.id).attempt_count }, { state: "failed", next_action: "retry", attempt_count: 0 });
  const [first] = touchExecutions();
  assert.deepEqual({ status: first.status, outcome: first.outcome }, { status: "failed", outcome: "failed" });
  await classifyFailedExecutions(db as never, clock);
  assert.equal(first.retry_state, "scheduled");
  control.sendOk = true;
  calls.log = [];
  const due = await processDueRetries(db as never, at(25));
  assert.equal(due.started.length, 1);
  assert.deepEqual(calls.log, ["snapshot", "a3", "send"], "the retry re-checks the lifecycle (fresh snapshot) before sending");
  const retried = touchExecutions().find((e) => e.attempt === 2)!;
  assert.deepEqual({ trigger_source: retried.trigger_source, outcome: retried.outcome }, { trigger_source: "retry", outcome: "succeeded" });
  assert.equal(first.retry_state, "retried");
  assert.deepEqual(followupFields(followup.id), { state: "scheduled", waiting_on: "customer", next_action: "send_followup", next_action_at: at(72).toISOString(), attempt_count: 1, exit_reason: null, paused_reason: null, lease_until: null });
  assert.equal(touchEvents().length, 1, "the same touch, the same key");
  assert.equal(calls.sends, 2);
});

test("15. business-hours deferral identical (clock-independent): deferred to the next opening, unconsumed, nothing recorded", async () => {
  control.hours = [{ day_of_week: "tuesday", is_open: true, open_time: "09:00", close_time: "17:00" }];
  const { followup } = await newFollowup();
  // Due Monday 20:00 (closed); the next opening is Tuesday 09:00. No real clock is involved: deferral precedes the gate.
  fu(followup.id).next_action_at = "2026-11-02T20:00:00.000Z";
  const outcome = await dispatchFollowup(db as never, followup.id, new Date("2026-11-02T20:00:00.000Z"));
  assert.deepEqual(outcome, { followupId: followup.id, outcome: "deferred", until: "2026-11-03T09:00:00.000Z" });
  assert.deepEqual(followupFields(followup.id), { state: "scheduled", waiting_on: "customer", next_action: "send_followup", next_action_at: "2026-11-03T09:00:00.000Z", attempt_count: 0, exit_reason: null, paused_reason: null, lease_until: null });
  assert.equal(touchEvents().length + touchExecutions().length + calls.sends, 0);

  control.hours = [{ day_of_week: "monday", is_open: false, open_time: null, close_time: null }];
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, new Date("2026-11-03T09:00:00.000Z")), { followupId: followup.id, outcome: "paused", reason: "no_business_hours" });
  assert.deepEqual({ state: fu(followup.id).state, waiting_on: fu(followup.id).waiting_on, next_action: fu(followup.id).next_action }, { state: "paused", waiting_on: "business", next_action: "human_review" });
});

test("16. dormancy identical: more than 48h late -> paused dormant, never sent late, nothing recorded; exactly 48h late still sends", async () => {
  const { followup } = await newFollowup();
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, at(24 + 49)), { followupId: followup.id, outcome: "paused", reason: "dormant" });
  assert.deepEqual(followupFields(followup.id), { state: "paused", waiting_on: "none", next_action: "none", next_action_at: at(24).toISOString(), attempt_count: 0, exit_reason: null, paused_reason: "dormant", lease_until: null });
  assert.equal(touchEvents().length + calls.sends, 0);
  clock = T0;
  const onTime = (await newFollowup({ contact_id: OTHER_CONTACT })).followup;
  assert.equal((await dispatchFollowup(db as never, onTime.id, at(24 + 48))).outcome, "sent");
});

test("17. terminal block identical: an opted-out contact -> the gate blocks (execution 'blocked'), the obligation exits, touch recorded", async () => {
  const { followup } = await newFollowup();
  store.contacts![0].sms_opt_out = true;
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, at(24)), { followupId: followup.id, outcome: "exited", reason: "contact_opted_out" });
  assert.deepEqual(followupFields(followup.id), { state: "exited", waiting_on: "none", next_action: "none", next_action_at: null, attempt_count: 1, exit_reason: "contact_opted_out", paused_reason: null, lease_until: null });
  const [execution] = touchExecutions();
  assert.deepEqual({ status: execution.status, outcome: execution.outcome, blocked: (execution.metadata as Row).blocked_reason }, { status: "completed", outcome: "blocked", blocked: "contact_opted_out" });
  assert.equal(fu(followup.id).last_execution_id, execution.id);
  assert.equal(calls.sends + outbound(), 0);
  await classifyFailedExecutions(db as never, at(24));
  assert.equal(execution.retry_state, null);
});

test("18. non-terminal block identical: TEST mode -> blocked organization_not_live, the touch is consumed and the cadence moves on", async () => {
  store.organizations![0].automation_mode = "test";
  const { followup } = await newFollowup();
  assert.deepEqual(await dispatchFollowup(db as never, followup.id, at(24)), { followupId: followup.id, outcome: "blocked", touch: 1, reason: "organization_not_live" });
  assert.deepEqual(followupFields(followup.id), { state: "scheduled", waiting_on: "customer", next_action: "send_followup", next_action_at: at(72).toISOString(), attempt_count: 1, exit_reason: null, paused_reason: null, lease_until: null });
  assert.equal(touchExecutions()[0].outcome, "blocked");
  assert.equal(calls.sends + outbound() + calls.signals.length, 0);
});

test("19. duplicate producer identical: repeated producer calls (A4 and generic) keep one obligation and its schedule; a duplicate touch never sends twice", async () => {
  const { lead, followup } = await newFollowup();
  for (const now of [at(1), at(2)]) {
    assert.equal((await ensureLeadFollowup(db as never, { organizationId: ORG, leadId: lead.id, now })).outcome, "existing");
    assert.equal((await ensureObligation(db as never, { stage: "lead_no_reply", organizationId: ORG, leadId: lead.id, now })).outcome, "existing");
  }
  assert.equal(store.followups!.length, 1);
  assert.equal(fu(followup.id).next_action_at, at(24).toISOString());

  clock = at(24);
  await dispatchFollowup(db as never, followup.id, clock);
  Object.assign(fu(followup.id), { state: "processing", lease_until: at(24.1).toISOString(), attempt_count: 0, next_action_at: at(24).toISOString() });
  const [outcome] = await dispatchDueFollowups(db as never, at(25));
  assert.deepEqual(outcome, { followupId: followup.id, outcome: "blocked", touch: 1, reason: "duplicate_touch" });
  assert.equal(calls.sends, 1);
  assert.equal(touchExecutions().length, 1);
  assert.equal(fu(followup.id).attempt_count, 1);
});

test("20. Run Now intact: TEST-only, the same dispatcher (same claim, key, execution path), cannot bypass eligibility or the gate", async () => {
  store.organizations![0].automation_mode = "test";
  const { followup } = await newFollowup();
  clock = at(1);
  const result = await runFollowupNow({}, formFor(followup.id));
  assert.match(result.result, /Touch 1 recorded as blocked \(organization_not_live\)/);
  assert.equal(touchEvents()[0].idempotency_key, OBLIGATION_KEY(followup.id, 1));
  assert.deepEqual(calls.log, ["snapshot", "a3", "event"], "Run Now goes through the snapshot and lifecycle checks too");
  assert.equal(calls.sends, 0);
  const superseded = (await newFollowup({ contact_id: OTHER_CONTACT })).followup;
  clock = at(2);
  addLead({ contact_id: OTHER_CONTACT });
  assert.match((await runFollowupNow({}, formFor(superseded.id))).result, /Stopped \(lead_superseded\)/);
  process.env.VERCEL_ENV = "production";
  try {
    assert.match((await runFollowupNow({}, formFor(followup.id))).error, /only available on test deployments/);
  } finally {
    process.env.VERCEL_ENV = "preview";
  }
  assert.equal(touchEvents().length, 1);
});
