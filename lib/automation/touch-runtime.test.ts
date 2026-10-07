/**
 * P0-B B2.4: the shared touch runtime - its derived driver
 * (lib/automation/touch-runtime.ts) and the universal steps it shares with
 * A4's persisted dispatcher (lib/followups/engine.ts: verifyLifecycle,
 * claimTouch, executeTouch) - exercised through its first derived kind,
 * customer reactivation (lib/automation/customer-reactivation.ts).
 *
 * The same in-memory store as the A4 suite (plus paging, multi-column order
 * and a pre-query hook for mid-run changes); the REAL events, executions,
 * B0-shaped start, outbound gate, late-touch, A2 classifier and B1 snapshot
 * loader run. The SMS provider is mocked. The snapshot loader is wrapped
 * (the real one still runs) so its call can be observed and failed.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/touch-runtime.test.ts
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

let store: Record<string, Row[]> = {};
let ids = 0;
let clock = T0;
const hooks: { beforeRun?: (table: string, eqs: Row, write: boolean) => void } = {};
const calls = { sends: 0, signals: [] as Row[], n8n: 0 };
const control = { sendOk: true, admin: true, hours: [] as Row[], startLoses: false, snapshotFails: false };
const trace: string[] = [];
const snapshotArgs: Row[] = [];

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
  private sorts: { column: string; ascending: boolean }[] = [];
  private window: [number, number] | null = null;
  private eqs: Row = {};
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
  eq(c: string, v: unknown) { this.eqs[c] = v; this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  range(from: number, to: number) { this.window = [from, to]; return this; }
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
  order(c: string, o?: { ascending?: boolean }) { this.sorts.push({ column: c, ascending: o?.ascending !== false }); return this; }
  limit(n: number) { this.max = n; return this; }
  update(v: Row) { this.updateValues = v; return this; }
  insert(v: Row | Row[]) { this.insertRows = Array.isArray(v) ? v : [v]; return this; }
  single() { return this.run(true); }
  maybeSingle() { return this.run(true); }
  then<T>(resolve: (v: { data: unknown; error: unknown; count?: number }) => T, reject?: (e: unknown) => T) { return this.run(false).then(resolve, reject); }
  private async run(single: boolean): Promise<{ data: unknown; error: unknown; count?: number }> {
    hooks.beforeRun?.(this.table, this.eqs, Boolean(this.updateValues || this.insertRows));
    if (this.table === SNAPSHOT_MARKER_TABLE) {
      trace.push("snapshot");
      snapshotArgs.push({ ...this.eqs });
      if (control.snapshotFails) return { data: null, error: { message: "snapshot read failed (test)" } };
    }
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
    if (this.sorts.length) {
      matched = [...matched].sort((a, b) => {
        for (const { column, ascending } of this.sorts) {
          const d = String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0;
          if (d) return d * (ascending ? 1 : -1);
        }
        return 0;
      });
    }
    if (this.window) matched = matched.slice(this.window[0], this.window[1] + 1);
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
      trace.push("event");
      const existing = events.find((e) => e.organization_id === args.p_organization_id && e.idempotency_key === args.p_idempotency_key);
      if (existing) return { data: { ...existing, is_duplicate: true }, error: null };
      const event = { id: uuid(), organization_id: args.p_organization_id, event_type: args.p_event_type, entity_type: args.p_entity_type, entity_id: args.p_entity_id, payload: args.p_payload, idempotency_key: args.p_idempotency_key, status: "pending", created_at: clock.toISOString() };
      events.push(event);
      return { data: { ...event, is_duplicate: false }, error: null };
    }
    if (name === "start_workflow_execution") {
      const event = events.find((e) => e.id === args.p_automation_event_id);
      if (!event) return { data: null, error: { message: "Automation event not found" } };
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
      trace.push("send");
      store.messages!.push({ id: uuid(), organization_id: input.organizationId, conversation_id: input.conversationId, workflow_execution_id: input.workflowExecutionId, direction: "outbound", body: input.body, sender_type: input.senderType, created_at: clock.toISOString() });
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

const quiet = async <T>(fn: () => Promise<T>) => {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};
type Entity = Row & { id: string };
// The B1 snapshot is observed through the store: only the lifecycle snapshot
// loader reads `opportunities`, so that read marks the snapshot, and failing
// it makes the REAL loader report a failed read.
const SNAPSHOT_MARKER_TABLE = "opportunities";

process.env.VERCEL_ENV = "preview";
const { processCustomerReactivation, CUSTOMER_REACTIVATION_ADAPTER } = await import(lib("lib/automation/customer-reactivation.ts"));
const { runDerivedTouch, retryDerivedTouch } = await import(lib("lib/automation/touch-runtime.ts"));
const { auditFieldViolation, executeTouch, RUNTIME_OUTCOME_FIELDS } = await import(lib("lib/followups/engine.ts"));
const { SERVICE_EXECUTION_OPS, startWorkflowExecutionAsService } = await import(lib("lib/automation/executions.ts"));
const { classifyFailedExecutions } = await import(lib("lib/automation/execution-retry.ts"));
const { AUTOMATION_CATALOG } = await import(lib("lib/automation/catalog.ts"));
const { AUTOMATIC_RETRY_POLICY } = await import(lib("lib/automation/retry-eligibility.ts"));
const { FOLLOWUP_STAGES } = await import(lib("lib/followups/config.ts"));
const { ensureLeadFollowup } = await import(lib("lib/followups/producer.ts"));
const { dispatchFollowup } = await import(lib("lib/followups/engine.ts"));

const DAY = 24 * HOUR;
const daysAgo = (d: number) => new Date(T0.getTime() - d * DAY).toISOString();

beforeEach(() => {
  store = {
    organizations: [
      { id: ORG, automation_mode: "live", payment_status: "active", automation_paused: false, name: "QA Fixture Roofing", vertical: "contractor", timezone: "UTC" },
      { id: OTHER_ORG, automation_mode: "live", payment_status: "active", automation_paused: false },
    ],
    contacts: [
      { id: CONTACT, organization_id: ORG, first_name: "Riley", phone: "+15550142301", phone_normalized: "+15550142301", sms_opt_out: false },
      { id: OTHER_CONTACT, organization_id: ORG, first_name: "Other", phone: "+15550142302", phone_normalized: "+15550142302", sms_opt_out: false },
    ],
    automation_settings: [{ organization_id: ORG, automation_id: "customer-reactivation", enabled: true, config: null }],
    leads: [], followups: [], conversations: [], messages: [], appointments: [], estimates: [], jobs: [], invoices: [], automation_events: [], workflow_executions: [],
  };
  ids = 100;
  clock = T0;
  calls.sends = 0; calls.signals = []; calls.n8n = 0;
  control.sendOk = true; control.admin = true; control.hours = []; control.startLoses = false; control.snapshotFails = false;
  hooks.beforeRun = undefined;
  trace.length = 0;
  snapshotArgs.length = 0;
});

const addJob = (extra: Row = {}) => {
  const job = { id: uuid(), organization_id: ORG, contact_id: CONTACT, title: "Roof repair", status: "completed", completed_at: daysAgo(181), created_at: daysAgo(200), ...extra };
  store.jobs!.push(job);
  return job as Entity;
};
const run = (now: Date = T0) => processCustomerReactivation(db as never, now);
const events = () => store.automation_events!.filter((e) => e.event_type === "customer.reactivation");
const executions = () => store.workflow_executions!.filter((e) => e.workflow_name === "customer_reactivation_followup");
const outbound = () => store.messages!.filter((m) => m.direction === "outbound");
const config = { inactivity_days: 180, respect_business_hours: true };

/** A probe around the REAL customer-reactivation adapter: every adapter call is traced, behaviour unchanged unless overridden. */
function probe(overrides: Partial<Record<string, unknown>> = {}) {
  const real = CUSTOMER_REACTIVATION_ADAPTER as Record<string, unknown>;
  const traced: Record<string, unknown> = { identity: real.identity, policy: { ...(real.policy as Row), ...((overrides.policy as Row) ?? {}) } };
  for (const key of ["subject", "idempotencyKey", "isDue", "dueAt", "stillOwed", "payload", "compose", "gateOptions", "auditFields"]) {
    const fn = (overrides[key] ?? real[key]) as (...args: unknown[]) => unknown;
    traced[key] = (...args: unknown[]) => {
      trace.push(key);
      return fn(...args);
    };
  }
  return traced;
}
const derived = (adapter: unknown, job: Row, now: Date = T0, enabled = true, context?: { triggerSource: "event" | "manual" }) =>
  runDerivedTouch(db as never, adapter as never, { job, config }, now, {
    isEnabled: async () => {
      trace.push("isEnabled");
      return enabled;
    },
    ...(context ? { context } : {}),
  });

// ===========================================================================
// The runtime contract
// ===========================================================================

test("1. fixed pipeline order: kill switch -> payment -> due -> soft claim -> B1 snapshot -> still owed -> claim -> compose -> gate -> send -> record", async () => {
  const job = addJob();
  hooks.beforeRun = (table, eqs, write) => {
    if (table === "organizations" && "payment_status" in eqs === false && eqs.id === ORG && !write) trace.push("org-read");
  };
  const result = await derived(probe(), job);
  assert.equal(result.status, "sent");
  const order = trace.filter((step) => ["isEnabled", "isDue", "snapshot", "stillOwed", "event", "compose", "gateOptions", "send"].includes(step));
  assert.deepEqual(order, ["isEnabled", "isDue", "snapshot", "stillOwed", "event", "compose", "gateOptions", "send"]);
  assert.deepEqual(snapshotArgs, [{ organization_id: ORG, contact_id: CONTACT, status: "open" }], "the subject contact's snapshot, organization + contact scoped");
  const [execution] = executions();
  assert.equal(execution.outcome, "succeeded");
  assert.deepEqual(Object.keys(execution.metadata as Row).sort(), ["conversation_id", "job_id", "message_id", "provider_message_id", "should_send"]);
});

test("2. B1 fails closed: a failed snapshot read never reaches still-owed, the claim, the gate or the send", async () => {
  addJob();
  control.snapshotFails = true;
  const { outcomes } = await run();
  assert.deepEqual(outcomes, [{ contactId: CONTACT, outcome: "failed", error: "lifecycle_snapshot_failed: snapshot read failed (test)" }]);
  assert.equal(events().length + executions().length + calls.sends + outbound().length, 0);
  const result = await derived(probe(), addJob({ contact_id: OTHER_CONTACT }));
  assert.equal(result.status, "lifecycle_failed");
  assert.ok(!trace.includes("stillOwed") && !trace.includes("compose"), "nothing kind-specific runs on an unknown lifecycle");
  control.snapshotFails = false;
  assert.equal((await run()).outcomes[0].outcome, "sent", "the touch was not consumed - the next run sends it");
});

test("3. subject verification: a contact that is not the organization's is a missing subject (legacy outcome no_contact), nothing recorded", async () => {
  store.contacts![0].organization_id = OTHER_ORG;
  addJob();
  assert.deepEqual((await run()).outcomes, [{ contactId: CONTACT, outcome: "no_contact" }]);
  assert.equal(events().length + calls.sends, 0);
  assert.equal((await derived(probe(), addJob())).status, "subject_missing");
  assert.ok(!trace.includes("stillOwed"));
});

test("4. still owed is the kind's: each failing check returns its legacy outcome and records nothing", async () => {
  addJob();
  store.leads!.push({ id: uuid(), organization_id: ORG, contact_id: CONTACT, status: "contacted" });
  assert.deepEqual((await run()).outcomes, [{ contactId: CONTACT, outcome: "active_engagement" }]);
  store.leads = [];
  store.conversations!.push({ id: "c1", organization_id: ORG, contact_id: CONTACT, channel: "sms", status: "open", ai_enabled: true });
  assert.deepEqual((await run()).outcomes, [{ contactId: CONTACT, outcome: "has_open_conversation" }]);
  assert.equal(events().length + calls.sends, 0);
  const result = await derived(probe({ stillOwed: async () => ({ owed: false, reason: "probe_not_owed" }) }), store.jobs![0]);
  assert.deepEqual(result, { status: "not_owed", reason: "probe_not_owed" });
  assert.ok(!trace.includes("compose") && !trace.includes("event"));
});

test("5. kill switch and payment policy run first; payment inactive reads no lifecycle", async () => {
  const job = addJob();
  assert.deepEqual(await derived(probe(), job, T0, false), { status: "skipped_disabled" });
  assert.deepEqual(trace, ["subject", "isEnabled"]);
  trace.length = 0;
  store.organizations![0].payment_status = "past_due";
  assert.deepEqual(await derived(probe(), job), { status: "payment_inactive" });
  assert.ok(!trace.includes("snapshot") && !trace.includes("isDue"));
  trace.length = 0;
  const withoutPolicy = await derived(probe({ policy: { requiresActivePayment: false } }), job);
  assert.notEqual(withoutPolicy.status, "payment_inactive", "the policy value - not the kind - decides");
  assert.ok(trace.includes("snapshot") && trace.includes("stillOwed"), "without the policy the pipeline continues past step 2");
});

test("6. stale policy record_overdue: more than 48h late is recorded as blocked followup_overdue under the legacy key, never composed or sent", async () => {
  const job = addJob({ completed_at: new Date(T0.getTime() - 182 * DAY - 60000).toISOString() });
  assert.deepEqual(await derived(probe(), job), { status: "blocked", reason: "followup_overdue" });
  assert.ok(!trace.includes("compose"));
  assert.equal(events()[0].idempotency_key, `customer.reactivation:${CONTACT}:${job.id}`);
  assert.equal(executions()[0].outcome, "blocked");
  assert.equal(calls.sends, 0);
  assert.equal((await derived(probe(), job)).status, "skipped_duplicate", "the overdue touch's key is used");
});

test("7. the outbound gate is the runtime's and receives the kind's gate options: a job reopened after still-owed is blocked at the gate", async () => {
  const job = addJob();
  let reads = 0;
  hooks.beforeRun = (table, eqs) => {
    if (table === "jobs" && eqs.id === job.id && ++reads === 2) job.status = "in_progress";
  };
  const result = await derived(probe(), job);
  assert.equal(result.status, "blocked");
  assert.equal(executions()[0].outcome, "blocked");
  assert.equal(calls.sends, 0);
  store.contacts![1].sms_opt_out = true;
  const optedOut = await derived(probe(), addJob({ contact_id: OTHER_CONTACT }));
  assert.deepEqual(optedOut, { status: "blocked", reason: "contact_opted_out" });
});

test("8. gate policy values: gateChecksAutomationEnabled passes the automation's live state to the gate; off (customer reactivation) it does not", async () => {
  const job = addJob();
  // Turns the automation off after the claim (an execution exists), before the gate.
  const turnOffAfterClaim = () => {
    const claimedBefore = executions().length;
    let armed = true;
    hooks.beforeRun = (table) => {
      if (armed && table === "conversations" && executions().length === claimedBefore + 1) {
        store.automation_settings![0].enabled = false;
        armed = false;
      }
    };
  };
  turnOffAfterClaim();
  assert.deepEqual(await derived(probe({ policy: { gateChecksAutomationEnabled: true } }), job), { status: "blocked", reason: "automation_disabled" });
  store.automation_settings![0].enabled = true;
  hooks.beforeRun = undefined;
  const other = addJob({ contact_id: OTHER_CONTACT });
  turnOffAfterClaim();
  assert.equal((await derived(probe(), other)).status, "sent", "customer reactivation never carried the enabled state into its gate call");
});

test("9. idempotency: the legacy key customer.reactivation:<contact>:<job>; a repeat is a duplicate; a key taken after the soft claim is still never sent twice", async () => {
  const job = addJob();
  assert.equal(CUSTOMER_REACTIVATION_ADAPTER.idempotencyKey({ job, config }), `customer.reactivation:${CONTACT}:${job.id}`);
  assert.equal((await run()).outcomes[0].outcome, "sent");
  assert.deepEqual((await run(new Date(T0.getTime() + HOUR))).outcomes, [{ contactId: CONTACT, outcome: "skipped_duplicate" }]);
  // Race: another worker records the key between our soft claim and our claim.
  const raced = addJob({ contact_id: OTHER_CONTACT });
  hooks.beforeRun = (table) => {
    if (table === "contacts" && !store.automation_events!.some((e) => e.idempotency_key === `customer.reactivation:${OTHER_CONTACT}:${raced.id}`)) {
      store.automation_events!.push({ id: uuid(), organization_id: ORG, event_type: "customer.reactivation", idempotency_key: `customer.reactivation:${OTHER_CONTACT}:${raced.id}`, status: "completed" });
    }
  };
  assert.deepEqual(await derived(probe(), raced), { status: "skipped_duplicate" });
  assert.equal(calls.sends, 1);
});

test("10. B0 atomic execution claim: a refused start records no execution and sends nothing", async () => {
  addJob();
  control.startLoses = true;
  const { outcomes } = (await quiet(() => run())) as { outcomes: Row[] };
  assert.equal(outcomes[0].outcome, "failed");
  assert.equal(executions().length + calls.sends, 0);
});

test("11. execution recording: send failure -> failed execution (sms_send_failed); customer reactivation stays outside A2's automatic retry", async () => {
  addJob();
  control.sendOk = false;
  assert.equal((await run()).outcomes[0].outcome, "failed");
  const [execution] = executions();
  assert.equal(execution.status, "failed");
  assert.equal(execution.outcome, "failed");
  assert.equal(AUTOMATIC_RETRY_POLICY["customer_reactivation_followup"], undefined);
  await classifyFailedExecutions(db as never, T0);
  assert.notEqual(execution.retry_state, "scheduled");
});

test("12. the adapter is a fixed interface of pure functions + policy values, matching the catalog", () => {
  assert.deepEqual(Object.keys(CUSTOMER_REACTIVATION_ADAPTER).sort(), ["auditFields", "compose", "dueAt", "gateOptions", "idempotencyKey", "identity", "isDue", "payload", "policy", "stillOwed", "subject"]);
  assert.deepEqual(CUSTOMER_REACTIVATION_ADAPTER.policy, { requiresActivePayment: true, stale: { mode: "record_blocked", audit: "payload" }, missingSubject: "skip", gateChecksAutomationEnabled: false, senderType: "ai" });
  const entry = AUTOMATION_CATALOG.find((a: Row) => a.id === CUSTOMER_REACTIVATION_ADAPTER.identity.automationId);
  assert.ok(entry);
  assert.ok((entry.eventTypes as string[]).includes(CUSTOMER_REACTIVATION_ADAPTER.identity.eventType));
  assert.ok((entry.workflowNames as string[]).includes(CUSTOMER_REACTIVATION_ADAPTER.identity.workflowName));
  assert.equal(entry.dispatch, "trackpr");
});

test("13. the runtime never branches on a kind: no automation id, event type, workflow or stage literal in the runtime code", () => {
  const runtime = readFileSync(path.join(process.cwd(), "lib/automation/touch-runtime.ts"), "utf8");
  const engine = readFileSync(path.join(process.cwd(), "lib/followups/engine.ts"), "utf8");
  const shared = engine.slice(engine.indexOf("// ----------------------------------------------------- shared touch runtime"), engine.indexOf("// --------------------------------------------------------------- dispatcher"));
  assert.ok(shared.length > 1000, "the shared section exists");
  const names = new Set<string>([...FOLLOWUP_STAGES]);
  for (const automation of AUTOMATION_CATALOG as Row[]) {
    names.add(automation.id as string);
    for (const t of automation.eventTypes as string[]) names.add(t);
    for (const w of automation.workflowNames as string[]) names.add(w);
  }
  for (const name of names) {
    for (const [file, source] of [["touch-runtime.ts", runtime], ["engine.ts shared runtime", shared]]) {
      assert.ok(!source.includes(`"${name}"`) && !source.includes(`'${name}'`) && !source.includes(`\`${name}`), `${file} names ${name}`);
    }
  }
});

test("14. one executor: customer reactivation no longer has its own claim/gate/send path - it runs the shared runtime; A4 runs the same executor", () => {
  const reactivation = readFileSync(path.join(process.cwd(), "lib/automation/customer-reactivation.ts"), "utf8");
  for (const own of ["sendOutboundMessage(", "evaluateOutboundGate(", "createAutomationEventAsService(", "startWorkflowExecutionAsService(", "recordOverdueTouch(", "completeWorkflowExecutionAsService(", "failWorkflowExecutionAsService("]) {
    assert.ok(!reactivation.includes(own), `customer-reactivation.ts still calls ${own}`);
  }
  assert.match(reactivation, /runDerivedTouch\(supabase, CUSTOMER_REACTIVATION_ADAPTER, \{ job, config \}, now, \{ isEnabled, sendSmsFn \}\)/);
  const runtime = readFileSync(path.join(process.cwd(), "lib/automation/touch-runtime.ts"), "utf8");
  const engineImport = /import \{([^}]*)\} from "@\/lib\/followups\/engine";/.exec(runtime);
  assert.ok(engineImport, "the derived driver imports the shared runtime from engine.ts");
  for (const name of ["claimTouch", "executeTouch", "recordBlockedTouch", "verifyLifecycle"]) assert.match(engineImport![1], new RegExp(`\\b${name}\\b`), name);
  const engine = readFileSync(path.join(process.cwd(), "lib/followups/engine.ts"), "utf8");
  assert.match(engine, /const recorded = await claimTouch\(service, kind, row\.organization_id,/);
  assert.match(engine, /await executeTouch\(service, obligationTouchSend\(kind,/);
  assert.match(engine, /await executeTouch\(supabase, obligationTouchSend\(kind,/, "the A2 retry of a persisted touch uses it too");
});

test("15. the persisted kind's gate options reach the shared executor: a lead closed after A4's lifecycle check is still stopped by the gate", async () => {
  store.automation_settings!.push({ organization_id: ORG, automation_id: "lead-followup-sequence", enabled: true });
  const lead = { id: uuid(), organization_id: ORG, contact_id: CONTACT, status: "new", source: "website", service: "Roofing", created_at: T0.toISOString() };
  store.leads!.push(lead);
  const created = await ensureLeadFollowup(db as never, { organizationId: ORG, leadId: lead.id, now: T0 });
  assert.equal(created.outcome, "created");
  // The lead is closed after the claim (its event exists), before the gate.
  hooks.beforeRun = (table) => {
    if (table === "conversations" && store.automation_events!.some((e) => e.event_type === "followup.touch")) lead.status = "won";
  };
  const outcome = await dispatchFollowup(db as never, created.followup.id, new Date(T0.getTime() + 24 * HOUR));
  assert.deepEqual(outcome, { followupId: created.followup.id, outcome: "exited", reason: "lead_status_ineligible" });
  assert.equal(calls.sends, 0);
  const execution = store.workflow_executions!.find((e) => e.workflow_name === "lead_followup_touch")!;
  assert.equal(execution.outcome, "blocked");
});

// ===========================================================================
// P0-B B2.5a: the extended contract (execution context, audit fields,
// subject resolution, stale policy, shared retry entry). Exercised through
// the REAL customer-reactivation adapter, with policy VALUES overridden where
// a test needs a value customer reactivation does not use - the runtime
// cannot tell the difference, which is the point.
// ===========================================================================

/** Captures every B0 start call for the duration of `fn`. */
async function captureStarts<T>(fn: () => Promise<T>): Promise<{ result: T; starts: Row[] }> {
  const starts: Row[] = [];
  const realRpc = db.rpc;
  (db as Row).rpc = (name: string, args: Row) => {
    if (name === "start_workflow_execution") starts.push({ ...args });
    return realRpc(name, args);
  };
  try {
    return { result: await fn(), starts };
  } finally {
    (db as Row).rpc = realRpc;
  }
}
const metadataOf = (execution: Row) => execution.metadata as Row;
const otherContactJob = () => {
  store.contacts!.push({ id: "55555555-5555-4555-8555-555555555555", organization_id: OTHER_ORG, first_name: "Foreign", phone: "+15550142309", sms_opt_out: false });
  return addJob({ contact_id: "55555555-5555-4555-8555-555555555555" });
};

test("16. execution context: the run's trigger source reaches B0 with the touch's event and the kind's workflow; 'event' when omitted", async () => {
  const job = addJob();
  const manual = await captureStarts(() => derived(probe(), job, T0, true, { triggerSource: "manual" }));
  assert.equal((manual.result as Row).status, "sent");
  const [event] = events();
  assert.deepEqual(manual.starts, [{ p_automation_event_id: event.id, p_workflow_name: "customer_reactivation_followup", p_metadata: {}, p_trigger_source: "manual" }]);
  assert.equal(executions()[0].trigger_source, "manual");
  store.conversations = []; // customer reactivation's own still-owed rule refuses a contact mid-conversation
  const other = addJob({ contact_id: OTHER_CONTACT });
  const omitted = await captureStarts(() => derived(probe(), other));
  assert.equal(omitted.starts[0].p_trigger_source, "event");
  // The overdue record carries the run's trigger source too.
  store.conversations = [];
  const late = addJob({ contact_id: OTHER_CONTACT, completed_at: daysAgo(400) });
  const overdue = await captureStarts(() => derived(probe(), late, T0, true, { triggerSource: "manual" }));
  assert.deepEqual(overdue.result, { status: "blocked", reason: "followup_overdue" });
  assert.equal(overdue.starts[0].p_trigger_source, "manual");
  // A refused B0 start: no execution, no send.
  control.startLoses = true;
  const refused = await captureStarts(() => derived(probe(), addJob({ contact_id: OTHER_CONTACT, completed_at: daysAgo(181), id: uuid() })));
  assert.equal((refused.result as Row).status, "failed");
  assert.equal(refused.starts.length, 1);
  assert.equal(calls.sends, 2);
});

test("17. audit fields: flat scalars appended after the outcome fields; a collision or a non-scalar is rejected before anything is recorded; deterministic", async () => {
  assert.deepEqual([...RUNTIME_OUTCOME_FIELDS].sort(), ["blocked_detail", "blocked_reason", "conversation_id", "message_id", "provider_message_id", "should_send"]);
  assert.equal(auditFieldViolation({ job_id: "j", occurrence: 2, lead_id: null }), null);
  assert.equal(auditFieldViolation({ should_send: true }), "should_send");
  assert.equal(auditFieldViolation({ zeta: 1, message_id: "x", blocked_reason: "y" }), "blocked_reason", "the first violation in sorted key order");
  assert.equal(auditFieldViolation({ nested: { a: 1 } }), "nested");
  assert.equal(auditFieldViolation({ list: [1] }), "list");

  const job = addJob();
  assert.equal((await derived(probe(), job)).status, "sent");
  assert.deepEqual(metadataOf(executions()[0]), { should_send: true, message_id: "m", conversation_id: metadataOf(executions()[0]).conversation_id, provider_message_id: "SM", job_id: job.id });

  for (const bad of [{ should_send: false }, { conversation_id: "forged" }, { job: { id: "x" } }]) {
    const before = { events: store.automation_events!.length, executions: store.workflow_executions!.length, sends: calls.sends, conversations: store.conversations!.length };
    const result = await derived(probe({ auditFields: () => bad }), addJob({ contact_id: OTHER_CONTACT }));
    assert.deepEqual(result, { status: "failed", error: `audit_field_rejected:${Object.keys(bad)[0]}` });
    assert.deepEqual({ events: store.automation_events!.length, executions: store.workflow_executions!.length, sends: calls.sends, conversations: store.conversations!.length }, before, "nothing claimed, recorded or sent");
  }
  // The shared executor refuses a collision before any read or write (a persisted kind can never reach it either).
  const conversationsBefore = store.conversations!.length;
  await assert.rejects(executeTouch(db as never, { organizationId: ORG, contactId: CONTACT, leadId: null, body: "x", gateOptions: {}, gateAutomationId: null, senderType: "ai", auditFields: { message_id: "forged" } }, "exec-x", SERVICE_EXECUTION_OPS), /audit_field_rejected:message_id/);
  assert.equal(store.conversations!.length, conversationsBefore);
});

test("18. subject resolution: an UNKNOWN lifecycle fails closed (nothing recorded, still eligible); a KNOWN missing contact follows the policy - never a send", async () => {
  // Unknown: a failed read.
  const job = addJob();
  control.snapshotFails = true;
  assert.deepEqual(await derived(probe({ policy: { missingSubject: "record_blocked" } }), job), { status: "lifecycle_failed", error: "snapshot read failed (test)" });
  assert.equal(events().length + executions().length + calls.sends, 0, "an unknown lifecycle is never recorded, even under record_blocked");
  control.snapshotFails = false;
  assert.equal((await derived(probe(), job)).status, "sent", "still eligible");

  // Known missing + skip (customer reactivation's legacy value).
  const foreign = otherContactJob();
  trace.length = 0;
  assert.deepEqual(await derived(probe(), foreign), { status: "subject_missing" });
  assert.equal(events().filter((e) => (e.payload as Row).job_id === foreign.id).length, 0);

  // Known missing + record_blocked.
  trace.length = 0;
  const conversationsBefore = store.conversations!.length;
  const sendsBefore = calls.sends;
  const result = await derived(probe({ policy: { missingSubject: "record_blocked" } }), foreign);
  assert.deepEqual(result, { status: "blocked", reason: "contact_not_found" });
  const event = events().find((e) => (e.payload as Row).job_id === foreign.id)!;
  assert.equal(event.idempotency_key, `customer.reactivation:${foreign.contact_id}:${foreign.id}`, "the touch's own key is claimed");
  assert.deepEqual(event.payload, { contact_id: foreign.contact_id, job_id: foreign.id, job_title: "Roof repair" }, "payload without facts");
  const execution = executions().find((e) => e.automation_event_id === event.id)!;
  assert.equal(execution.outcome, "blocked");
  assert.deepEqual(metadataOf(execution), { should_send: false, blocked_reason: "contact_not_found", blocked_detail: null, job_id: foreign.id });
  assert.ok(!trace.includes("stillOwed") && !trace.includes("compose") && !trace.includes("gateOptions"), "never composed or gated");
  assert.equal(store.conversations!.length, conversationsBefore, "no conversation is resolved for a foreign contact");
  assert.equal(calls.sends, sendsBefore);
  assert.equal((await derived(probe({ policy: { missingSubject: "record_blocked" } }), foreign)).status, "skipped_duplicate", "deterministic: recorded once");

  // A null contact is not a missing subject: no snapshot is loaded; the kind's still-owed (customer reactivation: no_contact)
  // or, past it, the gate (missing_contact_id) decides - exactly as before.
  const noContact = addJob({ contact_id: null });
  trace.length = 0;
  assert.deepEqual(await derived(probe(), noContact), { status: "not_owed", reason: "no_contact" });
  assert.ok(!trace.includes("snapshot"));
  const owedAnyway = probe({ stillOwed: async () => ({ owed: true, facts: { contact: { first_name: null }, title: "Roof repair" } }) });
  assert.deepEqual(await derived(owedAnyway, noContact), { status: "blocked", reason: "missing_contact_id" });
});

test("19. stale policy: none sends a late touch; record_blocked records followup_overdue with the audit fields or (legacy) the payload; a missing subject is decided first", async () => {
  const late = addJob({ completed_at: daysAgo(400) });
  trace.length = 0;
  assert.equal((await derived(probe({ policy: { stale: { mode: "none" } } }), late)).status, "sent", "mode none: no lateness rule");
  assert.ok(!trace.includes("dueAt"));

  const auditLate = addJob({ contact_id: OTHER_CONTACT, completed_at: daysAgo(400) });
  assert.deepEqual(await derived(probe({ policy: { stale: { mode: "record_blocked", audit: "audit_fields" } } }), auditLate), { status: "blocked", reason: "followup_overdue" });
  const auditExecution = executions().find((e) => e.automation_event_id === events().find((ev) => (ev.payload as Row).job_id === auditLate.id)!.id)!;
  assert.deepEqual(metadataOf(auditExecution), { should_send: false, blocked_reason: "followup_overdue", blocked_detail: "219 hours past due".replace("219", String(Math.floor((400 - 180) * 24 - 0))), job_id: auditLate.id });

  // Customer reactivation's legacy value: the overdue record carries the event payload, exactly as recordOverdueTouch did.
  resetForLegacy();
  const legacy = addJob({ completed_at: daysAgo(400), title: "Old roof" });
  assert.deepEqual((await run()).outcomes, [{ contactId: CONTACT, outcome: "blocked", reason: "followup_overdue" }]);
  assert.deepEqual(metadataOf(executions()[0]), { should_send: false, blocked_reason: "followup_overdue", blocked_detail: `${(400 - 180) * 24} hours past due`, contact_id: CONTACT, job_id: legacy.id, job_title: "Old roof" });
  assert.equal(executions()[0].trigger_source, "event");

  // Missing subject + overdue: the subject is resolved first.
  const foreignLate = otherContactJob();
  foreignLate.completed_at = daysAgo(400);
  assert.deepEqual(await derived(probe(), foreignLate), { status: "subject_missing" }, "skip: nothing recorded, not an overdue record");
  assert.deepEqual(await derived(probe({ policy: { missingSubject: "record_blocked" } }), foreignLate), { status: "blocked", reason: "contact_not_found" });
});
function resetForLegacy() {
  store.automation_events = [];
  store.workflow_executions = [];
  store.jobs = [];
  store.messages = [];
  store.conversations = [];
  calls.sends = 0;
}

/** A2's part of a retry, as retry.ts does it: a new execution on the touch's original event, trigger_source 'retry'. */
async function a2StartsRetry(eventId: string) {
  const started = await startWorkflowExecutionAsService(db as never, eventId, "customer_reactivation_followup", {}, "retry");
  assert.ok(started.ok);
  return started.execution.id as string;
}
function spyOps() {
  const used: string[] = [];
  return {
    used,
    ops: {
      complete: (...args: unknown[]) => (used.push("complete"), (SERVICE_EXECUTION_OPS.complete as (...a: unknown[]) => Promise<unknown>)(...args)),
      fail: (...args: unknown[]) => (used.push("fail"), (SERVICE_EXECUTION_OPS.fail as (...a: unknown[]) => Promise<unknown>)(...args)),
    },
  };
}
async function failedTouch(job: Row) {
  control.sendOk = false;
  assert.equal((await derived(probe(), job)).status, "failed");
  control.sendOk = true;
  store.conversations = []; // the failed attempt opened one; customer reactivation's still-owed would refuse a contact mid-conversation
  return events().find((e) => (e.payload as Row).job_id === job.id)!;
}

test("20. shared retry entry: after A2 starts the retry execution - subject + B1, still owed, then the shared gate/send spine, with A2's ops; no new event, no new B0 start", async () => {
  const job = addJob();
  const event = await failedTouch(job);
  const executionId = await a2StartsRetry(event.id as string);
  trace.length = 0;
  const { ops, used } = spyOps();
  const { result, starts } = await captureStarts(() => retryDerivedTouch(db as never, probe() as never, { job, config }, executionId, ops as never, T0));
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(starts, [], "B0 is A2's: the retry starts nothing");
  assert.deepEqual(trace.filter((step) => ["snapshot", "stillOwed", "compose", "gateOptions", "send"].includes(step)), ["snapshot", "stillOwed", "compose", "gateOptions", "send"]);
  assert.deepEqual(used, ["complete"], "recorded through A2's ops");
  const retried = store.workflow_executions!.find((e) => e.id === executionId)!;
  assert.deepEqual({ outcome: retried.outcome, trigger_source: retried.trigger_source, attempt: retried.attempt }, { outcome: "succeeded", trigger_source: "retry", attempt: 2 });
  assert.equal(events().length, 1, "same event, same key");
});

test("21. shared retry entry fails closed and respects still-owed, the gate and the subject; it never applies the stale rule", async () => {
  // Each case retries its own failed touch (A2 can only retry a failed execution of an event not yet completed).
  let contacts = 0;
  const freshFailedTouch = async (extra: Row = {}) => {
    const contactId = `66666666-6666-4666-8666-${String(++contacts).padStart(12, "0")}`;
    store.contacts!.push({ id: contactId, organization_id: ORG, first_name: "Case", phone: `+1555014240${contacts}`, phone_normalized: `+1555014240${contacts}`, sms_opt_out: false });
    const job = addJob({ contact_id: contactId, ...extra });
    const event = await failedTouch(job);
    return { job, contactId, executionId: await a2StartsRetry(event.id as string) };
  };
  const executionOf = (id: string) => store.workflow_executions!.find((e) => e.id === id)!;

  // Unknown lifecycle: the retry execution fails; nothing is sent.
  /** Runs one retry and proves it sent nothing. */
  const retryWithoutSend = async (job: Row, executionId: string) => {
    const before = calls.sends;
    const result = await retryDerivedTouch(db as never, probe() as never, { job, config }, executionId, SERVICE_EXECUTION_OPS as never, T0);
    assert.equal(calls.sends, before, "nothing sent");
    return result;
  };
  const unknown = await freshFailedTouch();
  control.snapshotFails = true;
  assert.deepEqual(await retryWithoutSend(unknown.job, unknown.executionId), { ok: false, error: "lifecycle_snapshot_failed" });
  assert.equal(executionOf(unknown.executionId).status, "failed");
  assert.match(String(executionOf(unknown.executionId).error_message), /lifecycle_snapshot_failed/);
  control.snapshotFails = false;

  // No longer owed: closed as blocked with the kind's reason.
  const notOwed = await freshFailedTouch();
  store.leads!.push({ id: uuid(), organization_id: ORG, contact_id: notOwed.contactId, status: "new" });
  assert.deepEqual(await retryWithoutSend(notOwed.job, notOwed.executionId), { ok: true });
  assert.deepEqual(metadataOf(executionOf(notOwed.executionId)), { should_send: false, blocked_reason: "active_engagement", blocked_detail: null, job_id: notOwed.job.id });

  // The gate stays in the spine.
  const gated = await freshFailedTouch();
  store.contacts!.find((c) => c.id === gated.contactId)!.sms_opt_out = true;
  assert.deepEqual(await retryWithoutSend(gated.job, gated.executionId), { ok: true });
  assert.equal(metadataOf(executionOf(gated.executionId)).blocked_reason, "contact_opted_out");

  // No stale rule on retry: a touch now far past due is still retried.
  const stale = await freshFailedTouch();
  trace.length = 0;
  assert.deepEqual(await retryDerivedTouch(db as never, probe() as never, { job: { ...stale.job, completed_at: daysAgo(400) }, config }, stale.executionId, SERVICE_EXECUTION_OPS as never, T0), { ok: true });
  assert.ok(!trace.includes("dueAt") && !trace.includes("isDue"), "neither cadence nor lateness is re-evaluated");
  assert.equal(executionOf(stale.executionId).outcome, "succeeded");

  // A known-missing subject closes the existing execution as blocked, whatever the missingSubject policy (here: skip).
  const missing = await freshFailedTouch();
  store.contacts!.find((c) => c.id === missing.contactId)!.organization_id = OTHER_ORG;
  assert.deepEqual(await retryWithoutSend(missing.job, missing.executionId), { ok: true });
  assert.deepEqual(metadataOf(executionOf(missing.executionId)), { should_send: false, blocked_reason: "contact_not_found", blocked_detail: null, job_id: missing.job.id });
});

test("22. no callback sprawl: the adapter contract is a fixed set of pure functions + policy values; no before/after/on hooks", () => {
  const runtime = readFileSync(path.join(process.cwd(), "lib/automation/touch-runtime.ts"), "utf8");
  const contract = runtime.slice(runtime.indexOf("export type DerivedTouchAdapter"), runtime.indexOf("export type DerivedTouchResult"));
  const members = [...contract.matchAll(/^  (\w+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(members, ["auditFields", "compose", "dueAt", "gateOptions", "idempotencyKey", "identity", "isDue", "payload", "policy", "stillOwed", "subject"]);
  assert.doesNotMatch(runtime, /\b(before|after)[A-Z]\w*\s*[:?(]|\bon[A-Z]\w*\s*[:?(]/, "no hook members or calls");
  const policy = runtime.slice(runtime.indexOf("export type DerivedTouchPolicy"), runtime.indexOf("export type DerivedTouchAdapter"));
  assert.deepEqual([...policy.matchAll(/^  (\w+):/gm)].map((m) => m[1]).sort(), ["gateChecksAutomationEnabled", "missingSubject", "requiresActivePayment", "senderType", "stale"]);
});
