/**
 * Final Batch 1 - communication core. Regression coverage for:
 *   1. the inbox composer sending a real SMS through the canonical path
 *      (evaluateStaffOutboundGate -> sendOutboundMessage -> provider);
 *   2. keywords: a bare YES is not START; STOP words unchanged; a bare
 *      CANCEL answering an appointment message also cancels it;
 *   3. the hard 08:00-21:00 quiet-hours floor on every automated send;
 *   4. automated booking/cancel/reschedule passing the automated-action
 *      safeguards (both the SMS booking-reply path and the n8n callback);
 *   5. AI failure on a customer reply escalating instead of going silent
 *      (also covered in execution-failure-handling.test.ts);
 *   6. the new-lead alert (covered in lib/opportunities/detect.scale.test.ts).
 *
 * In-memory store; the REAL action, gate, sender, booking-reply handling and
 * callback route run. Only the SMS provider, n8n, the owner notification and
 * the appointment cancellation itself are stubbed. Nothing reaches a network.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/communication-core.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const CONV = "44444444-4444-4444-8444-444444444444";
const SECRET = "test-webhook-secret";
const HOUR = 60 * 60 * 1000;

let store: Record<string, Row[]> = {};
let ids = 0;
const calls = { sms: [] as Row[], cancels: [] as Row[], founder: [] as string[], signals: [] as string[] };
const control = { smsOk: true, signedIn: true, admin: true };
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private updateValues: Row | null = null;
  private insertRows: Row[] | null = null;
  private upsertRow: Row | null = null;
  private sorts: { column: string; ascending: boolean }[] = [];
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
  or() { return this; }
  gt(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) > v); return this; }
  gte(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) >= v); return this; }
  lt(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) < v); return this; }
  lte(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) <= v); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.sorts.push({ column: c, ascending: o?.ascending !== false }); return this; }
  range() { return this; }
  limit(n: number) { this.max = n; return this; }
  update(v: Row) { this.updateValues = v; return this; }
  insert(v: Row | Row[]) { this.insertRows = Array.isArray(v) ? v : [v]; return this; }
  upsert(v: Row) { this.upsertRow = v; return this; }
  single() { return this.run(true); }
  maybeSingle() { return this.run(true); }
  then<T>(resolve: (v: { data: unknown; error: unknown }) => T, reject?: (e: unknown) => T) { return this.run(false).then(resolve, reject); }
  private async run(single: boolean): Promise<{ data: unknown; error: unknown }> {
    const rows = (store[this.table] ??= []);
    if (this.upsertRow) {
      rows.push({ id: uuid(), ...this.upsertRow });
      return { data: null, error: null };
    }
    if (this.insertRows) {
      const inserted = this.insertRows.map((r) => ({ id: uuid(), created_at: new Date().toISOString(), ...r }));
      rows.push(...inserted);
      return { data: single ? { ...inserted[0] } : inserted.map((r) => ({ ...r })), error: null };
    }
    let matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.updateValues) for (const r of matched) Object.assign(r, this.updateValues);
    if (this.sorts.length) matched = [...matched].sort((a, b) => { for (const { column, ascending } of this.sorts) { const d = String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0; if (d) return d * (ascending ? 1 : -1); } return 0; });
    if (this.max !== null) matched = matched.slice(0, this.max);
    const embed = this.table === "workflow_executions" && this.columns.includes("automation_events(");
    const copy = matched.map((r) => (embed ? { ...r, automation_events: store.automation_events!.find((e) => e.id === r.automation_event_id) ?? null } : { ...r }));
    return { data: single ? (copy[0] ?? null) : copy, error: null };
  }
}

function rpc(name: string, args: Row) {
  const run = async () => {
    if (name === "is_org_admin") return { data: control.admin && args.target_org_id === ORG, error: null };
    const executions = (store.workflow_executions ??= []);
    const events = (store.automation_events ??= []);
    if (name === "create_automation_event") {
      const existing = events.find((e) => e.organization_id === args.p_organization_id && e.idempotency_key === args.p_idempotency_key);
      if (existing) return { data: { ...existing, is_duplicate: true }, error: null };
      const event = { id: uuid(), organization_id: args.p_organization_id, event_type: args.p_event_type, entity_type: args.p_entity_type, entity_id: args.p_entity_id, payload: args.p_payload, idempotency_key: args.p_idempotency_key, status: "pending", created_at: new Date().toISOString() };
      events.push(event);
      return { data: { ...event, is_duplicate: false }, error: null };
    }
    if (name === "start_workflow_execution") {
      const event = events.find((e) => e.id === args.p_automation_event_id);
      if (!event) return { data: null, error: { message: "Automation event not found" } };
      const row: Row = { id: uuid(), organization_id: event.organization_id, automation_event_id: event.id, workflow_name: args.p_workflow_name, status: "running", attempt: 1, metadata: args.p_metadata ?? {}, started_at: new Date().toISOString() };
      executions.push(row);
      event.status = "processing";
      return { data: { ...row }, error: null };
    }
    const execution = executions.find((e) => e.id === args.p_execution_id);
    if (!execution) return { data: null, error: { message: "Execution not found" } };
    if (execution.status !== "running") return { data: null, error: { message: "Execution is not running" } };
    if (name === "complete_workflow_execution") Object.assign(execution, { status: "completed", metadata: args.p_metadata ?? {} });
    else if (name === "fail_workflow_execution") Object.assign(execution, { status: "failed", error_message: args.p_error_message });
    else return { data: null, error: { message: `unexpected rpc ${name}` } };
    return { data: { ...execution }, error: null };
  };
  return { single: run, then: <T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) => run().then(resolve, reject) };
}
const db = { from: (t: string) => new Query(t), rpc, auth: { getUser: async () => ({ data: { user: control.signedIn ? { id: USER } : null } }) } };

const realNextServer = await import("next/server");
mock.module("next/server", { namedExports: { ...realNextServer, after: (fn: () => unknown) => void fn() } });
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("next/navigation", { namedExports: { redirect: (to: string) => { throw new Error(`redirect ${to}`); } } });
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => db } });
mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => db } });
mock.module(lib("lib/automation-health/service.ts"), {
  namedExports: {
    recordAutomationHealthSignal: async (_s: unknown, input: Row) => (calls.signals.push(String(input.category)), { occurrenceCount: 1 }),
    resolveAutomationFailureIncidents: async () => undefined,
  },
});
mock.module(lib("lib/notifications/founder.ts"), { namedExports: { notifyFounder: async (_s: unknown, input: Row) => void calls.founder.push(String(input.kind)) } });
const realSms = await import(lib("lib/automation/sms.ts"));
mock.module(lib("lib/automation/sms.ts"), {
  namedExports: {
    ...realSms,
    sendSms: async (input: Row) => {
      calls.sms.push(input);
      return control.smsOk ? { ok: true, providerMessageId: `SM${calls.sms.length}` } : { ok: false, error: "Twilio error 30003: unreachable handset" };
    },
  },
});
const realN8n = await import(lib("lib/automation/n8n.ts"));
mock.module(lib("lib/automation/n8n.ts"), { namedExports: { ...realN8n, triggerN8nWorkflow: async () => ({ ok: true }) } });
const realAppointments = await import(lib("lib/automation/appointments.ts"));
mock.module(lib("lib/automation/appointments.ts"), {
  namedExports: {
    ...realAppointments,
    cancelAppointmentAsService: async (_s: unknown, organizationId: string, contactId: string, appointmentId: string) => {
      calls.cancels.push({ organizationId, contactId, appointmentId });
      return { ok: true, startAt: new Date().toISOString(), endAt: new Date().toISOString(), title: "Inspection" };
    },
  },
});
const realSettings = await import(lib("lib/settings/queries.ts"));
mock.module(lib("lib/settings/queries.ts"), { namedExports: { ...realSettings, getAiSettings: async () => ({ ai_enabled: true, tone: "friendly" }) } });

process.env.N8N_WEBHOOK_SECRET = SECRET;
const { sendConversationMessage } = await import(lib("app/(app)/conversations/actions.ts"));
const { evaluateOutboundGate, evaluateStaffOutboundGate, evaluateAutomatedActionPreconditions } = await import(lib("lib/automation/outbound-gate.ts"));
const { isWithinQuietHoursFloor, nextAllowedSendTime, sendTimeZone } = await import(lib("lib/automation/send-window.ts"));
const { matchSmsKeyword, isBareCancel } = await import(lib("lib/messaging/keywords.ts"));
const { classifyAndProcessBookingReply, handleBareCancelAppointmentReply, classifyBookingReplyIntent } = await import(lib("lib/automation/booking-reply.ts"));
const { isWaitingOnBusiness } = await import(lib("lib/conversations/waiting.ts"));
const { POST } = await import(lib("app/api/automation/n8n-callback/route.ts"));

beforeEach(() => {
  ids = 100;
  store = {
    organizations: [
      { id: ORG, name: "QA Fixture Roofing", automation_mode: "live", payment_status: "active", automation_paused: false, timezone: "America/Chicago" },
      { id: OTHER_ORG, automation_mode: "live", payment_status: "active", automation_paused: false, timezone: "UTC" },
    ],
    organization_members: [{ organization_id: ORG, user_id: USER, role: "owner", organizations: { name: "QA Fixture Roofing", payment_status: "active", vertical: "contractor" } }],
    contacts: [{ id: CONTACT, organization_id: ORG, first_name: "Riley", phone: "+15550142301", phone_normalized: "+15550142301", sms_opt_out: false }],
    conversations: [{ id: CONV, organization_id: ORG, contact_id: CONTACT, lead_id: null, channel: "sms", status: "open", ai_enabled: true }],
    automation_settings: [],
    messages: [], appointments: [], automation_events: [], workflow_executions: [], ai_interactions: [], leads: [], estimates: [], jobs: [], opportunities: [],
  };
  calls.sms = []; calls.cancels = []; calls.founder = []; calls.signals = [];
  control.smsOk = true; control.signedIn = true; control.admin = true;
});

const org = () => store.organizations![0];
const contact = () => store.contacts![0];
const conversation = () => store.conversations![0];
const outbound = () => store.messages!.filter((m) => m.direction === "outbound");
const compose = (body: string, conversationId = CONV) => {
  const form = new FormData();
  form.set("conversationId", conversationId);
  form.set("body", body);
  return sendConversationMessage({}, form) as Promise<Row>;
};
/** Runs `fn` with the wall clock at `iso` (the gate and the booking safeguards read the real clock). */
async function at<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date"], now: new Date(iso) });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}
// America/Chicago is UTC-5 in November: 14:00Z = 08:00 local, 02:59Z = 20:59 local, 03:00Z = 21:00 local.
const CHICAGO_MORNING = "2026-11-03T14:00:00.000Z";
const CHICAGO_LATE = "2026-11-04T03:00:00.000Z";
const CHICAGO_EARLY = "2026-11-03T13:59:00.000Z";
const APPT = "55555555-5555-4555-8555-555555555555";
/** Upcoming relative to every fixed moment these tests run at. */
const UPCOMING_START = "2026-11-05T15:00:00.000Z";
const UPCOMING_END = "2026-11-05T16:00:00.000Z";

// ---------------------------------------------------------------- 1. composer

test("1. composer: a contractor's text goes through the canonical path - gate, message row, provider, recorded result - as sender_type user", async () => {
  const result = await compose("  On my way - see you at 3!  ");
  assert.deepEqual(result, { success: true });
  assert.deepEqual(calls.sms.map((s) => [s.to, s.body, s.organizationId]), [["+15550142301", "On my way - see you at 3!", ORG]]);
  const [message] = outbound();
  assert.deepEqual({ sender: message.sender_type, status: message.status, provider: message.provider_message_id, conversation: message.conversation_id }, { sender: "user", status: "sent", provider: "SM1", conversation: CONV });
  const source = readFileSync(path.join(process.cwd(), "app/(app)/conversations/actions.ts"), "utf8");
  const action = source.slice(source.indexOf("export async function sendConversationMessage"), source.indexOf("export type SimulateCustomerReplyState"));
  assert.match(action, /evaluateStaffOutboundGate\(supabase/);
  assert.match(action, /sendOutboundMessage\(supabase,/);
  assert.doesNotMatch(action, /\.from\("messages"\)\s*\.insert/, "no second send path: the action never writes a message row itself");
  assert.doesNotMatch(source, /status: "logged"/, "the composer no longer only logs a note");
});

test("1b. composer: a sent staff text counts as the business's reply - the conversation stops waiting; a failed one does not", () => {
  const inbound = { direction: "inbound" as const, status: "received", created_at: "2026-11-03T15:00:00.000Z" };
  assert.equal(isWaitingOnBusiness([inbound]), true);
  assert.equal(isWaitingOnBusiness([{ direction: "outbound", status: "sent", created_at: "2026-11-03T15:05:00.000Z" }, inbound]), false);
  assert.equal(isWaitingOnBusiness([{ direction: "outbound", status: "failed", created_at: "2026-11-03T15:05:00.000Z" }, inbound]), true);
});

test("1c. composer: never sends for a test-mode or unpaid account, an opted-out or invalid number, a closed or foreign conversation - with a plain reason", async () => {
  const cases: [string, () => void, RegExp][] = [
    ["test mode", () => (org().automation_mode = "test"), /test mode/],
    ["payment", () => (org().payment_status = "payment_required"), /subscription is active/],
    ["opted out", () => (contact().sms_opt_out = true), /opted out/],
    ["invalid number", () => Object.assign(contact(), { phone: "555-0142", phone_normalized: null }), /valid mobile number/],
    ["closed", () => (conversation().status = "closed"), /Reopen it/],
    ["foreign", () => (conversation().organization_id = OTHER_ORG), /could not be found/],
  ];
  for (const [label, change, expected] of cases) {
    beforeEachReset();
    change();
    const result = await compose("Hello");
    assert.match(String(result.error), expected, label);
    assert.equal(calls.sms.length, 0, `${label}: provider never called`);
    assert.equal(outbound().length, 0, `${label}: nothing recorded as sent`);
  }
});

test("1d. composer: automation pause, the AI lock and the AI content filter do not apply to a person's own text; the quiet-hours floor does not either", async () => {
  org().automation_paused = true;
  conversation().ai_enabled = false;
  assert.deepEqual(await at(CHICAGO_LATE, () => evaluateStaffOutboundGate(db as never, { organizationId: ORG, conversationId: CONV, body: " Hi " })), { allowed: true, contactId: CONTACT, conversationId: CONV, body: "Hi" });
  const result = await at(CHICAGO_LATE, () => compose("Your total is $1,250 - I'll swing by tomorrow."));
  assert.deepEqual(result, { success: true });
  assert.equal(calls.sms.length, 1);
});

test("1e. composer: a double submit of the same text sends once; a provider failure is reported plainly and recorded as not sent", async () => {
  assert.deepEqual(await compose("Running 10 minutes late"), { success: true });
  assert.deepEqual(await compose("Running 10 minutes late"), { success: true });
  assert.equal(calls.sms.length, 1, "one text");
  control.smsOk = false;
  const failed = await compose("Different message");
  assert.match(String(failed.error), /couldn't be delivered/);
  assert.doesNotMatch(String(failed.error), /Twilio|30003/, "no provider internals");
  assert.equal(outbound().find((m) => m.body === "Different message")!.status, "failed");
});

test("1f. composer: signed out or outside the organization is refused before anything is read", async () => {
  control.signedIn = false;
  await assert.rejects(compose("Hi"), /redirect \/login/);
  control.signedIn = true;
  store.organization_members = [];
  await assert.rejects(compose("Hi"), /redirect \/onboarding/);
  assert.equal(calls.sms.length, 0);
});

// ---------------------------------------------------------------- 2. keywords

test("2. keywords: bare YES is not START; START/UNSTOP are; STOP words (incl. CANCEL, END) unchanged; ordinary replies are not keywords", () => {
  for (const body of ["YES", "yes", " Yes ", "Yes, Tuesday works", "yes please", "ok"]) assert.equal(matchSmsKeyword(body), null, body);
  for (const body of ["START", "start", "Unstop"]) assert.equal(matchSmsKeyword(body), "start", body);
  for (const body of ["STOP", "stop", "CANCEL", "Cancel", "END", "quit", "unsubscribe", "STOPALL"]) assert.equal(matchSmsKeyword(body), "stop", body);
  for (const body of ["HELP", "info"]) assert.equal(matchSmsKeyword(body), "help", body);
  for (const body of ["I need to cancel my appointment", "please stop by tomorrow", "can we end at 5?", "cancel my appointment"]) assert.equal(matchSmsKeyword(body), null, body);
  assert.equal(isBareCancel(" CANCEL "), true);
  assert.equal(isBareCancel("cancel my appointment"), false);
  assert.equal(isBareCancel("STOP"), false);
  assert.equal(classifyBookingReplyIntent("Please cancel my appointment"), "cancel");
});

function seedAppointmentThread(workflowName: string) {
  store.appointments!.push({ id: APPT, organization_id: ORG, contact_id: CONTACT, lead_id: null, title: "Inspection", status: "scheduled", start_at: new Date(Date.now() + 26 * HOUR).toISOString(), end_at: new Date(Date.now() + 27 * HOUR).toISOString() });
  const execution = { id: uuid(), organization_id: ORG, workflow_name: workflowName, status: "completed" };
  store.workflow_executions!.push(execution);
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: CONV, direction: "outbound", status: "sent", workflow_execution_id: execution.id, created_at: new Date(Date.now() - HOUR).toISOString(), body: "Reminder: your inspection is tomorrow." });
}

test("2b. a bare CANCEL answering an appointment message also cancels that appointment (the opt-out already recorded); otherwise it is only an opt-out", async () => {
  contact().sms_opt_out = true; // the inbound webhook has just recorded the CANCEL opt-out
  seedAppointmentThread("appointment_reminder");
  assert.equal(await handleBareCancelAppointmentReply(db as never, ORG, CONTACT, null, CONV), true);
  assert.deepEqual(calls.cancels, [{ organizationId: ORG, contactId: CONTACT, appointmentId: APPT }]);

  beforeEachReset();
  contact().sms_opt_out = true;
  seedAppointmentThread("customer_reply_followup");
  assert.equal(await handleBareCancelAppointmentReply(db as never, ORG, CONTACT, null, CONV), false, "the last message was not about an appointment");
  store.messages = [];
  assert.equal(await handleBareCancelAppointmentReply(db as never, ORG, CONTACT, null, CONV), false, "nothing sent yet");
  assert.deepEqual(calls.cancels, []);

  const inbound = readFileSync(path.join(process.cwd(), "app/api/webhooks/sms/inbound/route.ts"), "utf8");
  assert.match(inbound, /keyword === "stop" && isBareCancel\(body\)/);
  assert.ok(inbound.indexOf("writeSmsOptOut(service, contact.id, optOutTarget)") < inbound.indexOf("handleBareCancelAppointmentReply("), "the opt-out is persisted first");
});

// ---------------------------------------------------------------- 3. quiet hours

test("3. quiet-hours floor: 08:00 up to 21:00 local; organization timezone; UTC only when the timezone is missing or unusable", () => {
  assert.equal(isWithinQuietHoursFloor(new Date("2026-11-03T07:59:00Z"), "UTC"), false);
  assert.equal(isWithinQuietHoursFloor(new Date("2026-11-03T08:00:00Z"), "UTC"), true);
  assert.equal(isWithinQuietHoursFloor(new Date("2026-11-03T20:59:00Z"), "UTC"), true);
  assert.equal(isWithinQuietHoursFloor(new Date("2026-11-03T21:00:00Z"), "UTC"), false);
  assert.equal(isWithinQuietHoursFloor(new Date(CHICAGO_EARLY), "America/Chicago"), false, "07:59 Chicago");
  assert.equal(isWithinQuietHoursFloor(new Date(CHICAGO_MORNING), "America/Chicago"), true, "08:00 Chicago");
  assert.equal(isWithinQuietHoursFloor(new Date(CHICAGO_LATE), "America/Chicago"), false, "21:00 Chicago");
  assert.equal(isWithinQuietHoursFloor(new Date("2026-11-03T15:00:00Z"), null), true);
  assert.equal(sendTimeZone("Not/AZone"), "UTC");
  assert.equal(sendTimeZone(undefined), "UTC");
  const opening = nextAllowedSendTime(new Date("2026-11-03T22:10:00Z"), (when: Date) => isWithinQuietHoursFloor(when, "UTC"));
  assert.equal(opening!.toISOString(), "2026-11-04T08:00:00.000Z");
});

function seedRunningExecution() {
  const event = { id: uuid(), organization_id: ORG, event_type: "customer.message.received", entity_type: "conversation", entity_id: CONV, payload: { conversation_id: CONV, contact_id: CONTACT }, status: "processing" };
  store.automation_events!.push(event);
  const execution = { id: uuid(), organization_id: ORG, automation_event_id: event.id, workflow_name: "customer_reply_followup", status: "running" };
  store.workflow_executions!.push(execution);
  return { event, execution };
}
const gateInput = (executionId: string) => ({ organizationId: ORG, executionId, contactId: CONTACT, conversationId: CONV, leadId: null, aiResult: { should_send: true, response_message: "Thanks - we'll be in touch.", needs_human: false } });

test("3b. the canonical gate refuses every automated send outside the floor - business hours off, any trigger (event, retry, manual run) - and allows it inside", async () => {
  const { execution } = seedRunningExecution();
  for (const [iso, expected] of [[CHICAGO_EARLY, false], [CHICAGO_MORNING, true], [CHICAGO_LATE, false]] as const) {
    const result = (await at(iso, () => evaluateOutboundGate(db as never, gateInput(execution.id as string)))) as Row;
    assert.equal(result.allowed, expected, iso);
    if (!expected) assert.deepEqual(result, { allowed: false, reason: "outside_quiet_hours", detail: undefined });
  }
  // A more specific denial still wins at night (the floor never hides an opt-out).
  contact().sms_opt_out = true;
  assert.equal(((await at(CHICAGO_LATE, () => evaluateOutboundGate(db as never, gateInput(execution.id as string)))) as Row).reason, "contact_opted_out");
});

// ---------------------------------------------------------------- 4. booking safety

test("4. automated-action safeguards: automation off, not live, unpaid, paused, human-locked, opted out, quiet hours - each refuses; all clear allows", async () => {
  const check = (extra: Row = {}) => evaluateAutomatedActionPreconditions(db as never, { organizationId: ORG, conversationId: CONV, contactId: CONTACT, ...extra });
  assert.deepEqual(await at(CHICAGO_MORNING, () => check()), { allowed: true });
  const cases: [string, () => void, string, Row?][] = [
    ["automation off", () => undefined, "automation_disabled", { automationEnabled: false }],
    ["test mode", () => (org().automation_mode = "test"), "organization_not_live"],
    ["unpaid", () => (org().payment_status = "suspended"), "organization_payment_inactive"],
    ["paused", () => (org().automation_paused = true), "organization_automation_paused"],
    ["human lock", () => (conversation().ai_enabled = false), "conversation_ai_disabled"],
    ["opted out", () => (contact().sms_opt_out = true), "contact_opted_out"],
  ];
  for (const [label, change, reason, extra] of cases) {
    beforeEachReset();
    change();
    assert.deepEqual(await at(CHICAGO_MORNING, () => check(extra)), { allowed: false, reason }, label);
  }
  beforeEachReset();
  assert.deepEqual(await at(CHICAGO_LATE, () => check()), { allowed: false, reason: "outside_quiet_hours" });
  contact().sms_opt_out = true;
  assert.deepEqual(await at(CHICAGO_MORNING, () => check({ ignoreOptOut: true })), { allowed: true }, "only the bare-CANCEL case ignores the opt-out it just recorded");
});

test("4b. SMS booking replies: 'please cancel my appointment' cancels only when every safeguard passes - never for a test account, a human-locked thread, a disabled automation or at night", async () => {
  const seed = () => store.appointments!.push({ id: APPT, organization_id: ORG, contact_id: CONTACT, lead_id: null, title: "Inspection", status: "scheduled", start_at: UPCOMING_START, end_at: UPCOMING_END });
  const cases: [string, () => void, string][] = [
    ["test mode", () => (org().automation_mode = "test"), CHICAGO_MORNING],
    ["human lock", () => (conversation().ai_enabled = false), CHICAGO_MORNING],
    ["automation off", () => store.automation_settings!.push({ organization_id: ORG, automation_id: "inbound-customer-reply", enabled: false, config: null }), CHICAGO_MORNING],
    ["quiet hours", () => undefined, CHICAGO_LATE],
  ];
  for (const [label, change, iso] of cases) {
    beforeEachReset();
    seed();
    change();
    assert.equal(await at(iso, () => classifyAndProcessBookingReply(db as never, ORG, CONTACT, null, CONV, "Please cancel my appointment")), false, `${label}: left to the normal, gated reply path`);
    assert.deepEqual(calls.cancels, [], label);
  }
  beforeEachReset();
  seed();
  assert.equal(await at(CHICAGO_MORNING, () => classifyAndProcessBookingReply(db as never, ORG, CONTACT, null, CONV, "Please cancel my appointment")), true);
  assert.deepEqual(calls.cancels, [{ organizationId: ORG, contactId: CONTACT, appointmentId: APPT }]);
});

function callbackWithBookingIntent(needsHuman = false) {
  const { event, execution } = seedRunningExecution();
  store.appointments!.push({ id: APPT, organization_id: ORG, contact_id: CONTACT, lead_id: null, title: "Inspection", status: "scheduled", start_at: UPCOMING_START, end_at: UPCOMING_END });
  const body = {
    execution_id: execution.id,
    event_id: event.id,
    organization_id: ORG,
    ai_result: { should_send: false, response_message: null, qualification_status: "qualified", missing_information: [], urgency: "normal", needs_human: needsHuman, model: "claude-sonnet-5", intent: "cancel", summary: "Customer wants to cancel.", booking_intent: { action: "cancel", date_range_start: null, date_range_end: null, start_at: null, end_at: null, title: null, appointment_id: APPT } },
  };
  return { execution, response: POST(new Request("https://preview.example/api/automation/n8n-callback", { method: "POST", headers: { "content-type": "application/json", "x-trackpr-webhook-secret": SECRET }, body: JSON.stringify(body) }) as never) as Promise<Response> };
}

test("4c. n8n booking intent: a human-locked thread, a test account or quiet hours never cancel; the run completes blocked with the reason; a needs-human result never acts", async () => {
  conversation().ai_enabled = false;
  let { execution, response } = await at(CHICAGO_MORNING, async () => { const r = callbackWithBookingIntent(); return { execution: r.execution, response: await r.response }; });
  assert.deepEqual(await response.json(), { ok: true, sent: false, blockedReason: "conversation_ai_disabled" });
  assert.deepEqual([execution.status, ((execution as Row).metadata as Row).blocked_reason], ["completed", "conversation_ai_disabled"]);

  beforeEachReset();
  org().automation_mode = "test";
  ({ execution, response } = await at(CHICAGO_MORNING, async () => { const r = callbackWithBookingIntent(); return { execution: r.execution, response: await r.response }; }));
  assert.equal((await response.json()).blockedReason, "organization_not_live");

  beforeEachReset();
  ({ execution, response } = await at(CHICAGO_LATE, async () => { const r = callbackWithBookingIntent(); return { execution: r.execution, response: await r.response }; }));
  assert.equal((await response.json()).blockedReason, "outside_quiet_hours");

  beforeEachReset();
  ({ execution, response } = await at(CHICAGO_MORNING, async () => { const r = callbackWithBookingIntent(true); return { execution: r.execution, response: await r.response }; }));
  await response.json();
  assert.equal(conversation().ai_enabled, false, "needs-human locks for a person");
  assert.deepEqual(calls.cancels, [], "no booking action was taken in any case");

  beforeEachReset();
  ({ execution, response } = await at(CHICAGO_MORNING, async () => { const r = callbackWithBookingIntent(); return { execution: r.execution, response: await r.response }; }));
  await response.json();
  assert.deepEqual(calls.cancels, [{ organizationId: ORG, contactId: CONTACT, appointmentId: APPT }], "all clear: the cancellation runs");
});

// ---------------------------------------------------------------- 5. AI failure escalation

test("5. an unanswered customer reply escalates once: a second failure on the same thread (another message, another run) records nothing new while it is locked", async () => {
  const { escalateUnansweredCustomerReply } = await import(lib("lib/automation/customer-reply.ts"));
  const first = await escalateUnansweredCustomerReply(db as never, { organizationId: ORG, conversationId: CONV, contactId: CONTACT, leadId: null, executionId: uuid(), cause: "AI failure" });
  const second = await escalateUnansweredCustomerReply(db as never, { organizationId: ORG, conversationId: CONV, contactId: CONTACT, leadId: null, executionId: uuid(), cause: "no AI result" });
  assert.deepEqual([first, second], [{ escalated: true }, { escalated: false }]);
  assert.equal(conversation().ai_enabled, false);
  assert.deepEqual(calls.signals, ["human_escalation_requested"]);
  assert.deepEqual(calls.founder, ["ai_escalation"]);
  assert.equal(outbound().length, 0, "never a fallback message");
  // Once a person turns AI back on, the next failure escalates again.
  conversation().ai_enabled = true;
  assert.deepEqual(await escalateUnansweredCustomerReply(db as never, { organizationId: ORG, conversationId: CONV, contactId: CONTACT, leadId: null, executionId: uuid(), cause: "dispatch failure" }), { escalated: true });
});

function beforeEachReset() {
  const keepIds = ids;
  store.organizations = [
    { id: ORG, name: "QA Fixture Roofing", automation_mode: "live", payment_status: "active", automation_paused: false, timezone: "America/Chicago" },
    { id: OTHER_ORG, automation_mode: "live", payment_status: "active", automation_paused: false, timezone: "UTC" },
  ];
  store.organization_members = [{ organization_id: ORG, user_id: USER, role: "owner", organizations: { name: "QA Fixture Roofing", payment_status: "active", vertical: "contractor" } }];
  store.contacts = [{ id: CONTACT, organization_id: ORG, first_name: "Riley", phone: "+15550142301", phone_normalized: "+15550142301", sms_opt_out: false }];
  store.conversations = [{ id: CONV, organization_id: ORG, contact_id: CONTACT, lead_id: null, channel: "sms", status: "open", ai_enabled: true }];
  store.automation_settings = [];
  store.messages = []; store.appointments = []; store.automation_events = []; store.workflow_executions = []; store.ai_interactions = [];
  calls.sms = []; calls.cancels = []; calls.founder = []; calls.signals = [];
  control.smsOk = true;
  ids = keepIds;
}
