/**
 * P0-B B2.5: estimate follow-up on the shared touch runtime. The producer
 * (expiry first, then the touch), Run Now's trigger source, the adapter,
 * the K5-3 overdue record, B1 verification, the A2 retry through
 * retryDerivedTouch, the read-only preview, and the single-send-spine
 * guard.
 *
 * The same in-memory store as the A4 suite (plus paging, multi-column order
 * and a pre-query hook); the REAL events, executions, B0-shaped start,
 * outbound gate, B1 snapshot loader, A2 classifier + retry path run. The SMS
 * provider is mocked. Old-vs-new parity is proven separately (see the B2.5
 * report); these tests pin the behaviour the migration must keep.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/estimate-followups.runtime.test.ts
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
    if (this.table === "opportunities" && control.snapshotFails) return { data: null, error: { message: "snapshot read failed (test)" } };
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
process.env.VERCEL_ENV = "preview";
const { processEstimateFollowups, previewEstimateFollowups, retryEstimateWorkflow, ESTIMATE_FOLLOWUP_ADAPTER, STALE_FOLLOWUP_GRACE_HOURS, computeFollowupOccurrence } = await import(lib("lib/automation/estimate-followups.ts"));
const { classifyFailedExecutions, processDueRetries } = await import(lib("lib/automation/execution-retry.ts"));
const { SERVICE_EXECUTION_OPS, startWorkflowExecutionAsService } = await import(lib("lib/automation/executions.ts"));
const { LATE_TOUCH_GRACE_HOURS } = await import(lib("lib/automation/late-touch.ts"));
const { AUTOMATION_CATALOG } = await import(lib("lib/automation/catalog.ts"));

// Only the B1 lifecycle snapshot loader reads `opportunities`: that read marks the snapshot, and failing it fails the REAL loader.
const SNAPSHOT_MARKER = "opportunities";
const FOREIGN_CONTACT = "77777777-7777-4777-8777-777777777777";
const sentAgo = (h: number) => new Date(T0.getTime() - h * HOUR).toISOString();
const est = (extra: Row = {}) => {
  const row = { id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: null, title: "Roof replacement", status: "sent", sent_at: sentAgo(25), expires_at: null, created_at: sentAgo(30), ...extra };
  store.estimates!.push(row);
  return row as Row & { id: string };
};
const trace: string[] = [];

beforeEach(() => {
  store = {
    organizations: [
      { id: ORG, automation_mode: "live", payment_status: "active", automation_paused: false, name: "QA Fixture Roofing", vertical: "contractor", timezone: "UTC" },
      { id: OTHER_ORG, automation_mode: "live", payment_status: "active", automation_paused: false },
    ],
    contacts: [
      { id: CONTACT, organization_id: ORG, first_name: "Riley", phone: "+15550142301", phone_normalized: "+15550142301", sms_opt_out: false },
      { id: OTHER_CONTACT, organization_id: ORG, first_name: "Other", phone: "+15550142302", phone_normalized: "+15550142302", sms_opt_out: false },
      { id: FOREIGN_CONTACT, organization_id: OTHER_ORG, first_name: "Foreign", phone: "+15550142307", phone_normalized: "+15550142307", sms_opt_out: false },
    ],
    automation_settings: [{ organization_id: ORG, automation_id: "estimate-followup", enabled: true, config: null }],
    leads: [], followups: [], conversations: [], messages: [], appointments: [], estimates: [], jobs: [], invoices: [], automation_events: [], workflow_executions: [],
  };
  ids = 100;
  clock = T0;
  calls.sends = 0; calls.signals = []; calls.n8n = 0;
  control.sendOk = true; control.admin = true; control.hours = []; control.startLoses = false; control.snapshotFails = false;
  trace.length = 0;
  hooks.beforeRun = (table) => {
    if (table === SNAPSHOT_MARKER) trace.push("snapshot");
    if (table === "conversations") trace.push("conversation");
  };
});

const run = (now: Date = T0, triggerSource?: "manual") => (triggerSource ? processEstimateFollowups(db as never, now, undefined, triggerSource) : processEstimateFollowups(db as never, now));
const touchEvents = () => store.automation_events!.filter((e) => e.event_type === "estimate.followup");
const touchExecutions = () => store.workflow_executions!.filter((e) => e.workflow_name === "estimate_followup");
async function captureStarts<T>(fn: () => Promise<T>): Promise<{ result: T; starts: Row[] }> {
  const starts: Row[] = [];
  const realRpc = db.rpc;
  (db as Row).rpc = (name: string, args: Row) => {
    if (name === "start_workflow_execution") starts.push({ ...args });
    if (name === "create_automation_event") trace.push("claim");
    return realRpc(name, args);
  };
  try {
    return { result: await fn(), starts };
  } finally {
    (db as Row).rpc = realRpc;
  }
}

// ===========================================================================
// Producer: expiry first, then the touch through the shared runtime
// ===========================================================================

test("1. cron sends through the shared runtime with trigger 'event'; Run Now with 'manual' - the touch's event and estimate_followup reach B0", async () => {
  const e = est();
  const cron = await captureStarts(() => run());
  assert.deepEqual((cron.result as Row).outcomes, [{ estimateId: e.id, outcome: "sent", occurrence: 1, messageId: "m" }]);
  const [event] = touchEvents();
  assert.equal(event.idempotency_key, `estimate.followup:${e.id}:1`);
  assert.deepEqual(cron.starts, [{ p_automation_event_id: event.id, p_workflow_name: "estimate_followup", p_metadata: {}, p_trigger_source: "event" }]);

  const manualEstimate = est({ contact_id: OTHER_CONTACT });
  store.conversations = [];
  const manual = await captureStarts(() => run(T0, "manual"));
  const manualEvent = touchEvents().find((ev) => ev.entity_id === manualEstimate.id)!;
  assert.deepEqual(manual.starts, [{ p_automation_event_id: manualEvent.id, p_workflow_name: "estimate_followup", p_metadata: {}, p_trigger_source: "manual" }]);
  assert.equal(touchExecutions().find((x) => x.automation_event_id === manualEvent.id)!.trigger_source, "manual");
});

test("2. expiry stays in the producer, BEFORE the enabled check, under the run's trigger source - and never goes through the touch runtime", async () => {
  store.automation_settings![0].enabled = false;
  const e = est({ expires_at: sentAgo(1) });
  const { result, starts } = await captureStarts(() => run(T0, "manual"));
  assert.deepEqual((result as Row).outcomes, [{ estimateId: e.id, outcome: "expired" }]);
  assert.equal(e.status, "expired", "the sent -> expired write ran although the automation is off");
  assert.deepEqual(starts, [], "disabled: the expiry event is skipped, so no execution (as before)");
  assert.ok(!trace.includes("snapshot"), "no lifecycle verification for expiry - it is not a touch");

  store.automation_settings![0].enabled = true;
  const live = est({ expires_at: sentAgo(1), contact_id: OTHER_CONTACT });
  const enabled = await captureStarts(() => run(T0, "manual"));
  assert.deepEqual((enabled.result as Row).outcomes, [{ estimateId: live.id, outcome: "expired" }]);
  const expiredEvent = store.automation_events!.find((ev) => ev.idempotency_key === `estimate.expired:${live.id}`)!;
  assert.deepEqual(expiredEvent.payload, { estimate_id: live.id });
  assert.deepEqual(enabled.starts, [{ p_automation_event_id: expiredEvent.id, p_workflow_name: "estimate_expired_lifecycle", p_metadata: {}, p_trigger_source: "manual" }]);
  const runtime = readFileSync(path.join(process.cwd(), "lib/automation/touch-runtime.ts"), "utf8");
  assert.doesNotMatch(runtime, /expire|estimate/i, "the generic runtime knows nothing of expiry or estimates");
});

test("3. cadence and touch selection: sent_at anchor, the organization's hours, touch 2 preferred when both are due; not due records nothing", async () => {
  store.automation_settings![0].config = { followup_1_hours: 12, followup_2_hours: 36 };
  const notDue = est({ sent_at: sentAgo(11) });
  const one = est({ sent_at: sentAgo(13), contact_id: OTHER_CONTACT });
  const both = est({ sent_at: sentAgo(40), contact_id: null });
  const { outcomes } = await run();
  assert.deepEqual(outcomes.map((o: Row) => [o.estimateId, o.outcome, o.occurrence ?? null]), [[notDue.id, "not_due", null], [one.id, "sent", 1], [both.id, "blocked", null]]);
  assert.deepEqual(touchEvents().map((ev) => ev.idempotency_key).sort(), [`estimate.followup:${both.id}:2`, `estimate.followup:${one.id}:1`].sort());
  assert.equal(computeFollowupOccurrence(40, { followup_1_hours: 12, followup_2_hours: 36 }), 2);
});

test("4. overdue: more than 48h late is recorded as blocked followup_overdue with exactly {estimate_id, occurrence}; exactly 48h still sends", async () => {
  assert.equal(STALE_FOLLOWUP_GRACE_HOURS, LATE_TOUCH_GRACE_HOURS, "the estimate rule and the runtime's stale threshold are the same 48 hours");
  store.automation_settings![0].config = { followup_1_hours: 24, followup_2_hours: 200 };
  const onTime = est({ sent_at: sentAgo(72) });
  const late = est({ sent_at: new Date(T0.getTime() - 72 * HOUR - 60000).toISOString(), contact_id: OTHER_CONTACT });
  const { outcomes } = await run(T0, "manual");
  assert.deepEqual(outcomes.map((o: Row) => o.outcome), ["sent", "blocked"]);
  const lateExecution = touchExecutions().find((x) => x.automation_event_id === touchEvents().find((ev) => ev.entity_id === late.id)!.id)!;
  assert.deepEqual(lateExecution.metadata, { should_send: false, blocked_reason: "followup_overdue", blocked_detail: "48 hours past due", estimate_id: late.id, occurrence: 1 });
  assert.equal(lateExecution.trigger_source, "manual");
  assert.equal(lateExecution.outcome, "blocked");
  assert.ok(onTime);
  assert.equal(calls.sends, 1);
});

test("5. B1: an unknown lifecycle fails closed (nothing recorded, still eligible); a contact that is not the organization's is recorded blocked contact_not_found - no conversation, no send", async () => {
  const e = est();
  control.snapshotFails = true;
  assert.deepEqual((await run()).outcomes, [{ estimateId: e.id, outcome: "failed", error: "lifecycle_snapshot_failed: snapshot read failed (test)" }]);
  assert.equal(touchEvents().length + touchExecutions().length + calls.sends, 0);
  control.snapshotFails = false;
  assert.equal((await run()).outcomes[0].outcome, "sent", "the touch stayed eligible");

  const foreign = est({ contact_id: FOREIGN_CONTACT });
  store.conversations = [];
  trace.length = 0;
  const result = await run();
  assert.deepEqual(result.outcomes.find((o: Row) => o.estimateId === foreign.id), { estimateId: foreign.id, outcome: "blocked", reason: "contact_not_found" });
  const execution = touchExecutions().find((x) => x.automation_event_id === touchEvents().find((ev) => ev.entity_id === foreign.id)!.id)!;
  assert.deepEqual(execution.metadata, { should_send: false, blocked_reason: "contact_not_found", blocked_detail: null, estimate_id: foreign.id, occurrence: 1 });
  assert.equal(store.conversations!.length, 0, "no conversation resolved for a foreign contact");
  assert.equal(calls.sends, 1);
});

test("6. the gate decides with the estimate's own options; a send failure is a failed execution; a refused B0 start sends nothing", async () => {
  const e = est();
  hooks.beforeRun = (table) => {
    if (table === "conversations") e.status = "accepted";
  };
  assert.deepEqual((await run()).outcomes, [{ estimateId: e.id, outcome: "blocked", reason: "estimate_status_ineligible" }]);
  hooks.beforeRun = undefined;
  control.sendOk = false;
  const failing = est({ contact_id: OTHER_CONTACT });
  const out = (await run()).outcomes.find((o: Row) => o.estimateId === failing.id);
  assert.equal(out.outcome, "failed");
  const failedExecution = touchExecutions().find((x) => x.status === "failed")!;
  assert.equal(failedExecution.outcome, "failed");
  control.sendOk = true;
  control.startLoses = true;
  const refused = est({ contact_id: null, sent_at: sentAgo(30) });
  const sendsBefore = calls.sends;
  const refusedOut = ((await quiet(() => run())) as { outcomes: Row[] }).outcomes.find((o: Row) => o.estimateId === refused.id);
  assert.equal(refusedOut?.outcome, "failed");
  assert.equal(calls.sends, sendsBefore);
});

test("7. the message and sender are unchanged", async () => {
  est({ title: "Deck repair" });
  await run();
  const [message] = store.messages!.filter((m) => m.direction === "outbound");
  assert.equal(message.body, 'Just checking in on the estimate we sent for "Deck repair" - happy to answer any questions. Reply STOP to opt out of texts.');
  assert.equal(message.sender_type, "ai");
  const second = est({ title: "Deck repair", sent_at: sentAgo(73), contact_id: OTHER_CONTACT });
  await run();
  assert.equal(store.messages!.filter((m) => m.direction === "outbound" && m.workflow_execution_id === touchExecutions().find((x) => x.automation_event_id === touchEvents().find((ev) => ev.entity_id === second.id)!.id)!.id)[0].body, 'Following up one more time on the estimate for "Deck repair" - let us know if you\'d like to move forward or have any questions. Reply STOP to opt out of texts.');
});

// ===========================================================================
// A2 retry through the shared retry entry
// ===========================================================================

async function failedTouch(extra: Row = {}) {
  control.sendOk = false;
  const e = est(extra);
  await run();
  control.sendOk = true;
  const event = touchEvents().find((ev) => ev.entity_id === e.id)!;
  return { e, event };
}

test("8. A2 retry: same event, same occurrence, trigger 'retry'; B1 then the gate then the send; no stale rule; no second B0 start by the runtime", async () => {
  const { e, event } = await failedTouch({ sent_at: sentAgo(25) });
  await classifyFailedExecutions(db as never, T0);
  trace.length = 0;
  // Far past due by the time A2 retries: the retry must still run (no stale rule on retry).
  const { result, starts } = await captureStarts(() => processDueRetries(db as never, new Date(T0.getTime() + 100 * HOUR)));
  assert.equal((result as { started: unknown[] }).started.length, 1);
  assert.equal(starts.length, 1, "A2's own start only");
  assert.deepEqual(starts[0], { p_automation_event_id: event.id, p_workflow_name: "estimate_followup", p_metadata: {}, p_trigger_source: "retry" });
  const retried = touchExecutions().find((x) => x.attempt === 2)!;
  assert.deepEqual({ outcome: retried.outcome, trigger_source: retried.trigger_source }, { outcome: "succeeded", trigger_source: "retry" });
  assert.deepEqual(retried.metadata, { should_send: true, message_id: "m", conversation_id: (retried.metadata as Row).conversation_id, provider_message_id: "SM", estimate_id: e.id, occurrence: 1 });
  assert.ok(trace.indexOf("snapshot") >= 0 && trace.indexOf("snapshot") < trace.lastIndexOf("conversation"), "B1 before the send path");
  assert.equal(touchEvents().length, 1, "same event");
});

test("9. A2 retry fails closed on an unknown lifecycle, respects the gate, and closes a foreign-contact touch as blocked - never sending", async () => {
  const unknown = await failedTouch();
  let executionId = (await startWorkflowExecutionAsService(db as never, unknown.event.id as string, "estimate_followup", {}, "retry")).execution.id as string;
  control.snapshotFails = true;
  let sendsBefore = calls.sends;
  assert.deepEqual(await retryEstimateWorkflow(db as never, { organizationId: ORG, entityType: "estimate", entityId: unknown.e.id, payload: unknown.event.payload as Row }, executionId, "estimate_followup", SERVICE_EXECUTION_OPS), { ok: false, error: "lifecycle_snapshot_failed" });
  assert.match(String(store.workflow_executions!.find((x) => x.id === executionId)!.error_message), /lifecycle_snapshot_failed/);
  assert.equal(calls.sends, sendsBefore, "no send on an unknown lifecycle");
  control.snapshotFails = false;

  const gated = await failedTouch({ contact_id: OTHER_CONTACT });
  executionId = (await startWorkflowExecutionAsService(db as never, gated.event.id as string, "estimate_followup", {}, "retry")).execution.id as string;
  gated.e.status = "declined";
  sendsBefore = calls.sends;
  assert.deepEqual(await retryEstimateWorkflow(db as never, { organizationId: ORG, entityType: "estimate", entityId: gated.e.id, payload: gated.event.payload as Row }, executionId, "estimate_followup", SERVICE_EXECUTION_OPS), { ok: true });
  assert.equal((store.workflow_executions!.find((x) => x.id === executionId)!.metadata as Row).blocked_reason, "estimate_status_ineligible");
  assert.equal(calls.sends, sendsBefore, "no send past the gate");

  const foreign = await failedTouch({ sent_at: sentAgo(26) }); // a genuinely failed send, then its contact turns out not to be the organization's
  executionId = (await startWorkflowExecutionAsService(db as never, foreign.event.id as string, "estimate_followup", {}, "retry")).execution.id as string;
  foreign.e.contact_id = FOREIGN_CONTACT;
  sendsBefore = calls.sends;
  assert.deepEqual(await retryEstimateWorkflow(db as never, { organizationId: ORG, entityType: "estimate", entityId: foreign.e.id, payload: foreign.event.payload as Row }, executionId, "estimate_followup", SERVICE_EXECUTION_OPS), { ok: true });
  assert.deepEqual(store.workflow_executions!.find((x) => x.id === executionId)!.metadata, { should_send: false, blocked_reason: "contact_not_found", blocked_detail: null, estimate_id: foreign.e.id, occurrence: 1 });
  assert.equal(calls.sends, sendsBefore, "no send for a foreign contact");
});

test("10. retry keeps its estimate-specific steps: missing reference / estimate / occurrence fail the execution; expiry retry stays lifecycle-only", async () => {
  const { e, event } = await failedTouch();
  let executionId = (await startWorkflowExecutionAsService(db as never, event.id as string, "estimate_followup", {}, "retry")).execution.id as string;
  assert.deepEqual(await retryEstimateWorkflow(db as never, { organizationId: ORG, entityType: "estimate", entityId: e.id, payload: { estimate_id: e.id } }, executionId, "estimate_followup", SERVICE_EXECUTION_OPS), { ok: false, error: "Missing follow-up occurrence." });
  const expiring = est({ contact_id: OTHER_CONTACT });
  const expiredEvent = { id: uuid(), organization_id: ORG, event_type: "estimate.expired", entity_type: "estimate", entity_id: expiring.id, payload: { estimate_id: expiring.id }, idempotency_key: `estimate.expired:${expiring.id}`, status: "failed" };
  store.automation_events!.push(expiredEvent);
  executionId = (await startWorkflowExecutionAsService(db as never, expiredEvent.id, "estimate_expired_lifecycle", {}, "retry")).execution.id as string;
  trace.length = 0;
  assert.deepEqual(await retryEstimateWorkflow(db as never, { organizationId: ORG, entityType: "estimate", entityId: expiring.id, payload: expiredEvent.payload }, executionId, "estimate_expired_lifecycle", SERVICE_EXECUTION_OPS), { ok: true });
  assert.equal(expiring.status, "expired");
  assert.deepEqual(store.workflow_executions!.find((x) => x.id === executionId)!.metadata, { lifecycle_only: true, estimate_id: expiring.id });
  assert.ok(!trace.includes("snapshot"), "expiry retry never enters the touch runtime");
});

// ===========================================================================
// Preview, adapter, architecture
// ===========================================================================

test("11. preview stays read-only: no claim, no execution, no send, no estimate change", async () => {
  const e = est();
  const late = est({ sent_at: sentAgo(300), contact_id: OTHER_CONTACT });
  const expiring = est({ expires_at: sentAgo(1), contact_id: null });
  const before = JSON.stringify(store);
  const { result, starts } = await captureStarts(() => previewEstimateFollowups(db as never, ORG, T0));
  assert.ok(["would_send", "would_expire"].includes((result as Row).outcome as string));
  assert.deepEqual(starts, []);
  assert.equal(JSON.stringify(store), before, "nothing written");
  assert.ok(!trace.includes("snapshot") && !trace.includes("claim"));
  assert.ok(e && late && expiring);
});

test("12. the adapter: estimate policy as data + pure functions, matching the catalog; legacy key; no payment, BH or enabled-at-gate rule", () => {
  assert.deepEqual(Object.keys(ESTIMATE_FOLLOWUP_ADAPTER).sort(), ["auditFields", "compose", "dueAt", "gateOptions", "idempotencyKey", "identity", "isDue", "payload", "policy", "stillOwed", "subject", "verifyClaimed"]);
  assert.deepEqual(ESTIMATE_FOLLOWUP_ADAPTER.policy, { requiresActivePayment: false, stale: { mode: "record_blocked", audit: "audit_fields" }, missingSubject: "record_blocked", gateChecksAutomationEnabled: false, senderType: "ai", auditRecord: { shape: "full" } });
  const entry = AUTOMATION_CATALOG.find((a: Row) => a.id === ESTIMATE_FOLLOWUP_ADAPTER.identity.automationId);
  assert.ok((entry.eventTypes as string[]).includes(ESTIMATE_FOLLOWUP_ADAPTER.identity.eventType));
  assert.ok((entry.workflowNames as string[]).includes(ESTIMATE_FOLLOWUP_ADAPTER.identity.workflowName));
  const item = { estimate: { id: "e1", organization_id: ORG, contact_id: CONTACT, lead_id: "l1", title: "T", status: "sent", sent_at: sentAgo(25), expires_at: null }, config: { followup_1_hours: 24, followup_2_hours: 72 }, occurrence: 1 };
  assert.equal(ESTIMATE_FOLLOWUP_ADAPTER.idempotencyKey(item), "estimate.followup:e1:1");
  assert.deepEqual(ESTIMATE_FOLLOWUP_ADAPTER.auditFields(item), { estimate_id: "e1", occurrence: 1 });
  assert.deepEqual(ESTIMATE_FOLLOWUP_ADAPTER.payload(item, null), { estimate_id: "e1", contact_id: CONTACT, lead_id: "l1", occurrence: 1 });
  assert.deepEqual(ESTIMATE_FOLLOWUP_ADAPTER.gateOptions(item, item.estimate), { estimateId: "e1", estimateEligibleStatuses: ["sent"] });
  assert.deepEqual(ESTIMATE_FOLLOWUP_ADAPTER.subject(item), { organizationId: ORG, contactId: CONTACT, leadId: "l1", entityType: "estimate", entityId: "e1" });
  assert.equal(ESTIMATE_FOLLOWUP_ADAPTER.isDue(item, T0), true);
  assert.equal(ESTIMATE_FOLLOWUP_ADAPTER.isDue({ ...item, occurrence: 2 }, T0), false, "the selected touch must still be the due one");
  assert.equal(ESTIMATE_FOLLOWUP_ADAPTER.isDue({ ...item, config: null }, T0), false, "a retry item has no cadence");
});

test("13. one send spine: estimate-followups.ts holds no claim, gate, lifecycle, send or execution-completion of its own for the touch", () => {
  const source = readFileSync(path.join(process.cwd(), "lib/automation/estimate-followups.ts"), "utf8");
  for (const own of ["sendOutboundMessage(", "evaluateOutboundGate(", "findOrCreateOpenConversation(", "failWorkflowExecutionAsService(", "verifyLifecycle(", "claimTouch(", "executeTouch(", "recordOverdueTouch("]) {
    assert.ok(!source.includes(own), `estimate-followups.ts still calls ${own}`);
  }
  assert.match(source, /runDerivedTouch\(supabase, ESTIMATE_FOLLOWUP_ADAPTER,/);
  assert.match(source, /retryDerivedTouch\(supabase, ESTIMATE_FOLLOWUP_ADAPTER,/);
  // The only touch-execution writes left are expiry's (a lifecycle event, not a touch).
  assert.equal(source.match(/startWorkflowExecutionAsService\(/g)?.length, 1);
  assert.equal(source.match(/completeWorkflowExecutionAsService\(/g)?.length, 1);
});
