/**
 * P0-B B2.7: invoice reminders on the shared touch runtime. The producer
 * (organization and invoice scan, 9:00-18:00 window, stages, delivery quiet
 * period, duplicate prefetch, one reminder per customer per local day) hands
 * each stage to runDerivedTouch with INVOICE_REMINDER_ADAPTER: B1, the claim
 * (legacy key + B0), the post-claim live re-read (verifyClaimed: invoice and
 * payment link), the REAL outbound gate, the send and the minimal record.
 * Invoice reminders have no A2 retry.
 *
 * The same in-memory store as the other runtime suites; the REAL events,
 * executions (B0-shaped start), outbound gate, payment link, B1 snapshot
 * loader and A2 eligibility run. The SMS provider is mocked; Date is mocked
 * so the gate's own stage check sees the run's clock. Old-vs-new parity is
 * proven separately (see the B2.7 report); these tests pin the behaviour.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/invoice-reminders.runtime.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;
type Row = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const ORG2 = "99999999-9999-4999-8999-999999999999";
const C1 = "22222222-2222-4222-8222-222222222222";
const C2 = "33333333-3333-4333-8333-333333333333";
const C3 = "55555555-5555-4555-8555-555555555555";
const FOREIGN = "77777777-7777-4777-8777-777777777777";
const HOUR = 3600_000;
// Monday 2026-10-05 16:00Z = 10:00 America/Denver.
const T0 = new Date("2026-10-05T16:00:00.000Z");
const TOKEN = "b".repeat(48);
const trace: string[] = [];
const hooks: { beforeTable: ((table: string) => void) | null } = { beforeTable: null };

let store: Record<string, Row[]> = {};
let ids = 0;
let clock = T0;
const control: { sendOk: boolean; snapshotFails: boolean; failEventKeys: Set<string>; failStartKeys: Set<string>; afterEvent: ((e: Row) => void) | null; failInvoiceScanOrg: string | null } = { sendOk: true, snapshotFails: false, failEventKeys: new Set(), failStartKeys: new Set(), afterEvent: null, failInvoiceScanOrg: null };
let sends: Row[] = [];

function deriveOutcome(row: Row) {
  const metadata = (row.metadata ?? {}) as Row;
  row.outcome = row.status === "running" ? null : row.status === "completed" ? (metadata.blocked_reason ? "blocked" : "succeeded") : row.status === "failed" ? "failed" : null;
}
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const DEFAULTS: Record<string, () => Row> = { conversations: () => ({ status: "open", ai_enabled: true, created_at: clock.toISOString() }) };

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
  constructor(table: string) { this.table = table; }
  select(_c?: string, opts?: { count?: string; head?: boolean }) { if (opts?.head) this.head = true; return this; }
  eq(c: string, v: unknown) { this.eqs[c] = v; this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  range(from: number, to: number) { this.window = [from, to]; return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, op: string, v: unknown) { this.filters.push((r) => (op === "is" ? (r[c] ?? null) !== v : true)); return this; }
  or(expr: string) { const parts = expr.split(",").map((p) => p.split(".")); this.filters.push((r) => parts.some(([c, op, v]) => op === "eq" && String(r[c]) === v)); return this; }
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
    hooks.beforeTable?.(this.table);
    if (this.table === "opportunities") trace.push("snapshot");
    if (this.table === "conversations") trace.push("conversation");
    if (this.table === "invoices" && this.eqs.id && this.eqs.organization_id) trace.push("reread");
    if (this.table === "opportunities" && control.snapshotFails) return { data: null, error: { message: "snapshot read failed (test)" } };
    if (this.table === "invoices" && control.failInvoiceScanOrg && this.eqs.organization_id === control.failInvoiceScanOrg && this.window) return { data: null, error: { message: "scan failed (test)" } };
    const rows = (store[this.table] ??= []);
    if (this.insertRows) {
      const inserted: Row[] = this.insertRows.map((r) => ({ id: uuid(), ...(DEFAULTS[this.table]?.() ?? {}), ...r }));
      rows.push(...inserted);
      return { data: single ? { ...inserted[0] } : inserted.map((r) => ({ ...r })), error: null };
    }
    let matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.updateValues) for (const r of matched) Object.assign(r, this.updateValues);
    if (this.head) return { data: null, error: null, count: matched.length };
    if (this.sorts.length) matched = [...matched].sort((a, b) => { for (const { column, ascending } of this.sorts) { const d = String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0; if (d) return d * (ascending ? 1 : -1); } return 0; });
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
    if (name === "is_org_admin") return { data: true, error: null };
    if (name === "create_automation_event") {
      if (control.failEventKeys.has(String(args.p_idempotency_key))) return { data: null, error: { message: "insert failed (test)" } };
      const existing = events.find((e) => e.organization_id === args.p_organization_id && e.idempotency_key === args.p_idempotency_key);
      if (existing) return { data: { ...existing, is_duplicate: true }, error: null };
      const event = { id: uuid(), organization_id: args.p_organization_id, event_type: args.p_event_type, entity_type: args.p_entity_type, entity_id: args.p_entity_id, payload: args.p_payload, idempotency_key: args.p_idempotency_key, status: "pending", created_at: clock.toISOString() };
      events.push(event);
      trace.push("event");
      control.afterEvent?.(event);
      return { data: { ...event, is_duplicate: false }, error: null };
    }
    if (name === "start_workflow_execution") {
      const event = events.find((e) => e.id === args.p_automation_event_id);
      if (!event) return { data: null, error: { message: "Automation event not found" } };
      if (control.failStartKeys.has(String(event.idempotency_key))) return { data: null, error: { message: "Automation event is already being processed" } };
      if (event.status === "processing") return { data: null, error: { message: "Automation event is already being processed" } };
      if (event.status === "completed") return { data: null, error: { message: "Automation event has already completed" } };
      const attempt = Math.max(0, ...executions.filter((e) => e.automation_event_id === event.id).map((e) => Number(e.attempt))) + 1;
      const row: Row = { id: uuid(), organization_id: event.organization_id, automation_event_id: event.id, workflow_name: args.p_workflow_name, status: "running", attempt, started_at: clock.toISOString(), completed_at: null, error_message: null, metadata: args.p_metadata ?? {}, trigger_source: args.p_trigger_source, retry_state: null, next_retry_at: null, max_attempts: null, retry_detail: null, failure_category: null };
      deriveOutcome(row);
      executions.push(row);
      trace.push("start");
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
      Object.assign(execution, { status: "failed", error_message: args.p_error_message, failure_category: args.p_failure_category ?? null, completed_at: clock.toISOString() });
      if (event?.status === "processing") event.status = "failed";
    } else return { data: null, error: { message: `unexpected rpc ${name}` } };
    deriveOutcome(execution);
    return { data: { ...execution }, error: null };
  };
  return { single: run, then: <T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) => run().then(resolve, reject) };
}
const db = { from: (t: string) => new Query(t), rpc, auth: { getUser: async () => ({ data: { user: null } }) } };

mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async (_s: unknown, input: Row) => {
      trace.push("send");
      sends.push({ contactId: input.contactId, conversationId: input.conversationId, body: input.body, senderType: input.senderType, channel: input.channel, workflowExecutionId: input.workflowExecutionId });
      if (!control.sendOk) return { ok: false, error: "Twilio error 30003: unreachable +15550142301", messageId: null, conversationId: null };
      const id = uuid();
      store.messages!.push({ id, organization_id: input.organizationId, conversation_id: input.conversationId, workflow_execution_id: input.workflowExecutionId, direction: "outbound", body: input.body, sender_type: input.senderType, created_at: clock.toISOString() });
      return { ok: true, messageId: id, conversationId: input.conversationId, providerMessageId: "SM-provider" };
    },
  },
});
// The REAL gate, observed: every decision is traced.
const realGate = await import(lib("lib/automation/outbound-gate.ts"));
mock.module(lib("lib/automation/outbound-gate.ts"), {
  namedExports: {
    ...realGate,
    evaluateOutboundGate: async (...args: Parameters<typeof realGate.evaluateOutboundGate>) => {
      trace.push("gate");
      return realGate.evaluateOutboundGate(...args);
    },
  },
});
const signals: Row[] = [];
mock.module(lib("lib/automation-health/service.ts"), { namedExports: { recordAutomationHealthSignal: async (_s: unknown, input: Row) => (signals.push(input), { occurrenceCount: 1 }), resolveAutomationFailureIncidents: async () => undefined } });
const realSettings = await import(lib("lib/settings/queries.ts"));
mock.module(lib("lib/settings/queries.ts"), {
  namedExports: {
    ...realSettings,
    getOrganizationTimezone: async (_s: unknown, organizationId: string) => (store.organizations!.find((o) => o.id === organizationId)?.timezone as string | null) ?? "UTC",
    getBusinessHours: async () => [],
    getAiSettings: async () => ({ ai_enabled: true }),
  },
});
process.env.APP_BASE_URL = "https://app.example.test";
process.env.VERCEL_ENV = "preview";
mock.timers.enable({ apis: ["Date"], now: T0.getTime() });

const { processInvoiceReminders, INVOICE_REMINDER_ADAPTER, composeInvoiceReminderMessage, INVOICE_REMINDER_SEND_FAILED_MESSAGE } = await import(lib("lib/automation/invoice-reminders.ts"));
const { SAFE_RETRY_AUTOMATION_IDS, AUTOMATIC_RETRY_POLICY } = await import(lib("lib/automation/retry-eligibility.ts"));
const { runDerivedTouch } = await import(lib("lib/automation/touch-runtime.ts"));
const { retryWorkflowExecutionAsService } = await import(lib("lib/automation/retry.ts"));
const { decideRetry, classifyFailedExecutions, processDueRetries } = await import(lib("lib/automation/execution-retry.ts"));

const day = (d: number) => new Date(Date.UTC(2026, 9, 5 - d)).toISOString().slice(0, 10);
const ago = (h: number) => new Date(T0.getTime() - h * HOUR).toISOString();
let invSeq = 0;
function reset() {
  store = {
    organizations: [
      { id: ORG, name: "Acme Roofing", timezone: "America/Denver", payment_status: "active", automation_mode: "live", automation_paused: false, stripe_connect_account_id: "acct_1", stripe_connect_charges_enabled: true },
      { id: ORG2, name: "Other Co", timezone: "America/Denver", payment_status: "active", automation_mode: "live", automation_paused: false, stripe_connect_account_id: "acct_2", stripe_connect_charges_enabled: true },
    ],
    contacts: [
      { id: C1, organization_id: ORG, first_name: "Riley", phone: "+15550142301", phone_normalized: "+15550142301", sms_opt_out: false },
      { id: C2, organization_id: ORG, first_name: "Sam", phone: "+15550142302", phone_normalized: "+15550142302", sms_opt_out: false },
      { id: C3, organization_id: ORG2, first_name: "Kai", phone: "+15550142303", phone_normalized: "+15550142303", sms_opt_out: false },
      { id: FOREIGN, organization_id: ORG2, first_name: "Foreign", phone: "+15550142307", phone_normalized: "+15550142307", sms_opt_out: false },
    ],
    automation_settings: [{ organization_id: ORG, automation_id: "invoice-reminders", enabled: true, config: null }, { organization_id: ORG2, automation_id: "invoice-reminders", enabled: true, config: null }],
    leads: [], conversations: [], messages: [], appointments: [], estimates: [], jobs: [], invoices: [], automation_events: [], workflow_executions: [], opportunities: [],
  };
  ids = 1000; invSeq = 0; sends = []; clock = T0; mock.timers.setTime(T0.getTime());
  trace.length = 0;
  signals.length = 0;
  hooks.beforeTable = null;
  control.sendOk = true; control.snapshotFails = false; control.failEventKeys = new Set(); control.failStartKeys = new Set(); control.afterEvent = null; control.failInvoiceScanOrg = null;
}
function inv(days: number, extra: Row = {}): Row {
  const n = ++invSeq;
  const row = { id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`, organization_id: ORG, number: n, status: "sent", balance_due: 450, due_date: day(days), contact_id: C1, payment_token: TOKEN, voided_at: null, job_id: null, ...extra };
  store.invoices!.push(row);
  return row;
}
function delivered(invoice: Row, hours: number) {
  store.automation_events!.push({ id: uuid(), organization_id: invoice.organization_id, event_type: "invoice.delivered", entity_type: "invoice", entity_id: invoice.id, payload: {}, idempotency_key: `invoice.delivered:${invoice.id}:${hours}`, status: "completed", created_at: ago(hours) });
}
function priorReminder(invoice: Row, stage: number, hoursAgo: number, execution: "completed_blocked" | "failed" | "succeeded" | "none", contactId = invoice.contact_id) {
  const event = { id: uuid(), organization_id: invoice.organization_id, event_type: "invoice.reminder", entity_type: "invoice", entity_id: invoice.id, payload: { invoice_id: invoice.id, contact_id: contactId, stage }, idempotency_key: `invoice.reminder:${invoice.id}:${stage}`, status: execution === "none" ? "pending" : "completed", created_at: ago(hoursAgo) };
  store.automation_events!.push(event);
  if (execution !== "none") {
    const row: Row = { id: uuid(), organization_id: invoice.organization_id, automation_event_id: event.id, workflow_name: "invoice_reminder", status: execution === "failed" ? "failed" : "completed", attempt: 1, metadata: execution === "completed_blocked" ? { should_send: false, blocked_reason: "contact_opted_out" } : { should_send: true, sent: true }, error_message: execution === "failed" ? "The invoice reminder SMS could not be sent." : null, started_at: ago(hoursAgo), completed_at: ago(hoursAgo), trigger_source: "event" };
    deriveOutcome(row);
    store.workflow_executions!.push(row);
  }
}
const runAt = async (hoursLater = 0, dateDriftHours = 0) => {
  clock = new Date(T0.getTime() + hoursLater * HOUR);
  mock.timers.setTime(clock.getTime() + dateDriftHours * HOUR);
  const r = await processInvoiceReminders(db as never, clock, { log: () => {} });
  return r;
};

beforeEach(() => reset());

type RunResult = { candidates: number; sent: number; failed: number; scanFailed: boolean; outcomes: { invoiceId: string | null; outcome: string; stage?: number; reason?: string }[] };
const run = (hoursLater = 0, dateDriftHours = 0) => runAt(hoursLater, dateDriftHours) as Promise<RunResult>;
const labels = (r: RunResult) => r.outcomes.map((o) => `${o.invoiceId === null ? "org" : `#${String(o.invoiceId).slice(-2)}`}:${o.outcome}${o.stage ? `@${o.stage}` : ""}${o.reason ? `:${o.reason}` : ""}`);
const reminderEvents = () => store.automation_events!.filter((e) => e.event_type === "invoice.reminder");
const executionOf = (invoice: Row, stage = 1) => {
  const event = reminderEvents().find((e) => e.idempotency_key === `invoice.reminder:${invoice.id}:${stage}`);
  return event ? store.workflow_executions!.find((x) => x.automation_event_id === event.id) : undefined;
};
const step = (name: string) => trace.indexOf(name);

// ---------------------------------------------------------------- candidates

test("1. statuses: only sent and partially_paid invoices are candidates", async () => {
  const sent = inv(3, { contact_id: C1 });
  const partial = inv(3, { status: "partially_paid", contact_id: C2 });
  for (const status of ["draft", "paid", "void"]) delivered(inv(3, { status }), 100);
  delivered(sent, 100);
  delivered(partial, 100);
  const r = await run();
  assert.equal(r.candidates, 2);
  assert.deepEqual(labels(r), ["#01:sent@1", "#02:sent@1"]);
});

test("2. due-date window: 1 to 20 days overdue (organization's today); due today, not yet due and 21+ are never candidates", async () => {
  for (const d of [0, -2, 21]) delivered(inv(d), 100);
  delivered(inv(1), 100);
  delivered(inv(20, { contact_id: C2 }), 100);
  const r = await run();
  assert.equal(r.candidates, 2);
  assert.deepEqual(labels(r), ["#05:sent@14", "#04:sent@1"], "oldest due date first");
});

test("3/4/5. stages: 1-6 -> 1, 7-13 -> 7, 14-20 -> 14; the gate's stage check passes for each", async () => {
  for (const [days, stage] of [[1, 1], [6, 1], [7, 7], [13, 7], [14, 14], [20, 14]] as const) {
    reset();
    delivered(inv(days), 100);
    const r = await run();
    assert.deepEqual(labels(r), [`#01:sent@${stage}`], `${days} days`);
    assert.equal(reminderEvents()[0].idempotency_key, `invoice.reminder:${store.invoices![0].id}:${stage}`);
  }
});

test("6. no backfill: an earlier stage whose window passed is never sent - 15 days overdue with no stage 1/7 sends only stage 14", async () => {
  delivered(inv(15), 100);
  const r = await run();
  assert.deepEqual(labels(r), ["#01:sent@14"]);
  assert.deepEqual(reminderEvents().map((e) => (e.payload as Row).stage), [14]);
});

test("7. organization isolation: each organization's own invoices, deliveries, keys and customer-day only", async () => {
  const mine = inv(3);
  delivered(mine, 100);
  const theirs = inv(3, { organization_id: ORG2, contact_id: C3 });
  delivered(theirs, 100);
  // Org-2 events that would block org-1 if not scoped: a reminder with org-1's key and org-1's contact today.
  store.automation_events!.push({ id: uuid(), organization_id: ORG2, event_type: "invoice.reminder", entity_type: "invoice", entity_id: mine.id, payload: { contact_id: C1 }, idempotency_key: `invoice.reminder:${mine.id}:1`, status: "completed", created_at: ago(1) });
  const r = await run();
  assert.deepEqual(labels(r).sort(), ["#01:sent@1", "#02:sent@1"]);
  const [mineEvent, theirEvent] = [mine, theirs].map((i) => reminderEvents().find((e) => e.entity_id === i.id && e.organization_id === i.organization_id && (e.payload as Row).invoice_id));
  assert.equal(mineEvent!.organization_id, ORG);
  assert.equal(theirEvent!.organization_id, ORG2);
  assert.deepEqual(sends.map((s) => s.contactId).sort(), [C1, C3].sort());
  // The post-claim re-read is organization-scoped too: another organization's invoice is never found.
  const verdict = await INVOICE_REMINDER_ADAPTER.verifyClaimed(db as never, { organization: store.organizations![0], invoice: theirs, stage: 1, today: "2026-10-05" } as never, { invoice: theirs, paymentUrl: null } as never);
  assert.deepEqual(verdict, { verdict: "blocked", reason: "invoice_not_found" });
});

test("8. send window: 09:00 inclusive to 18:00 exclusive in the organization's timezone, UTC when it has none", async () => {
  store.automation_settings = [store.automation_settings![0]];
  delivered(inv(3), 100);
  assert.deepEqual(labels(await run(-1 - 1 / 60)), ["org:outside_hours"], "08:59 Denver");
  assert.deepEqual(labels(await run(-1)), ["#01:sent@1"], "09:00 Denver is inside");
  reset();
  delivered(inv(3), 100);
  assert.deepEqual(labels(await run(7 + 59 / 60)), ["#01:sent@1"], "17:59");
  reset();
  store.organizations![0].timezone = null;
  delivered(inv(3), 100);
  assert.deepEqual(labels(await run()), ["#01:sent@1"], "16:00 UTC fallback is inside");
  reset();
  store.organizations![0].timezone = "Asia/Tokyo";
  delivered(inv(3), 100);
  assert.deepEqual(labels(await run()), ["org:outside_hours"], "01:00 Tokyo");
});

test("9. outside hours: nothing read beyond the organization, nothing recorded or sent", async () => {
  delivered(inv(3), 100);
  const r = await run(8);
  assert.deepEqual(labels(r), ["org:outside_hours", "org:outside_hours"], "18:00 Denver, both opted-in organizations");
  assert.deepEqual([reminderEvents().length, store.workflow_executions!.length, sends.length, trace.includes("snapshot")], [0, 0, 0, false]);
});

// ---------------------------------------------------------------- delivery

test("10/11/12. delivery: none -> not_delivered; under 48h -> recently_delivered (latest delivery counts); over 48h -> sent; nothing recorded for the first two", async () => {
  inv(3, { contact_id: C1 });
  delivered(inv(3, { contact_id: C2 }), 47);
  const older = inv(3, { contact_id: C1 });
  delivered(older, 100);
  delivered(older, 10);
  const r = await run();
  assert.deepEqual(labels(r), ["#01:not_delivered@1", "#02:recently_delivered@1", "#03:recently_delivered@1"]);
  assert.equal(reminderEvents().length, 0);
  reset();
  delivered(inv(3), 49);
  assert.deepEqual(labels(await run()), ["#01:sent@1"]);
});

// ---------------------------------------------------------------- idempotency

test("13. canonical key invoice.reminder:<invoice_id>:<stage>, entity invoice, payload exactly { invoice_id, number, contact_id, stage, due_date, days_overdue }", async () => {
  const i = inv(3);
  delivered(i, 100);
  await run();
  const [event] = reminderEvents();
  assert.deepEqual({ key: event.idempotency_key, entity: event.entity_type, id: event.entity_id }, { key: `invoice.reminder:${i.id}:1`, entity: "invoice", id: i.id });
  assert.deepEqual(event.payload, { invoice_id: i.id, number: 1, contact_id: C1, stage: 1, due_date: i.due_date, days_overdue: 3 });
  const [execution] = store.workflow_executions!;
  assert.deepEqual({ workflow: execution.workflow_name, trigger: execution.trigger_source, event: execution.automation_event_id }, { workflow: "invoice_reminder", trigger: "event", event: event.id });
});

test("14. duplicate stage: an existing key (any outcome) is a duplicate - nothing new recorded or sent", async () => {
  const i = inv(3);
  delivered(i, 100);
  priorReminder(i, 1, 48, "failed");
  const r = await run();
  assert.deepEqual(labels(r), ["#01:duplicate@1"]);
  assert.deepEqual([reminderEvents().length, store.workflow_executions!.length, sends.length], [1, 1, 0]);
});

test("15. concurrent runs claim once: one sent, one duplicate, one event, one execution, one send", async () => {
  delivered(inv(3), 100);
  const [a, b] = await Promise.all([run(), run()]);
  assert.deepEqual([...labels(a), ...labels(b)].sort(), ["#01:duplicate@1", "#01:sent@1"]);
  assert.deepEqual([reminderEvents().length, store.workflow_executions!.length, sends.length], [1, 1, 1]);
});

test("16. stage independence: stage 1's key never blocks stage 7, and a failed stage 1 is not retried while stage 7 still runs", async () => {
  control.sendOk = false;
  const i = inv(3);
  delivered(i, 100);
  assert.deepEqual(labels(await run()), ["#01:failed@1:sms_send_failed"]);
  control.sendOk = true;
  assert.deepEqual(labels(await run(1)), ["#01:duplicate@1"]);
  assert.deepEqual(labels(await run(5 * 24)), ["#01:sent@7"]);
  assert.deepEqual(reminderEvents().map((e) => e.idempotency_key), [`invoice.reminder:${i.id}:1`, `invoice.reminder:${i.id}:7`]);
});

// ---------------------------------------------------------------- customer-day

test("17. a customer already reminded today (local day) gets no other stage event; yesterday does not count", async () => {
  const today = inv(3);
  delivered(today, 100);
  priorReminder(inv(30), 14, 2, "succeeded");
  assert.deepEqual(labels(await run()), ["#01:contact_reminded_today@1"]);
  assert.equal(reminderEvents().length, 1, "only the prior one");
  reset();
  delivered(inv(3), 100);
  priorReminder(inv(30), 14, 20, "succeeded");
  assert.deepEqual(labels(await run()), ["#01:sent@1"]);
});

test("18/19/20. a blocked, a failed and an execution-less reminder event today each consume the customer's day", async () => {
  for (const kind of ["completed_blocked", "failed", "none"] as const) {
    reset();
    delivered(inv(3), 100);
    priorReminder(inv(30), 14, 2, kind);
    assert.deepEqual(labels(await run()), ["#01:contact_reminded_today@1"], kind);
    assert.equal(sends.length, 0, kind);
  }
});

test("21. same run: the customer is marked before the stage runs - even when its event then fails - so their other invoices wait", async () => {
  delivered(inv(9), 100);
  delivered(inv(3), 100);
  delivered(inv(4, { contact_id: C2 }), 100);
  assert.deepEqual(labels(await run()), ["#01:sent@7", "#03:sent@1", "#02:contact_reminded_today@1"], "oldest due date first");
  reset();
  const first = inv(9);
  delivered(first, 100);
  delivered(inv(3), 100);
  control.failEventKeys.add(`invoice.reminder:${first.id}:7`);
  assert.deepEqual(labels(await run()), ["#01:failed@7:event_not_recorded", "#02:contact_reminded_today@1"]);
  assert.deepEqual([reminderEvents().length, store.workflow_executions!.length, sends.length], [0, 0, 0]);
});

// ---------------------------------------------------------------- claimed verification

test("22. refreshed invoice facts: the message uses the invoice re-read after the claim, never the scan's copy", async () => {
  const i = inv(3);
  delivered(i, 100);
  control.afterEvent = () => {
    i.balance_due = 99;
    i.number = 77;
  };
  assert.deepEqual(labels(await run()), ["#01:sent@1"]);
  assert.match(String(sends[0].body), /^Acme Roofing: Invoice INV-000077 was due Oct 2, 2026 and still has a balance of \$99\. Pay securely: https:\/\/app\.example\.test\/pay\/b{48} Reply STOP to opt out\.$/);
  assert.deepEqual((reminderEvents()[0].payload as Row).number, 1, "the payload is the claimed stage's scan facts");
});

test("23. refreshed contact: the conversation, gate and send use the invoice's contact as re-read after the claim", async () => {
  const i = inv(3);
  delivered(i, 100);
  control.afterEvent = () => {
    i.contact_id = C2;
  };
  assert.deepEqual(labels(await run()), ["#01:sent@1"]);
  assert.equal(sends[0].contactId, C2);
  assert.deepEqual(store.conversations!.map((c) => c.contact_id), [C2]);
  // The gate decides on the refreshed contact: an opted-out refreshed contact is blocked.
  reset();
  const j = inv(3);
  delivered(j, 100);
  store.contacts![1].sms_opt_out = true;
  control.afterEvent = () => {
    j.contact_id = C2;
  };
  assert.deepEqual(labels(await run()), ["#01:blocked@1:contact_opted_out"]);
});

test("24. invoice missing after the claim: blocked invoice_not_found - the event and execution stand, nothing composed, gated or sent", async () => {
  for (const change of ["delete", "contact"] as const) {
    reset();
    const i = inv(3);
    delivered(i, 100);
    control.afterEvent = () => {
      if (change === "delete") store.invoices = [];
      else i.contact_id = null;
    };
    assert.deepEqual(labels(await run()), ["#01:blocked@1:invoice_not_found"], change);
    const execution = executionOf(i)!;
    assert.deepEqual({ status: execution.status, metadata: execution.metadata }, { status: "completed", metadata: { should_send: false, blocked_reason: "invoice_not_found", invoice_id: i.id, stage: 1 } });
    assert.deepEqual([step("gate"), sends.length, store.conversations!.length], [-1, 0, 0], change);
  }
});

test("25. foreign / unknown contact (known missing subject): recorded blocked contact_not_found before anything else - no conversation, no gate, no send", async () => {
  for (const contactId of [FOREIGN, "66666666-6666-4666-8666-666666666666"]) {
    reset();
    const i = inv(3, { contact_id: contactId });
    delivered(i, 100);
    assert.deepEqual(labels(await run()), ["#01:blocked@1:contact_not_found"]);
    assert.deepEqual(executionOf(i)!.metadata, { should_send: false, blocked_reason: "contact_not_found", invoice_id: i.id, stage: 1 });
    assert.deepEqual([store.conversations!.length, step("reread"), step("gate"), sends.length], [0, -1, -1, 0]);
    assert.deepEqual(labels(await run(1)), ["#01:duplicate@1"], "the key stays used");
  }
});

test("26. B1 read failure fails closed: nothing recorded or sent, the stage stays eligible and sends once B1 reads again", async () => {
  delivered(inv(3), 100);
  control.snapshotFails = true;
  const r = await run();
  assert.deepEqual([labels(r), r.failed], [["#01:failed@1:lifecycle_snapshot_failed"], 1]);
  assert.deepEqual([reminderEvents().length, store.workflow_executions!.length, sends.length], [0, 0, 0]);
  control.snapshotFails = false;
  assert.deepEqual(labels(await run(1)), ["#01:sent@1"]);
});

test("27. payment link unavailable after the claim: completed blocked payment_link_unavailable (outcome no_payment_link) - no compose, conversation, gate or send", async () => {
  for (const cause of ["charges", "account", "token", "paid"] as const) {
    reset();
    const i = inv(3);
    delivered(i, 100);
    control.afterEvent = () => {
      if (cause === "charges") store.organizations![0].stripe_connect_charges_enabled = false;
      if (cause === "account") store.organizations![0].stripe_connect_account_id = null;
      if (cause === "token") i.payment_token = null;
      if (cause === "paid") i.status = "paid";
    };
    const r = await run();
    assert.deepEqual([labels(r), r.failed], [["#01:no_payment_link@1:payment_link_unavailable"], 0], cause);
    const execution = executionOf(i)!;
    assert.deepEqual({ status: execution.status, outcome: execution.outcome, metadata: execution.metadata }, { status: "completed", outcome: "blocked", metadata: { should_send: false, blocked_reason: "payment_link_unavailable", invoice_id: i.id, stage: 1 } }, cause);
    assert.ok(step("start") < step("reread"), "verified only after the claim");
    assert.deepEqual([step("gate"), sends.length, store.conversations!.length], [-1, 0, 0], cause);
  }
});

test("28. a payment link restored later never re-sends the consumed stage: duplicate", async () => {
  store.organizations![0].stripe_connect_charges_enabled = false;
  delivered(inv(3), 100);
  assert.deepEqual(labels(await run()), ["#01:no_payment_link@1:payment_link_unavailable"]);
  store.organizations![0].stripe_connect_charges_enabled = true;
  assert.deepEqual(labels(await run(2)), ["#01:duplicate@1"]);
  assert.equal(sends.length, 0);
});

// ---------------------------------------------------------------- the real gate

const gateBlocks = async (setup: (i: Row) => void, reason: string, after?: (i: Row) => void) => {
  reset();
  const i = inv(3);
  delivered(i, 100);
  setup(i);
  if (after) control.afterEvent = () => after(i);
  const r = await run();
  assert.deepEqual(labels(r), [`#01:blocked@1:${reason}`], reason);
  assert.deepEqual(executionOf(i)!.metadata, { should_send: false, blocked_reason: reason, invoice_id: i.id, stage: 1 }, reason);
  assert.equal(sends.length, 0, reason);
  assert.ok(step("gate") > step("reread") && step("reread") > step("start"), `${reason}: claim -> verify -> gate`);
  // Never retried: a later run is a duplicate, or (when the scan no longer selects it) nothing at all.
  const later = labels(await run(1));
  assert.ok(later.length === 0 || later[0] === "#01:duplicate@1", `${reason}: ${later}`);
  assert.deepEqual([reminderEvents().length, store.workflow_executions!.length, sends.length], [1, 1, 0], `${reason}: never retried`);
};

test("29. gate: opted-out contact", () => gateBlocks(() => { store.contacts![0].sms_opt_out = true; }, "contact_opted_out"));
test("30. gate: AI disabled on the conversation", () => gateBlocks(() => { store.conversations!.push({ id: uuid(), organization_id: ORG, contact_id: C1, channel: "sms", status: "open", ai_enabled: false, lead_id: null }); }, "conversation_ai_disabled"));
test("31. gate: organization paused after the claim", () => gateBlocks(() => undefined, "organization_automation_paused", () => { store.organizations![0].automation_paused = true; }));
test("32. gate: automation disabled after the claim (the gate re-checks it)", () => gateBlocks(() => undefined, "automation_disabled", () => { store.automation_settings![0].enabled = false; }));
test("33. gate: contact missing a usable destination", () => gateBlocks(() => { store.contacts![0].phone = "555"; store.contacts![0].phone_normalized = null; }, "invalid_destination"));
test("34. foreign contact after the claim: blocked contact_not_found by the gate, never sent", () => gateBlocks(() => undefined, "contact_not_found", (i) => { i.contact_id = FOREIGN; }));
test("35. gate: invoice status ineligible", async () => {
  // A linkable status that the gate rejects cannot exist (both are sent/partially_paid), so the gate's status check is exercised directly on the adapter's options.
  const i = inv(3);
  delivered(i, 100);
  const item = { organization: store.organizations![0], invoice: { ...i }, stage: 1, today: "2026-10-05" };
  i.status = "draft";
  const r = await runDerivedTouch(db as never, { ...INVOICE_REMINDER_ADAPTER, verifyClaimed: async () => ({ verdict: "verified", facts: { invoice: item.invoice, paymentUrl: "https://app.example.test/pay/x" }, contactId: C1, leadId: null }) }, item, T0, { isEnabled: async () => true });
  assert.deepEqual(r, { status: "blocked", reason: "invoice_status_ineligible" });
  assert.equal(sends.length, 0);
});
test("36. gate: settled (voided) invoice", () => gateBlocks(() => undefined, "invoice_settled", (i) => { i.voided_at = T0.toISOString(); }));
test("37. gate: zero balance", () => gateBlocks(() => undefined, "invoice_settled", (i) => { i.balance_due = 0; }));
test("38. gate: contact mismatch - the verified contact is not the invoice's", async () => {
  const i = inv(3);
  delivered(i, 100);
  const item = { organization: store.organizations![0], invoice: { ...i }, stage: 1, today: "2026-10-05" };
  const r = await runDerivedTouch(db as never, { ...INVOICE_REMINDER_ADAPTER, verifyClaimed: async () => ({ verdict: "verified", facts: { invoice: item.invoice, paymentUrl: "https://app.example.test/pay/x" }, contactId: C2, leadId: null }) }, item, T0, { isEnabled: async () => true });
  assert.deepEqual(r, { status: "blocked", reason: "invoice_contact_mismatch" });
  assert.equal(sends.length, 0);
});
test("39. gate: the stage moved on by send time (the gate's own clock)", async () => {
  reset();
  const i = inv(6);
  delivered(i, 100);
  const r = await run(0, 24);
  assert.deepEqual(labels(r), ["#01:blocked@1:invoice_stage_ineligible"]);
  assert.equal(sends.length, 0);
});

// ---------------------------------------------------------------- records

test("40/41/42/43. minimal record: blocked { should_send, blocked_reason } + { invoice_id, stage } (no blocked_detail); sent { should_send, sent } + ids; failure: the fixed message only", async () => {
  // 40 - a gate denial with a detail never records it.
  const i = inv(3);
  delivered(i, 100);
  control.afterEvent = () => { i.status = "partially_paid"; store.organizations![0].automation_paused = true; };
  await run();
  assert.deepEqual(Object.keys(executionOf(i)!.metadata as Row).sort(), ["blocked_reason", "invoice_id", "should_send", "stage"]);
  // 41 - success.
  reset();
  const s = inv(3);
  delivered(s, 100);
  await run();
  assert.deepEqual(executionOf(s)!.metadata, { should_send: true, sent: true, invoice_id: s.id, stage: 1 });
  assert.ok(!JSON.stringify(store.workflow_executions).includes("SM-provider") && !JSON.stringify(store.workflow_executions).includes("Pay securely"), "no provider id or message");
  // 42 - failure.
  reset();
  control.sendOk = false;
  const f = inv(3);
  delivered(f, 100);
  const r = await run();
  assert.deepEqual([labels(r), r.failed], [["#01:failed@1:sms_send_failed"], 1]);
  const failed = executionOf(f)!;
  assert.deepEqual({ status: failed.status, error: failed.error_message }, { status: "failed", error: "The invoice reminder SMS could not be sent." });
  assert.deepEqual(signals.map((x) => x.category), ["sms_send_failed"], "the failure category");
  assert.ok(!JSON.stringify(signals).includes("Twilio"));
  assert.equal(INVOICE_REMINDER_SEND_FAILED_MESSAGE, "The invoice reminder SMS could not be sent.");
  assert.ok(!JSON.stringify(store.workflow_executions).includes("Twilio") && !JSON.stringify(r).includes("Twilio"), "the provider's error is nowhere");
  // 43 - the audit fields are exactly the invoice's ids.
  assert.deepEqual(INVOICE_REMINDER_ADAPTER.auditFields({ organization: store.organizations![0], invoice: f, stage: 7, today: "2026-10-05" } as never), { invoice_id: f.id, stage: 7 });
  assert.deepEqual(INVOICE_REMINDER_ADAPTER.policy.auditRecord, { shape: "minimal", failureMessage: "The invoice reminder SMS could not be sent." });
});

test("44. an invoice audit field can never overwrite a runtime outcome field: rejected before anything is recorded or sent", async () => {
  const i = inv(3);
  delivered(i, 100);
  const item = { organization: store.organizations![0], invoice: i, stage: 1, today: "2026-10-05" };
  for (const field of ["should_send", "sent", "blocked_reason"]) {
    const r = await runDerivedTouch(db as never, { ...INVOICE_REMINDER_ADAPTER, auditFields: () => ({ invoice_id: i.id, stage: 1, [field]: true }) }, item as never, T0, { isEnabled: async () => true });
    assert.deepEqual(r, { status: "failed", error: `audit_field_rejected:${field}` });
  }
  assert.deepEqual([reminderEvents().length, store.workflow_executions!.length, sends.length], [0, 0, 0]);
});

// ---------------------------------------------------------------- no retry

test("45/46/47. no A2 retry: manual retry is not_safely_retryable, no automatic policy, the health tick starts nothing", async () => {
  assert.ok(!SAFE_RETRY_AUTOMATION_IDS.has("invoice-reminders"));
  assert.equal(AUTOMATIC_RETRY_POLICY["invoice_reminder"], undefined);
  control.sendOk = false;
  const i = inv(3);
  delivered(i, 100);
  await run();
  const failed = executionOf(i)!;
  control.sendOk = true;
  const manual = await retryWorkflowExecutionAsService(db as never, ORG, failed.id as string);
  assert.deepEqual({ ok: manual.ok, reason: (manual as Row).reason }, { ok: false, reason: "not_safely_retryable" });
  assert.equal(decideRetry({ workflow_name: "invoice_reminder", attempt: 1, completed_at: T0.toISOString(), started_at: T0.toISOString(), automation_event_id: failed.automation_event_id as string }, T0).detail, "not_safely_retryable");
  await classifyFailedExecutions(db as never, T0);
  const due = await processDueRetries(db as never, new Date(T0.getTime() + 2 * HOUR));
  assert.deepEqual(due.started, []);
  assert.deepEqual([store.workflow_executions!.filter((e) => e.automation_event_id === failed.automation_event_id).length, sends.length], [1, 1], "one attempt, the one failed send");
});

// ---------------------------------------------------------------- send

test("48/49/50. the approved stage wording, sender system on SMS, through one open conversation (reused when it exists)", async () => {
  for (const [days, stage, opening] of [[3, 1, "Acme Roofing: Invoice INV-000001 was due Oct 2, 2026 and still has a balance of $450."], [8, 7, "Acme Roofing: Reminder: invoice INV-000001 is still outstanding. Balance due: $450."], [15, 14, "Acme Roofing: Final reminder: invoice INV-000001 is still outstanding. Balance due: $450."]] as const) {
    reset();
    const i = inv(days);
    delivered(i, 100);
    await run();
    assert.equal(sends[0].body, `${opening} Pay securely: https://app.example.test/pay/${TOKEN} Reply STOP to opt out.`, `stage ${stage}`);
    assert.equal(sends[0].body, composeInvoiceReminderMessage({ stage, businessName: "Acme Roofing", invoiceNumber: 1, balanceDue: 450, dueDate: i.due_date as string, paymentUrl: `https://app.example.test/pay/${TOKEN}` }));
    assert.deepEqual({ sender: sends[0].senderType, channel: sends[0].channel, execution: sends[0].workflowExecutionId }, { sender: "system", channel: "sms", execution: executionOf(i, stage)!.id });
    assert.deepEqual(store.conversations!.map((c) => ({ contact: c.contact_id, lead: c.lead_id, channel: c.channel })), [{ contact: C1, lead: null, channel: "sms" }]);
    assert.equal(sends[0].conversationId, store.conversations![0].id);
  }
  reset();
  const existing = { id: uuid(), organization_id: ORG, contact_id: C1, channel: "sms", status: "open", ai_enabled: true, lead_id: null };
  store.conversations!.push(existing);
  delivered(inv(3), 100);
  await run();
  assert.deepEqual([store.conversations!.length, sends[0].conversationId], [1, existing.id]);
  // An unnamed business still gets a sender name.
  reset();
  store.organizations![0].name = "  ";
  delivered(inv(3), 100);
  await run();
  assert.match(String(sends[0].body), /^Your contractor: Invoice/);
});

test("51. send failure: the execution fails with exactly the fixed message and category; the run reports one failure", async () => {
  control.sendOk = false;
  const i = inv(3);
  delivered(i, 100);
  const r = await run();
  assert.deepEqual([r.sent, r.failed, r.outcomes[0].reason], [0, 1, "sms_send_failed"]);
  assert.equal(executionOf(i)!.error_message, "The invoice reminder SMS could not be sent.");
});

// ---------------------------------------------------------------- regression

test("52. outcome names: every producer outcome is one of the existing names", async () => {
  const allowed = new Set(["outside_hours", "not_delivered", "recently_delivered", "contact_reminded_today", "duplicate", "skipped_disabled", "no_payment_link", "blocked", "sent", "failed"]);
  const seen = new Set<string>();
  const collect = (r: RunResult) => r.outcomes.forEach((o) => seen.add(o.outcome));
  delivered(inv(3), 100);
  inv(4, { contact_id: C2 });
  collect(await run());
  collect(await run(1));
  collect(await run(-2));
  store.automation_settings![0].enabled = true;
  const p = inv(5, { contact_id: C2 });
  delivered(p, 10);
  collect(await run(2));
  reset();
  const d = inv(3);
  delivered(d, 100);
  control.afterEvent = () => { store.automation_settings![0].enabled = false; };
  collect(await run());
  reset();
  // Disabled between the scan and the claim: skipped_disabled, nothing recorded, the stage stays eligible.
  delivered(inv(3), 100);
  hooks.beforeTable = (table) => {
    if (table === "opportunities") store.organizations![0].automation_paused = true;
  };
  const r = await run();
  collect(r);
  assert.deepEqual(labels(r), ["#01:skipped_disabled@1"]);
  assert.equal(reminderEvents().length, 0);
  for (const name of seen) assert.ok(allowed.has(name), name);
});

test("53. event/execution semantics: event failure -> nothing recorded, retried by a later run; execution start failure -> the event stands, no execution, a later run is a duplicate; post-claim blocks complete the execution", async () => {
  const i = inv(3);
  delivered(i, 100);
  control.failEventKeys.add(`invoice.reminder:${i.id}:1`);
  assert.deepEqual(labels(await run()), ["#01:failed@1:event_not_recorded"]);
  assert.equal(reminderEvents().length, 0);
  control.failEventKeys.clear();
  assert.deepEqual(labels(await run(1)), ["#01:sent@1"], "a later run may retry");
  reset();
  const j = inv(3);
  delivered(j, 100);
  control.failStartKeys.add(`invoice.reminder:${j.id}:1`);
  assert.deepEqual(labels(await run()), ["#01:failed@1:execution_not_started"]);
  assert.deepEqual([reminderEvents().length, store.workflow_executions!.length, sends.length], [1, 0, 0]);
  control.failStartKeys.clear();
  assert.deepEqual(labels(await run(1)), ["#01:duplicate@1"]);
});

test("single send spine (behavioural): the claim, B1 and the post-claim re-read always precede the gate, which always precedes the send - a run that bypasses the shared runtime cannot pass", async () => {
  const i = inv(3);
  delivered(i, 100);
  await run();
  const order = ["snapshot", "event", "start", "reread", "gate", "send"].map(step);
  assert.ok(order.every((index) => index >= 0), JSON.stringify(trace));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `B1 -> claim -> verify -> gate -> send: ${trace.join(",")}`);
  // B1 failing stops everything before the claim - only possible on the shared runtime.
  reset();
  delivered(inv(3), 100);
  control.snapshotFails = true;
  await run();
  assert.deepEqual([step("event"), step("gate"), step("send")], [-1, -1, -1]);
});
