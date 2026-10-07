/**
 * P0-B B2.6: appointment reminders on the shared touch runtime. The
 * producer (window scan, then the reminder, then - only after a sent
 * reminder - the appointment-specific confirmation_requested_at write), Run
 * Now's trigger source, the adapter, B1 verification, cancellation and
 * reschedule, the A2 retry through retryDerivedTouch, the read-only preview,
 * and the single-send-spine guard.
 *
 * The same in-memory store as the A4 suite (plus paging, multi-column order
 * and a pre-query hook); the REAL events, executions, B0-shaped start,
 * outbound gate, B1 snapshot loader, A2 classifier + retry path run. The SMS
 * provider is mocked. Old-vs-new parity is proven separately (see the B2.6
 * report); these tests pin the behaviour the migration must keep.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/appointment-reminders.runtime.test.ts
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
const control = { sendOk: true, admin: true, hours: [] as Row[], startLoses: false, snapshotFails: false, confirmationWriteFails: false };
const trace: string[] = [];

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
    if (this.table === "appointments" && this.updateValues && control.confirmationWriteFails) return { data: null, error: { message: "confirmation write failed (test)" } };
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
process.env.VERCEL_ENV = "preview";
const { processAppointmentReminders, previewAppointmentReminders, retryAppointmentReminder, APPOINTMENT_REMINDER_ADAPTER, isReminderDue, composeReminderBody } = await import(lib("lib/automation/appointment-reminders.ts"));
const { classifyFailedExecutions, processDueRetries } = await import(lib("lib/automation/execution-retry.ts"));
const { SERVICE_EXECUTION_OPS, startWorkflowExecutionAsService } = await import(lib("lib/automation/executions.ts"));
const { AUTOMATION_CATALOG } = await import(lib("lib/automation/catalog.ts"));

// Only the B1 lifecycle snapshot loader reads `opportunities`: that read marks the snapshot, and failing it fails the REAL loader.
const SNAPSHOT_MARKER = "opportunities";
const FOREIGN = "77777777-7777-4777-8777-777777777777";
const inHours = (h: number) => new Date(T0.getTime() + h * HOUR).toISOString();
const appt = (extra: Row = {}) => {
  const row = { id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: null, title: "Roof inspection", status: "scheduled", start_at: inHours(20), end_at: inHours(21), updated_at: inHours(-120), created_at: inHours(-120), confirmation_requested_at: null, ...extra };
  store.appointments!.push(row);
  return row as Row & { id: string };
};

beforeEach(() => {
  store = {
    organizations: [
      { id: ORG, automation_mode: "live", payment_status: "active", automation_paused: false, name: "QA Fixture Roofing", vertical: "contractor", timezone: "UTC" },
      { id: OTHER_ORG, automation_mode: "live", payment_status: "active", automation_paused: false },
    ],
    contacts: [
      { id: CONTACT, organization_id: ORG, first_name: "Riley", phone: "+15550142301", phone_normalized: "+15550142301", sms_opt_out: false },
      { id: OTHER_CONTACT, organization_id: ORG, first_name: "Other", phone: "+15550142302", phone_normalized: "+15550142302", sms_opt_out: false },
      { id: FOREIGN, organization_id: OTHER_ORG, first_name: "Foreign", phone: "+15550142307", phone_normalized: "+15550142307", sms_opt_out: false },
    ],
    automation_settings: [{ organization_id: ORG, automation_id: "appointment-reminders", enabled: true, config: null }],
    leads: [], followups: [], conversations: [], messages: [], appointments: [], estimates: [], jobs: [], invoices: [], automation_events: [], workflow_executions: [],
  };
  ids = 100;
  clock = T0;
  calls.sends = 0; calls.signals = []; calls.n8n = 0;
  control.sendOk = true; control.admin = true; control.hours = []; control.startLoses = false; control.snapshotFails = false; control.confirmationWriteFails = false;
  trace.length = 0;
  hooks.beforeRun = (table, eqs, write) => {
    if (table === SNAPSHOT_MARKER) trace.push("snapshot");
    if (table === "conversations") trace.push("conversation");
    if (table === "appointments" && write) trace.push(`confirmation:${eqs.id}:${eqs.organization_id}`);
  };
});

const run = (now: Date = T0, triggerSource?: "manual") => (triggerSource ? processAppointmentReminders(db as never, now, undefined, triggerSource) : processAppointmentReminders(db as never, now));
const touchEvents = () => store.automation_events!.filter((e) => e.event_type === "appointment.reminder");
const touchExecutions = () => store.workflow_executions!.filter((e) => e.workflow_name === "appointment_reminder");
const outbound = () => store.messages!.filter((m) => m.direction === "outbound");
async function captureStarts<T>(fn: () => Promise<T>): Promise<{ result: T; starts: Row[] }> {
  const starts: Row[] = [];
  const realRpc = db.rpc;
  (db as Row).rpc = (name: string, args: Row) => {
    if (name === "start_workflow_execution") starts.push({ ...args });
    if (name === "complete_workflow_execution") trace.push("complete");
    return realRpc(name, args);
  };
  try {
    return { result: await fn(), starts };
  } finally {
    (db as Row).rpc = realRpc;
  }
}
type Outcomes = { outcomes: Row[] };

test("1. cron sends through the shared runtime with trigger 'event'; Run Now with 'manual' - the touch's event and appointment_reminder reach B0", async () => {
  const a = appt();
  const cron = await captureStarts(() => run());
  assert.deepEqual((cron.result as Outcomes).outcomes, [{ appointmentId: a.id, outcome: "sent", messageId: "m" }]);
  const [event] = touchEvents();
  assert.equal(event.idempotency_key, `appointment.reminder:${a.id}:${a.start_at}`);
  assert.deepEqual(event.payload, { appointment_id: a.id, contact_id: CONTACT, lead_id: null, start_at: a.start_at });
  assert.deepEqual(cron.starts, [{ p_automation_event_id: event.id, p_workflow_name: "appointment_reminder", p_metadata: {}, p_trigger_source: "event" }]);
  const b = appt({ contact_id: OTHER_CONTACT, start_at: inHours(22), end_at: inHours(23) });
  const manual = await captureStarts(() => run(T0, "manual"));
  const manualEvent = touchEvents().find((e) => e.entity_id === b.id)!;
  assert.deepEqual(manual.starts, [{ p_automation_event_id: manualEvent.id, p_workflow_name: "appointment_reminder", p_metadata: {}, p_trigger_source: "manual" }]);
});

test("2. confirmation_requested_at: written for THIS appointment (id + organization), only after a sent reminder that asked for it - never on a block, failure, retry or confirmed appointment", async () => {
  const asked = appt();
  const other = appt({ contact_id: OTHER_CONTACT, start_at: inHours(60), end_at: inHours(61) }); // not due
  const { result } = await captureStarts(() => run());
  assert.equal((result as Outcomes).outcomes[0].outcome, "sent");
  assert.ok(asked.confirmation_requested_at, "set");
  assert.equal(other.confirmation_requested_at, null, "no other appointment touched");
  const confirmation = trace.indexOf(`confirmation:${asked.id}:${ORG}`);
  assert.ok(trace.indexOf("send") >= 0 && confirmation > trace.indexOf("send"), "written only after the reminder was actually sent");
  assert.equal(trace.filter((step) => step.startsWith("confirmation:")).length, 1);

  // Already confirmed: plain reminder, no write.
  trace.length = 0;
  const confirmed = appt({ status: "confirmed", contact_id: OTHER_CONTACT, start_at: inHours(21), end_at: inHours(22) });
  await run();
  assert.equal(confirmed.confirmation_requested_at, null);
  assert.equal(trace.filter((step) => step.startsWith("confirmation:")).length, 0);

  // A gate block and a failed send: no write.
  store.contacts![0].sms_opt_out = true;
  const blocked = appt({ start_at: inHours(19), end_at: inHours(20) });
  control.sendOk = false;
  const failed = appt({ contact_id: OTHER_CONTACT, start_at: inHours(18), end_at: inHours(19) });
  const mixed = (await run()) as Outcomes;
  assert.deepEqual(mixed.outcomes.filter((o) => [blocked.id, failed.id].includes(o.appointmentId as string)).map((o) => o.outcome).sort(), ["blocked", "failed"]);
  assert.equal(blocked.confirmation_requested_at, null);
  assert.equal(failed.confirmation_requested_at, null);

  // A2's retry of the failed one sends, and (as always) writes nothing.
  control.sendOk = true;
  await classifyFailedExecutions(db as never, T0);
  assert.equal((await processDueRetries(db as never, new Date(T0.getTime() + HOUR))).started.length, 1);
  assert.equal(touchExecutions().find((e) => e.attempt === 2)!.outcome, "succeeded");
  assert.equal(failed.confirmation_requested_at, null, "a retry never writes confirmation_requested_at");
});

test("3. a confirmation write error is logged and the reminder still counts as sent - the execution is already recorded succeeded", async () => {
  const a = appt();
  control.confirmationWriteFails = true;
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    assert.deepEqual(((await run()) as Outcomes).outcomes, [{ appointmentId: a.id, outcome: "sent", messageId: "m" }]);
  } finally {
    console.error = original;
  }
  assert.equal(a.confirmation_requested_at, null);
  assert.equal(touchExecutions()[0].outcome, "succeeded");
  assert.match(JSON.stringify(errors), /failed to record confirmation_requested_at/);
});

test("4. B1: an unknown lifecycle fails closed (nothing recorded, still eligible); a contact that is not the organization's is recorded blocked contact_not_found - no conversation, no send, no confirmation write", async () => {
  const a = appt();
  control.snapshotFails = true;
  assert.deepEqual(((await run()) as Outcomes).outcomes, [{ appointmentId: a.id, outcome: "failed", error: "lifecycle_snapshot_failed: snapshot read failed (test)" }]);
  assert.equal(touchEvents().length + touchExecutions().length + calls.sends, 0);
  assert.equal(a.confirmation_requested_at, null);
  control.snapshotFails = false;
  assert.equal(((await run()) as Outcomes).outcomes[0].outcome, "sent", "still eligible");

  const foreign = appt({ contact_id: FOREIGN, start_at: inHours(22), end_at: inHours(23) });
  store.conversations = [];
  const sendsBefore = calls.sends;
  const out = ((await run()) as Outcomes).outcomes.find((o) => o.appointmentId === foreign.id);
  assert.deepEqual(out, { appointmentId: foreign.id, outcome: "blocked", reason: "contact_not_found" });
  const execution = touchExecutions().find((e) => e.automation_event_id === touchEvents().find((ev) => ev.entity_id === foreign.id)!.id)!;
  assert.deepEqual(execution.metadata, { should_send: false, blocked_reason: "contact_not_found", blocked_detail: null, appointment_id: foreign.id });
  assert.equal(store.conversations!.length, 0);
  assert.equal(calls.sends, sendsBefore);
  assert.equal(foreign.confirmation_requested_at, null);
});

test("5. cancellation and reschedule: cancelled/completed/no-show are never candidates; cancelled after the scan is stopped at the gate; a reschedule is a new reminder under a new key; an obsolete reminder never sends", async () => {
  appt({ status: "cancelled" });
  appt({ status: "completed", contact_id: OTHER_CONTACT });
  appt({ status: "no_show" });
  assert.deepEqual(((await run()) as Outcomes).outcomes, []);

  store.appointments = [];
  const late = appt();
  hooks.beforeRun = (table) => {
    if (table === "conversations") late.status = "cancelled";
  };
  assert.deepEqual(((await run()) as Outcomes).outcomes, [{ appointmentId: late.id, outcome: "blocked", reason: "appointment_status_ineligible" }]);
  assert.equal(calls.sends, 0);

  hooks.beforeRun = undefined;
  store.automation_events = []; store.workflow_executions = []; store.appointments = [];
  const moved = appt();
  await run();
  const firstKey = touchEvents()[0].idempotency_key;
  Object.assign(moved, { start_at: inHours(100), end_at: inHours(101), updated_at: inHours(2) });
  assert.deepEqual(((await run(new Date(T0.getTime() + 3 * HOUR))) as Outcomes).outcomes, [], "the old reminder is obsolete: not due for the new time yet");
  const second = (await run(new Date(T0.getTime() + 80 * HOUR))) as Outcomes;
  assert.equal(second.outcomes[0].outcome, "sent");
  assert.deepEqual(touchEvents().map((e) => e.idempotency_key), [firstKey, `appointment.reminder:${moved.id}:${inHours(100)}`]);
  // Rescheduled inside the window with short notice: the stability guard holds it back.
  const shortNotice = appt({ contact_id: OTHER_CONTACT, start_at: inHours(90), end_at: inHours(91), updated_at: inHours(79) });
  assert.equal((((await run(new Date(T0.getTime() + 80 * HOUR))) as Outcomes).outcomes.find((o) => o.appointmentId === shortNotice.id)), undefined);
});

test("6. idempotency: a repeat is a duplicate, concurrent runs send once, a refused B0 start sends nothing", async () => {
  appt();
  const [a, b] = (await Promise.all([run(), run()])) as Outcomes[];
  assert.deepEqual([a.outcomes[0].outcome, b.outcomes[0].outcome].sort(), ["sent", "skipped_duplicate"]);
  assert.equal(((await run(new Date(T0.getTime() + HOUR))) as Outcomes).outcomes[0].outcome, "skipped_duplicate");
  assert.equal(calls.sends, 1);
  control.startLoses = true;
  appt({ contact_id: OTHER_CONTACT, start_at: inHours(22), end_at: inHours(23) });
  const refused = (await quiet(() => run())) as Outcomes;
  assert.equal(refused.outcomes.find((o) => o.outcome !== "skipped_duplicate")!.outcome, "failed");
  assert.equal(calls.sends, 1);
});

test("7. A2 retry: same event, trigger 'retry'; B1 then the gate then the send; no window re-check; gate and B1 enforced; foreign contact blocked; missing appointment fails", async () => {
  control.sendOk = false;
  const a = appt();
  await run();
  control.sendOk = true;
  const event = touchEvents()[0];
  await classifyFailedExecutions(db as never, T0);
  trace.length = 0;
  // Far past the appointment by the time A2 retries: the retry still runs (the window is never re-evaluated on a retry, as before).
  const { result, starts } = await captureStarts(() => processDueRetries(db as never, new Date(T0.getTime() + 48 * HOUR)));
  assert.equal((result as { started: unknown[] }).started.length, 1);
  assert.deepEqual(starts, [{ p_automation_event_id: event.id, p_workflow_name: "appointment_reminder", p_metadata: {}, p_trigger_source: "retry" }]);
  assert.ok(trace.indexOf("snapshot") >= 0 && trace.indexOf("snapshot") < trace.lastIndexOf("conversation"), "B1 before the send path");
  const retried = touchExecutions().find((e) => e.attempt === 2)!;
  assert.deepEqual({ outcome: retried.outcome, trigger_source: retried.trigger_source }, { outcome: "succeeded", trigger_source: "retry" });
  assert.equal(touchEvents().length, 1);

  const retryOn = async (appointment: Row, payload: Row) => {
    const e2 = touchEvents().find((ev) => ev.entity_id === appointment.id)!;
    const id = (await startWorkflowExecutionAsService(db as never, e2.id as string, "appointment_reminder", {}, "retry")).execution.id as string;
    const before = calls.sends;
    const out = await retryAppointmentReminder(db as never, { organizationId: ORG, entityType: "appointment", entityId: appointment.id as string, payload }, id, SERVICE_EXECUTION_OPS);
    return { out, id, sent: calls.sends - before };
  };
  const failNext = async (extra: Row) => {
    control.sendOk = false;
    const x = appt(extra);
    await run();
    control.sendOk = true;
    return x;
  };
  const unknown = await failNext({ contact_id: OTHER_CONTACT, start_at: inHours(21), end_at: inHours(22) });
  control.snapshotFails = true;
  const u = await retryOn(unknown, {});
  control.snapshotFails = false;
  assert.deepEqual([u.out, u.sent], [{ ok: false, error: "lifecycle_snapshot_failed" }, 0]);

  const cancelled = await failNext({ start_at: inHours(19), end_at: inHours(20) });
  cancelled.status = "cancelled";
  const c = await retryOn(cancelled, {});
  assert.deepEqual([c.out, c.sent], [{ ok: true }, 0]);
  assert.equal((store.workflow_executions!.find((e) => e.id === c.id)!.metadata as Row).blocked_reason, "appointment_status_ineligible");

  const foreign = await failNext({ start_at: inHours(18), end_at: inHours(19) });
  foreign.contact_id = FOREIGN;
  const f = await retryOn(foreign, {});
  assert.deepEqual([f.out, f.sent], [{ ok: true }, 0]);
  assert.deepEqual(store.workflow_executions!.find((e) => e.id === f.id)!.metadata, { should_send: false, blocked_reason: "contact_not_found", blocked_detail: null, appointment_id: foreign.id });

  const gone = await failNext({ start_at: inHours(17), end_at: inHours(18) });
  const goneEvent = touchEvents().find((ev) => ev.entity_id === gone.id)!;
  store.appointments = store.appointments!.filter((x) => x.id !== gone.id);
  const goneId = (await startWorkflowExecutionAsService(db as never, goneEvent.id as string, "appointment_reminder", {}, "retry")).execution.id as string;
  assert.deepEqual(await retryAppointmentReminder(db as never, { organizationId: ORG, entityType: "appointment", entityId: gone.id, payload: {} }, goneId, SERVICE_EXECUTION_OPS), { ok: false, error: "The appointment no longer exists." });
  assert.ok(a);
});

test("8. the message and sender are unchanged (with and without the confirmation ask)", async () => {
  const a = appt();
  await run();
  assert.equal(outbound()[0].body, composeReminderBody(a, "UTC"));
  assert.match(String(outbound()[0].body), /^Reminder: your appointment "Roof inspection" is scheduled for .* Reply CONFIRM to confirm, or let us know if you need to reschedule\. Reply STOP to opt out of texts\.$/);
  assert.equal(outbound()[0].sender_type, "ai");
  appt({ status: "confirmed", contact_id: OTHER_CONTACT, start_at: inHours(22), end_at: inHours(23) });
  await run();
  assert.doesNotMatch(String(outbound()[1].body), /CONFIRM/);
});

test("9. preview stays read-only: no claim, no execution, no send, no confirmation write, no appointment change", async () => {
  appt();
  const before = JSON.stringify(store);
  const { result, starts } = await captureStarts(() => previewAppointmentReminders(db as never, ORG, T0));
  assert.equal((result as Row).outcome, "would_send");
  assert.deepEqual(starts, []);
  assert.equal(JSON.stringify(store), before);
  assert.ok(!trace.some((step) => step === "snapshot" || step.startsWith("confirmation:")));
});

test("10. the adapter: appointment policy as data + pure functions, matching the catalog; legacy key; no stale, payment, business-hours or enabled-at-gate rule", () => {
  assert.deepEqual(Object.keys(APPOINTMENT_REMINDER_ADAPTER).sort(), ["auditFields", "compose", "dueAt", "gateOptions", "idempotencyKey", "identity", "isDue", "payload", "policy", "stillOwed", "subject"]);
  assert.deepEqual(APPOINTMENT_REMINDER_ADAPTER.policy, { requiresActivePayment: false, stale: { mode: "none" }, missingSubject: "record_blocked", gateChecksAutomationEnabled: false, senderType: "ai" });
  const entry = AUTOMATION_CATALOG.find((x: Row) => x.id === APPOINTMENT_REMINDER_ADAPTER.identity.automationId);
  assert.ok((entry.eventTypes as string[]).includes(APPOINTMENT_REMINDER_ADAPTER.identity.eventType));
  assert.ok((entry.workflowNames as string[]).includes(APPOINTMENT_REMINDER_ADAPTER.identity.workflowName));
  const appointment = { id: "a1", organization_id: ORG, contact_id: CONTACT, lead_id: "l1", title: "T", start_at: inHours(20), end_at: inHours(21), status: "scheduled", updated_at: inHours(-120) };
  const config = { reminder_lead_time_hours: 24 };
  const item = { appointment, config };
  assert.equal(APPOINTMENT_REMINDER_ADAPTER.idempotencyKey(item), `appointment.reminder:a1:${inHours(20)}`);
  assert.deepEqual(APPOINTMENT_REMINDER_ADAPTER.auditFields(item), { appointment_id: "a1" });
  assert.deepEqual(APPOINTMENT_REMINDER_ADAPTER.gateOptions(item, { timezone: "UTC" }), { appointmentId: "a1", appointmentEligibleStatuses: ["scheduled", "confirmed"] });
  assert.deepEqual(APPOINTMENT_REMINDER_ADAPTER.subject(item), { organizationId: ORG, contactId: CONTACT, leadId: "l1", entityType: "appointment", entityId: "a1" });
  for (const [start, updated, now] of [[20, -120, 0], [30, -120, 0], [20, -1, 0], [-1, -120, 0]] as const) {
    const candidate = { ...appointment, start_at: inHours(start), updated_at: inHours(updated) };
    assert.equal(APPOINTMENT_REMINDER_ADAPTER.isDue({ appointment: candidate, config }, new Date(T0.getTime() + now * HOUR)), isReminderDue(candidate, config, new Date(T0.getTime() + now * HOUR)));
  }
  assert.equal(APPOINTMENT_REMINDER_ADAPTER.isDue({ appointment, config: null }, T0), false, "a retry item has no reminder window");
  // Fixed expectations (not just equivalence): the 24h window's edges and the stability guard.
  const at = (startMs: number, updatedH = -120) => APPOINTMENT_REMINDER_ADAPTER.isDue({ appointment: { ...appointment, start_at: new Date(startMs).toISOString(), updated_at: inHours(updatedH) }, config }, T0);
  assert.equal(at(T0.getTime() + 24 * HOUR), true, "exactly 24h out is due");
  assert.equal(at(T0.getTime() + 24 * HOUR + 1), false, "just past 24h is not");
  assert.equal(at(T0.getTime() + 1), true, "1ms out is still due");
  assert.equal(at(T0.getTime()), false, "starting now is never due");
  assert.equal(at(T0.getTime() + 20 * HOUR, -4), true, "start_at set before its due point (20h - 24h = -4h) is stable");
  assert.equal(at(T0.getTime() + 20 * HOUR, -3.9), false, "set after its due point: not stable yet");
});

test("11. one send spine: appointment-reminders.ts holds no claim, gate, lifecycle, conversation, send or execution-completion of its own; the runtime knows nothing of appointments or confirmation", () => {
  const source = readFileSync(path.join(process.cwd(), "lib/automation/appointment-reminders.ts"), "utf8");
  for (const own of ["sendOutboundMessage(", "evaluateOutboundGate(", "findOrCreateOpenConversation(", "failWorkflowExecutionAsService(", "completeWorkflowExecutionAsService(", "startWorkflowExecutionAsService(", "createAutomationEventAsService(", "verifyLifecycle(", "claimTouch(", "executeTouch("]) {
    assert.ok(!source.includes(own), `appointment-reminders.ts still calls ${own}`);
  }
  assert.match(source, /runDerivedTouch\(supabase, APPOINTMENT_REMINDER_ADAPTER,/);
  assert.match(source, /retryDerivedTouch\(supabase, APPOINTMENT_REMINDER_ADAPTER,/);
  assert.equal(source.match(/confirmation_requested_at: new Date\(\)\.toISOString\(\)/g)?.length, 1, "one confirmation write, in the producer");
  const runtime = readFileSync(path.join(process.cwd(), "lib/automation/touch-runtime.ts"), "utf8");
  assert.doesNotMatch(runtime, /appointment|confirmation/i);
});

test("12. Run Now (the real admin action) records the reminder under trigger 'manual'", async () => {
  const { runAutomationNow } = await import(lib("app/(app)/automations/actions.ts"));
  store.organization_members = [{ organization_id: ORG, user_id: USER, role: "owner", organizations: { name: "QA Fixture Roofing", payment_status: "active", vertical: "contractor" } }];
  // The action runs on the wall clock: an appointment 20h from real now is due.
  const real = Date.now();
  const a = appt({ start_at: new Date(real + 20 * HOUR).toISOString(), end_at: new Date(real + 21 * HOUR).toISOString(), updated_at: new Date(real - 120 * HOUR).toISOString() });
  const { starts } = await captureStarts(() => quiet(() => runAutomationNow("appointment-reminders")));
  const event = touchEvents().find((e) => e.entity_id === a.id)!;
  assert.ok(event, "the Run Now action ran the reminder scan");
  assert.deepEqual(starts.filter((s) => s.p_automation_event_id === event.id), [{ p_automation_event_id: event.id, p_workflow_name: "appointment_reminder", p_metadata: {}, p_trigger_source: "manual" }]);
  assert.equal(touchExecutions().find((e) => e.automation_event_id === event.id)!.trigger_source, "manual");
});
