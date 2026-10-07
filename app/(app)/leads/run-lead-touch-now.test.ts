/**
 * P0-B B2.8f: the TEST-only per-lead Run now for lost-lead nurture and lead
 * reactivation (app/(app)/leads/actions.ts runLeadTouchNow ->
 * lib/automation/lead-nurture.ts runLeadNurtureNow /
 * lib/automation/lead-reactivation.ts runLeadReactivationNow). The REAL
 * action, producers, claimAndHandOffTouch, callback route, runtime and
 * outbound gate run on an in-memory store with B0-shaped RPCs; n8n is
 * captured, the SMS sender is mocked with the outbound unique index. Proves
 * the action is TEST-only and organization-scoped, and that Run now skips
 * ONLY the cadence wait - A3, B1, the kill switch, the key, the live/payment
 * gate and the outbound gate all still apply.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test "app/(app)/leads/run-lead-touch-now.test.ts"
 */
import { readFileSync } from "node:fs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type Row = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const SECRET = "test-webhook-secret";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let store: Record<string, Row[]> = {};
let ids = 0;
const trace: string[] = [];
const calls = { sends: 0, signals: [] as Row[], founder: [] as string[], contracts: [] as Row[], gateInputs: [] as Row[], serviceClients: 0 };
const control = { dispatchOk: true, aiEnabled: true, snapshotFails: false, kindReadFails: false, admin: true, signedIn: true, sendHeld: Promise.resolve() as Promise<void>, gateBarrier: null as null | { arrivals: number; open: () => void; opened: Promise<void> } };
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
    if (name === "is_org_admin") return { data: control.admin && args.target_org_id === ORG, error: null };
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
const db = { from: (t: string) => new Query(t), rpc, auth: { getUser: async () => ({ data: { user: control.signedIn ? { id: USER } : null } }) } };

const realNextServer = await import("next/server");
mock.module("next/server", { namedExports: { ...realNextServer, after: (fn: () => unknown) => void fn() } });
mock.module(lib("lib/supabase/service.ts"), { namedExports: { createServiceRoleClient: () => ((calls.serviceClients += 1), db) } });
mock.module(lib("lib/supabase/server.ts"), { namedExports: { createClient: async () => db } });
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("next/navigation", { namedExports: { redirect: (to: string) => { throw new Error(`redirect ${to}`); } } });
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
process.env.VERCEL_ENV = "preview";
const { POST } = await import(lib("app/api/automation/n8n-callback/route.ts"));
const { processLeadNurture, runLeadNurtureNow, LOST_LEAD_NURTURE_ADAPTER } = await import(lib("lib/automation/lead-nurture.ts"));
const { processLeadReactivation, runLeadReactivationNow, LEAD_REACTIVATION_ADAPTER } = await import(lib("lib/automation/lead-reactivation.ts"));
const { runLeadTouchNow } = await import(lib("app/(app)/leads/actions.ts"));

beforeEach(() => {
  store = {
    organizations: [
      { id: ORG, automation_mode: "test", payment_status: "active", automation_paused: false, name: "QA Fixture Roofing", timezone: "UTC" },
      { id: OTHER_ORG, automation_mode: "live", payment_status: "active", automation_paused: false },
    ],
    organization_members: [{ organization_id: ORG, user_id: USER, role: "owner", organizations: { name: "QA Fixture Roofing", payment_status: "active", vertical: "contractor" } }],
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
  calls.sends = 0; calls.signals = []; calls.founder = []; calls.contracts = []; calls.gateInputs = []; calls.serviceClients = 0;
  control.dispatchOk = true; control.aiEnabled = true; control.snapshotFails = false; control.kindReadFails = false; control.admin = true; control.signedIn = true; process.env.VERCEL_ENV = "preview"; control.sendHeld = Promise.resolve(); control.gateBarrier = null;
});

const addLead = (status: string, extra: Row = {}) => {
  const lead = { id: uuid(), organization_id: ORG, contact_id: CONTACT, status, source: "web_form", service: "Roof repair", ai_summary: null, created_at: ago(60), updated_at: ago(60), ...extra };
  store.leads!.push(lead);
  return lead as Row & { id: string };
};
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
/** A lead that went lost an hour ago - its first nurture touch is days away (cadence 3/14). */
function freshLostLead(extra: Row = {}) {
  const lead = addLead("lost", extra);
  store.automation_events!.push({ id: uuid(), organization_id: lead.organization_id ?? ORG, event_type: "lead.lost", entity_type: "lead", entity_id: lead.id, payload: {}, idempotency_key: `lead.lost:${lead.id}`, status: "completed", created_at: ago(1 / 24) });
  return lead;
}
/** A contacted lead with its own open SMS conversation whose last inbound reply was an hour ago - its first reactivation touch is days away (cadence 7/21). */
function freshQuietLead() {
  const lead = addLead("contacted");
  for (const c of store.conversations!) if (c.contact_id === CONTACT && c.status === "open") c.status = "closed";
  const conversation = { id: uuid(), organization_id: ORG, contact_id: CONTACT, lead_id: lead.id, channel: "sms", status: "open", ai_enabled: true };
  store.conversations!.push(conversation);
  store.messages!.push({ id: uuid(), organization_id: ORG, conversation_id: conversation.id, direction: "inbound", body: "hi", created_at: ago(1 / 24) });
  return { lead, conversation };
}
const runNow = (automation: string, leadId: string) => {
  const form = new FormData();
  form.set("automation", automation);
  form.set("leadId", leadId);
  return runLeadTouchNow({}, form) as Promise<Row>;
};
const touchEvents = () => store.automation_events!.filter((e) => e.event_type === "lead.lost_nurture" || e.event_type === "lead.reactivation");
const nothingRecorded = () => assert.deepEqual([touchEvents().length, store.workflow_executions!.length, calls.contracts.length, calls.sends], [0, 0, 0, 0]);

// ---------------------------------------------------------------- the TEST-only gate

test("1. environment: refused on Production (and outside a test deployment) before anything is read; accepted on a Preview", async () => {
  const lead = freshLostLead();
  process.env.VERCEL_ENV = "production";
  assert.deepEqual(await runNow("lost-lead-nurture", lead.id), { status: "invalid_environment", error: "Run now is only available on test deployments." });
  delete process.env.VERCEL_ENV;
  const nodeEnv = process.env.NODE_ENV;
  (process.env as Record<string, string>).NODE_ENV = "production";
  try {
    assert.equal((await runNow("lost-lead-nurture", lead.id)).status, "invalid_environment", "a production build with no VERCEL_ENV");
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
  }
  nothingRecorded();
  process.env.VERCEL_ENV = "preview";
  assert.equal((await runNow("lost-lead-nurture", lead.id)).status, "started");
});

test("2. authorization: signed out, no organization, not an owner/admin, or a live organization - refused, nothing recorded", async () => {
  const lead = freshLostLead();
  control.signedIn = false;
  await assert.rejects(runNow("lost-lead-nurture", lead.id), /redirect \/login/);
  control.signedIn = true;
  const members = store.organization_members!;
  store.organization_members = [];
  await assert.rejects(runNow("lost-lead-nurture", lead.id), /redirect \/onboarding/);
  store.organization_members = members;
  control.admin = false;
  assert.deepEqual(await runNow("lost-lead-nurture", lead.id), { status: "forbidden", error: "You must be an owner or admin of this organization." });
  control.admin = true;
  store.organizations![0].automation_mode = "live";
  assert.deepEqual(await runNow("lost-lead-nurture", lead.id), { status: "forbidden", error: "Run now is only available while automations are in TEST mode." });
  nothingRecorded();
  store.organizations![0].automation_mode = "test";
  assert.equal((await runNow("lost-lead-nurture", lead.id)).status, "started", "an owner of a TEST-mode organization");
});

test("3. isolation: another organization's lead, an unknown lead or automation - not found; the organization always comes from the session", async () => {
  const foreign = freshLostLead({ organization_id: OTHER_ORG });
  assert.deepEqual(await runNow("lost-lead-nurture", foreign.id), { status: "not_found", error: "This lead could not be found." });
  assert.deepEqual(await runNow("lead-reactivation", foreign.id), { status: "not_found", error: "This lead could not be found." });
  assert.equal((await runNow("lost-lead-nurture", "00000000-0000-4000-8000-999999999999")).status, "not_found");
  assert.deepEqual(await runNow("instant-lead-followup", freshLostLead().id), { status: "not_found", error: "Unknown automation." });
  assert.equal(calls.serviceClients, 0, "the action never reaches the service-role client for a lead outside the session's organization");
  nothingRecorded();
  // Each per-lead entry is organization-scoped on its own as well.
  const quietForeign = addLead("contacted", { organization_id: OTHER_ORG });
  assert.deepEqual(await runLeadNurtureNow(db as never, ORG, foreign.id), { leadId: foreign.id, outcome: "not_found" });
  assert.deepEqual(await runLeadReactivationNow(db as never, ORG, quietForeign.id), { leadId: quietForeign.id, outcome: "not_found" });
  nothingRecorded();
  const source = readFileSync(path.join(process.cwd(), "app/(app)/leads/actions.ts"), "utf8");
  const action = source.slice(source.indexOf("export async function runLeadTouchNow"));
  assert.match(action, /const \{ supabase, organizationId \} = await requireOrganization\(\);/);
  assert.match(action, /runLeadNurtureNow\(service, organizationId, leadId\)/);
  assert.match(action, /runLeadReactivationNow\(service, organizationId, leadId\)/);
  assert.ok(!/formData\.get\("organization/.test(action), "never an organization id from the form");
});

// ---------------------------------------------------------------- lost-lead nurture

test("4. nurture: the scheduled scan says not due; Run now claims THAT lead's touch 1 through claimAndHandOffTouch - the same key, marked n8n_draft, the same n8n contract - and no other lead", async () => {
  const lead = freshLostLead();
  const other = freshLostLead({ contact_id: "44444444-4444-4444-8444-444444444444" });
  const scheduled = await processLeadNurture(db as never, new Date());
  assert.deepEqual(scheduled.outcomes.map((o: Row) => o.outcome), ["not_due", "not_due"], "the scheduled path still waits for the cadence");
  assert.equal(touchEvents().length, 0);
  trace.length = 0;
  const result = await runNow("lost-lead-nurture", lead.id);
  assert.equal(result.status, "started");
  const [event] = touchEvents();
  const execution = executionOf(event);
  assert.match(String(result.result), new RegExp(`Touch 1 handed to n8n for a draft \\(execution ${execution.id}\\)`));
  assert.deepEqual({ key: event.idempotency_key, entity: event.entity_id, workflow: execution.workflow_name, metadata: execution.metadata, status: execution.status }, { key: `lead.lost_nurture:${lead.id}:1`, entity: lead.id, workflow: "lead_lost_nurture_followup", metadata: { handoff: "n8n_draft" }, status: "running" });
  const [contract] = calls.contracts as Row[];
  assert.deepEqual([(contract.event as Row).id, (contract.event as Row).type, (contract.event as Row).organization_id, (contract.execution as Row).id], [event.id, "lead.lost_nurture", ORG, execution.id]);
  assert.ok(trace.indexOf("snapshot") < trace.indexOf("event") && trace.indexOf("start") < trace.indexOf("dispatch"), `B1 -> claim -> dispatch: ${trace}`);
  assert.equal(touchEvents().filter((e) => e.entity_id === other.id).length, 0, "one lead per invocation - never a scan");
  // The claim's own due check: a not-yet-due touch passes ONLY when Run now marked it.
  const anHourAgo = Date.now() - 60 * 60 * 1000;
  const nurtureItem = { organizationId: ORG, leadId: lead.id, contactId: CONTACT, occurrence: 1, conversationId: null };
  assert.equal(LOST_LEAD_NURTURE_ADAPTER.isDue({ ...nurtureItem, schedule: { lostAtMs: anHourAgo, config: { touch_1_days: 3, touch_2_days: 14 } } }, new Date()), false);
  assert.equal(LOST_LEAD_NURTURE_ADAPTER.isDue({ ...nurtureItem, schedule: { lostAtMs: anHourAgo, config: { touch_1_days: 3, touch_2_days: 14 }, runNow: true } }, new Date()), true);
  assert.equal(LOST_LEAD_NURTURE_ADAPTER.isDue({ ...nurtureItem, schedule: null }, new Date()), false);
  assert.equal(LEAD_REACTIVATION_ADAPTER.isDue({ ...nurtureItem, schedule: { lastInboundAtMs: anHourAgo, config: { touch_1_days: 7, touch_2_days: 21 } } }, new Date()), false);
  assert.equal(LEAD_REACTIVATION_ADAPTER.isDue({ ...nurtureItem, schedule: { lastInboundAtMs: anHourAgo, config: { touch_1_days: 7, touch_2_days: 21 }, runNow: true } }, new Date()), true);
  assert.deepEqual([calls.sends, outbound().length], [0, 0]);
});

test("5. nurture end to end: the strict draft returns through the normal callback; in a TEST organization the outbound gate refuses (organization_not_live) - zero outbound", async () => {
  const lead = freshLostLead();
  assert.equal((await runNow("lost-lead-nurture", lead.id)).status, "started");
  const [event] = touchEvents();
  const { json } = await reply(strictBody(event));
  assert.deepEqual(json, { ok: true, sent: false, blockedReason: "organization_not_live" });
  assert.ok(trace.includes("gate"), "the real outbound gate decided");
  const execution = executionOf(event);
  assert.deepEqual({ status: execution.status, outcome: execution.outcome, reason: (execution.metadata as Row).blocked_reason }, { status: "completed", outcome: "blocked", reason: "organization_not_live" });
  assert.deepEqual([calls.sends, outbound().length], [0, 0]);
});

test("6. nurture: a lead that is not lost is never run", async () => {
  const lead = addLead("contacted");
  assert.deepEqual(await runNow("lost-lead-nurture", lead.id), { status: "not_owed", result: "Nothing to run (not_lost)." });
  const reopened = freshLostLead();
  reopened.status = "qualified";
  assert.equal((await runNow("lost-lead-nurture", reopened.id)).status, "not_owed");
  nothingRecorded();
  assert.equal(store.conversations!.length, 0, "stopped before any conversation is opened");
});

// ---------------------------------------------------------------- lead reactivation

test("7. reactivation: Run now claims touch 1 of that lead (the scheduled scan says not due) - same key, n8n_draft, its own conversation; ineligible leads are never run", async () => {
  const { lead, conversation } = freshQuietLead();
  const scheduled = await processLeadReactivation(db as never, new Date());
  assert.equal(scheduled.outcomes.find((o: Row) => o.leadId === lead.id)!.outcome, "not_due");
  const result = await runNow("lead-reactivation", lead.id);
  assert.equal(result.status, "started");
  const [event] = touchEvents();
  assert.deepEqual({ key: event.idempotency_key, metadata: executionOf(event).metadata, conversation: (event.payload as Row).conversation_id }, { key: `lead.reactivation:${lead.id}:1`, metadata: { handoff: "n8n_draft" }, conversation: conversation.id });
  const { json } = await reply(strictBody(event));
  assert.deepEqual(json, { ok: true, sent: false, blockedReason: "organization_not_live" });
  assert.deepEqual([calls.sends, outbound().length], [0, 0]);

  store.automation_events = store.automation_events!.filter((e) => e.event_type !== "lead.reactivation");
  store.workflow_executions = [];
  calls.contracts = [];
  const lost = addLead("lost");
  assert.deepEqual(await runNow("lead-reactivation", lost.id), { status: "not_owed", result: "Nothing to run (not_eligible_status)." });
  const closed = freshQuietLead();
  closed.conversation.status = "closed";
  assert.deepEqual(await runNow("lead-reactivation", closed.lead.id), { status: "not_owed", result: "Nothing to run (no_open_conversation)." });
  const silent = freshQuietLead();
  store.messages = store.messages!.filter((m) => m.conversation_id !== silent.conversation.id);
  assert.deepEqual(await runNow("lead-reactivation", silent.lead.id), { status: "not_owed", result: "Nothing to run (no_inbound_history)." });
  nothingRecorded();
});

// ---------------------------------------------------------------- Run now skips ONLY the cadence wait

test("8. not a bypass - A3: a newer open lead supersedes the lost one; recorded blocked under the same key, never handed to n8n", async () => {
  const lead = freshLostLead();
  addLead("new", { created_at: NOW.toISOString() });
  assert.deepEqual(await runNow("lost-lead-nurture", lead.id), { status: "blocked", result: "Touch recorded as blocked (lead_superseded)." });
  const [event] = touchEvents();
  assert.equal(event.idempotency_key, `lead.lost_nurture:${lead.id}:1`);
  assert.deepEqual([executionOf(event).outcome, calls.contracts.length, calls.sends], ["blocked", 0, 0]);
});

test("9. not a bypass - B1, the kill switch: an unreadable lifecycle or a disabled automation is never handed off", async () => {
  const lead = freshLostLead();
  control.snapshotFails = true;
  const failed = await runNow("lost-lead-nurture", lead.id);
  assert.notEqual(failed.status, "started");
  control.snapshotFails = false;
  assert.deepEqual([calls.contracts.length, store.workflow_executions!.length], [0, 0], "B1 runs before the claim");
  store.conversations = [];
  store.automation_settings![0].enabled = false;
  assert.deepEqual(await runNow("lost-lead-nurture", lead.id), { status: "not_owed", result: "Nothing to run (skipped_disabled)." });
  assert.equal(store.conversations!.length, 0, "a disabled automation stops before any conversation is opened");
  store.automation_settings![1].enabled = false;
  const { lead: quiet } = freshQuietLead();
  assert.deepEqual(await runNow("lead-reactivation", quiet.id), { status: "not_owed", result: "Nothing to run (skipped_disabled)." });
  nothingRecorded();
});

test("10. not a bypass - payment/live and the outbound gate: an inactive payment or an opted-out contact still blocks the returned draft", async () => {
  for (const [label, change, undo] of [
    ["payment inactive", () => (store.organizations![0].payment_status = "past_due"), () => (store.organizations![0].payment_status = "active")],
    ["opted out", () => (store.contacts![0].sms_opt_out = true), () => (store.contacts![0].sms_opt_out = false)],
  ] as [string, () => void, () => void][]) {
    store.leads = []; store.conversations = [];
    const lead = freshLostLead();
    assert.equal((await runNow("lost-lead-nurture", lead.id)).status, "started", label);
    const event = touchEvents().find((e) => e.entity_id === lead.id)!;
    change();
    const { json } = await reply(strictBody(event));
    assert.equal(json.sent, false, label);
    assert.equal(executionOf(event).outcome, "blocked", label);
    undo();
  }
  assert.deepEqual([calls.sends, outbound().length], [0, 0]);
});

test("11. idempotency: concurrent Run nows claim touch 1 once; while touch 1 is in flight another click is already processed; once it finished, the NEXT touch (2) runs under its own key; then nothing new", async () => {
  const lead = freshLostLead();
  for (let round = 0; round < 5; round += 1) {
    const results = await Promise.all([runNow("lost-lead-nurture", lead.id), runNow("lost-lead-nurture", lead.id), runNow("lost-lead-nurture", lead.id)]);
    assert.deepEqual(results.map((r) => r.status).sort(), round === 0 ? ["already_processed", "already_processed", "started"] : ["already_processed", "already_processed", "already_processed"], `round ${round}`);
  }
  assert.deepEqual(touchEvents().map((e) => e.idempotency_key), [`lead.lost_nurture:${lead.id}:1`], "touch 1 in flight: never touch 2");
  assert.equal(store.workflow_executions!.length, 1);
  const [touch1] = touchEvents();
  await reply(strictBody(touch1));
  assert.equal(touch1.status, "completed");
  const second = await runNow("lost-lead-nurture", lead.id);
  assert.match(String(second.result), /^Touch 2 handed to n8n/);
  assert.deepEqual(touchEvents().map((e) => e.idempotency_key), [`lead.lost_nurture:${lead.id}:1`, `lead.lost_nurture:${lead.id}:2`]);
  assert.equal((await runNow("lost-lead-nurture", lead.id)).status, "already_processed");
  await reply(strictBody(touchEvents()[1]));
  assert.equal((await runNow("lost-lead-nurture", lead.id)).status, "already_processed", "both touches done");

  const { lead: quiet } = freshQuietLead();
  assert.equal((await runNow("lead-reactivation", quiet.id)).status, "started");
  assert.equal((await runNow("lead-reactivation", quiet.id)).status, "already_processed", "touch 1 in flight");
  await reply(strictBody(touchEvents().find((e) => e.entity_id === quiet.id)!));
  assert.equal((await runNow("lead-reactivation", quiet.id)).status, "started", "touch 2 once touch 1 finished");
  assert.equal((await runNow("lead-reactivation", quiet.id)).status, "already_processed");
  assert.equal(touchEvents().length, 4);
  assert.deepEqual([calls.sends, outbound().length], [0, 0]);
});

test("12. Run now never sends: neither the action nor the per-lead entries reach a sender or the gate themselves", () => {
  const action = readFileSync(path.join(process.cwd(), "app/(app)/leads/actions.ts"), "utf8").split("export async function runLeadTouchNow")[1];
  for (const file of ["lib/automation/lead-nurture.ts", "lib/automation/lead-reactivation.ts"]) {
    const entry = readFileSync(path.join(process.cwd(), file), "utf8").split(/export async function runLead(?:Nurture|Reactivation)Now/)[1];
    for (const forbidden of [/sendSms\(/, /sendOutboundMessage\(/, /evaluateOutboundGate\(/]) {
      assert.ok(!forbidden.test(entry), `${file}: ${forbidden}`);
      assert.ok(!forbidden.test(action), `action: ${forbidden}`);
    }
  }
});
