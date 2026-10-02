/**
 * Phase 3G-2b: automated invoice reminders (lib/automation/invoice-reminders.ts)
 * - off by default, eligibility, the 9:00-18:00 local window, stage windows
 * with no backfill, the delivered prerequisite and 48-hour quiet period, one
 * reminder per customer per day, no send without a payment link, per-stage
 * idempotency with blocked/failed stages never retried, the approved
 * wording, organization isolation and the scheduled route.
 *
 * Offline: the outbound gate and sendOutboundMessage are module-mocked (the
 * gate's invoice checks have their own tests); everything else runs against
 * an in-memory fake service client. No network, no database, no local
 * environment file.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/automation/invoice-reminders.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type GateCall = { organizationId: string; contactId: string; conversationId: string | null; invoiceId?: string; invoiceReminderStage?: number; aiResult: { response_message: string } };
const gateCalls: GateCall[] = [];
let gateDeny: string | null = null;
mock.module(lib("lib/automation/outbound-gate.ts"), {
  namedExports: {
    evaluateOutboundGate: async (_s: unknown, input: GateCall) => {
      gateCalls.push(input);
      return gateDeny ? { allowed: false, reason: gateDeny } : { allowed: true, contactId: input.contactId, conversationId: input.conversationId, body: input.aiResult.response_message };
    },
  },
});

type SendCall = { organizationId: string; contactId: string; body: string; senderType: string; workflowExecutionId: string; channel: string };
const sendCalls: SendCall[] = [];
let sendOk = true;
mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async (_s: unknown, input: SendCall) => (sendCalls.push(input), sendOk ? { ok: true, messageId: `msg-${sendCalls.length}`, conversationId: "conv-1", providerMessageId: "SM" } : { ok: false, error: "provider said no", messageId: null, conversationId: null }),
  },
});

process.env.APP_BASE_URL = "https://app.example.test";
const reminders: typeof import("./invoice-reminders") = await import(lib("lib/automation/invoice-reminders.ts"));
const { processInvoiceReminders, composeInvoiceReminderMessage, isWithinReminderHours, invoiceReminderIdempotencyKey, INVOICE_REMINDER_EVENT_TYPE, INVOICE_REMINDER_WORKFLOW } = reminders;
const { getAutomationDefinition, getAutomationForEventType, getAutomationDefaultEnabled }: typeof import("./catalog") = await import(lib("lib/automation/catalog.ts"));
const { getAutomationEnabled }: typeof import("./settings") = await import(lib("lib/automation/settings.ts"));
const { reminderStageFor, daysOverdue }: typeof import("@/lib/invoices/reminder-stages") = await import(lib("lib/invoices/reminder-stages.ts"));

// Monday 2026-10-05 16:00Z = 10:00 in America/Denver.
const NOW = new Date("2026-10-05T16:00:00Z");
const TOKEN = "b".repeat(48);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const dueDaysAgo = (d: number) => new Date(Date.UTC(2026, 9, 5 - d)).toISOString().slice(0, 10);

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function baseTables(): Tables {
  return {
    automation_settings: [{ organization_id: "org-1", automation_id: "invoice-reminders", enabled: true }],
    organizations: [
      { id: "org-1", name: "Acme Roofing", timezone: "America/Denver", payment_status: "active", automation_mode: "live", automation_paused: false, stripe_connect_account_id: "acct_1", stripe_connect_charges_enabled: true },
    ],
    invoices: [],
    automation_events: [],
  };
}

function invoice(id: string, days: number, extra: Row = {}): Row {
  return { id, organization_id: "org-1", number: Number(id.replace(/\D/g, "")) || 1, status: "sent", balance_due: 450, due_date: dueDaysAgo(days), contact_id: "contact-1", payment_token: TOKEN, ...extra };
}
function delivered(invoiceId: string, hours: number, org = "org-1"): Row {
  return { organization_id: org, event_type: "invoice.delivered", entity_type: "invoice", entity_id: invoiceId, created_at: hoursAgo(hours), idempotency_key: `invoice.delivered:${invoiceId}:m${hours}` };
}

function fakeService(t: Tables) {
  const rpcCalls: { name: string; args: Row }[] = [];
  const reads: string[] = [];
  let seq = 0;
  const supabase = {
    rpc(name: string, args: Row = {}) {
      rpcCalls.push({ name, args });
      const answer = () => {
        if (name === "create_automation_event") {
          const key = String(args.p_idempotency_key);
          const existing = t.automation_events.find((e) => e.organization_id === args.p_organization_id && e.idempotency_key === key);
          if (existing) return { data: { ...existing, is_duplicate: true }, error: null };
          const created = { id: `event-${++seq}`, organization_id: args.p_organization_id, event_type: args.p_event_type, entity_type: args.p_entity_type, entity_id: args.p_entity_id, payload: args.p_payload, idempotency_key: key, created_at: NOW.toISOString() };
          t.automation_events.push(created);
          return { data: { ...created, is_duplicate: false }, error: null };
        }
        if (name === "start_workflow_execution") return { data: { id: `exec-${seq}`, status: "running" }, error: null };
        if (name === "complete_workflow_execution" || name === "fail_workflow_execution") return { data: { id: args.p_execution_id }, error: null };
        return { data: null, error: null };
      };
      const result = Promise.resolve(answer());
      return Object.assign(result, { single: () => result });
    },
    from(table: string) {
      reads.push(table);
      const filters: ((row: Row) => boolean)[] = [];
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder);
      builder.in = (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), builder);
      builder.gte = (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), builder);
      builder.lte = (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), builder);
      const rows = () => (t[table] ?? []).filter((r) => filters.every((f) => f(r)));
      builder.range = async (from: number, to: number) => ({ data: rows().slice(from, to + 1), error: null });
      builder.maybeSingle = async () => ({ data: table === "workflow_executions" ? { status: "running" } : (rows()[0] ?? null), error: null });
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve);
      builder.insert = (row: Row) => ({
        select: () => ({
          single: async () => {
            const created = { id: `conv-${(t[table] ??= []).length + 1}`, status: "open", ...row };
            t[table].push(created);
            return { data: created, error: null };
          },
        }),
      });
      return builder;
    },
  } as unknown as SupabaseClient;
  return { supabase, rpcCalls, reads };
}

const run = (t: Tables, now = NOW) => processInvoiceReminders(fakeService(t).supabase, now, { log: () => {} });
const outcomes = (r: Awaited<ReturnType<typeof run>>) => r.outcomes.map((o) => `${o.invoiceId}:${o.outcome}${o.stage ? `@${o.stage}` : ""}`);

beforeEach(() => {
  gateCalls.length = 0;
  sendCalls.length = 0;
  gateDeny = null;
  sendOk = true;
});

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

test("stage windows: 1-6 -> 1, 7-13 -> 7, 14-20 -> 14; due today, before due and 21+ days -> nothing (no backfill)", () => {
  const expected: [number, number | null][] = [[-1, null], [0, null], [1, 1], [6, 1], [7, 7], [13, 7], [14, 14], [20, 14], [21, null], [60, null]];
  for (const [days, stage] of expected) assert.equal(reminderStageFor(days), stage, `${days} days`);
  assert.equal(daysOverdue("2026-03-09", "2026-03-07"), 2, "calendar days, unaffected by a DST change");
});

test("daytime window: 9:00 to before 18:00 in the organization's timezone", () => {
  assert.equal(isWithinReminderHours(new Date("2026-10-05T15:00:00Z"), "America/Denver"), true, "09:00 Denver");
  assert.equal(isWithinReminderHours(new Date("2026-10-05T14:59:00Z"), "America/Denver"), false, "08:59");
  assert.equal(isWithinReminderHours(new Date("2026-10-05T23:59:00Z"), "America/Denver"), true, "17:59");
  assert.equal(isWithinReminderHours(new Date("2026-10-06T00:00:00Z"), "America/Denver"), false, "18:00");
  assert.equal(isWithinReminderHours(NOW, "Asia/Tokyo"), false, "01:00 Tokyo");
});

test("wording: the three approved stage messages with business name, invoice number, due date, balance and link", () => {
  const input = { businessName: "Acme Roofing", invoiceNumber: 7, balanceDue: 450, dueDate: "2026-10-02", paymentUrl: "https://app.example.test/pay/x" };
  assert.equal(composeInvoiceReminderMessage({ ...input, stage: 1 }), "Acme Roofing: Invoice INV-000007 was due Oct 2, 2026 and still has a balance of $450. Pay securely: https://app.example.test/pay/x Reply STOP to opt out.");
  assert.equal(composeInvoiceReminderMessage({ ...input, stage: 7 }), "Acme Roofing: Reminder: invoice INV-000007 is still outstanding. Balance due: $450. Pay securely: https://app.example.test/pay/x Reply STOP to opt out.");
  assert.equal(composeInvoiceReminderMessage({ ...input, stage: 14 }), "Acme Roofing: Final reminder: invoice INV-000007 is still outstanding. Balance due: $450. Pay securely: https://app.example.test/pay/x Reply STOP to opt out.");
});

test("catalog: invoice-reminders is a scheduled, Trackpr-composed automation that defaults OFF; nothing else changed default", async () => {
  const definition = getAutomationDefinition("invoice-reminders")!;
  assert.deepEqual([definition.kind, definition.dispatch, definition.defaultEnabled, definition.eventTypes, definition.workflowNames], ["scheduled", "trackpr", false, [INVOICE_REMINDER_EVENT_TYPE], [INVOICE_REMINDER_WORKFLOW]]);
  assert.equal(getAutomationForEventType("invoice.reminder")?.id, "invoice-reminders");
  assert.equal(getAutomationForEventType("invoice.delivered"), null, "manual delivery is never gated by the automation toggle");
  assert.equal(getAutomationDefaultEnabled("invoice-reminders"), false);
  const settings = (row: Row | null) => ({ from: () => { const b: Record<string, unknown> = {}; b.select = () => b; b.eq = () => b; b.maybeSingle = async () => ({ data: row, error: null }); return b; } }) as unknown as SupabaseClient;
  assert.equal(await getAutomationEnabled(settings(null), "org-1", "invoice-reminders"), false, "no row = off");
  assert.equal(await getAutomationEnabled(settings({ enabled: true }), "org-1", "invoice-reminders"), true, "explicit opt-in");
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test("off by default: with no opt-in row nothing is scanned or sent", async () => {
  const t = baseTables();
  t.automation_settings = [];
  t.invoices = [invoice("inv-1", 3)];
  t.automation_events = [delivered("inv-1", 72)];
  const { supabase, reads } = fakeService(t);
  const result = await processInvoiceReminders(supabase, NOW, { log: () => {} });
  assert.deepEqual([result.candidates, result.sent, sendCalls.length], [0, 0, 0]);
  assert.ok(!reads.includes("invoices"));
});

test("opted in but not live, payment inactive or paused: the organization is not considered", async () => {
  for (const change of [{ automation_mode: "test" }, { payment_status: "suspended" }, { automation_paused: true }]) {
    const t = baseTables();
    t.organizations[0] = { ...t.organizations[0], ...change };
    t.invoices = [invoice("inv-1", 3)];
    t.automation_events = [delivered("inv-1", 72)];
    const result = await run(t);
    assert.deepEqual([result.sent, sendCalls.length], [0, 0], JSON.stringify(change));
  }
});

test("outside 9:00-18:00 local nothing is read or sent", async () => {
  const t = baseTables();
  t.invoices = [invoice("inv-1", 3)];
  t.automation_events = [delivered("inv-1", 72)];
  const { supabase, reads } = fakeService(t);
  const result = await processInvoiceReminders(supabase, new Date("2026-10-05T13:00:00Z"), { log: () => {} });
  assert.deepEqual(outcomes(result), ["null:outside_hours"]);
  assert.ok(!reads.includes("invoices"));
});

test("stages: 3, 8 and 15 days overdue send stages 1, 7 and 14; due today and 21+ days overdue are never candidates", async () => {
  const t = baseTables();
  t.invoices = [invoice("inv-1", 3, { contact_id: "c1" }), invoice("inv-2", 8, { contact_id: "c2" }), invoice("inv-3", 15, { contact_id: "c3" }), invoice("inv-4", 0, { contact_id: "c4" }), invoice("inv-5", 21, { contact_id: "c5" })];
  t.automation_events = ["inv-1", "inv-2", "inv-3", "inv-4", "inv-5"].map((id) => delivered(id, 100));
  const result = await run(t);
  assert.deepEqual(outcomes(result).sort(), ["inv-1:sent@1", "inv-2:sent@7", "inv-3:sent@14"]);
  assert.deepEqual(gateCalls.map((c) => [c.invoiceId, c.invoiceReminderStage]).sort(), [["inv-1", 1], ["inv-2", 7], ["inv-3", 14]]);
  assert.deepEqual(sendCalls.map((s) => [s.senderType, s.channel]), [["system", "sms"], ["system", "sms"], ["system", "sms"]]);
});

test("delivery prerequisite: never reminded without a successful Send to customer; not within 48 hours of the latest delivery", async () => {
  const t = baseTables();
  t.invoices = [invoice("inv-1", 3, { contact_id: "c1" }), invoice("inv-2", 3, { contact_id: "c2" }), invoice("inv-3", 3, { contact_id: "c3" })];
  t.automation_events = [delivered("inv-2", 47), delivered("inv-3", 100), delivered("inv-3", 49)];
  const result = await run(t);
  assert.deepEqual(outcomes(result), ["inv-1:not_delivered@1", "inv-2:recently_delivered@1", "inv-3:sent@1"]);
  assert.ok(!t.automation_events.some((e) => e.event_type === "invoice.reminder" && e.entity_id !== "inv-3"), "skips before the event record nothing");
});

test("one reminder per customer per local day: the oldest overdue invoice goes first, the rest wait; an earlier reminder today also counts", async () => {
  const t = baseTables();
  t.invoices = [invoice("inv-2", 8), invoice("inv-1", 3)];
  t.automation_events = [delivered("inv-1", 100), delivered("inv-2", 100)];
  const first = await run(t);
  assert.deepEqual(outcomes(first), ["inv-2:sent@7", "inv-1:contact_reminded_today@1"]);
  const second = await run(t, new Date(NOW.getTime() + 15 * 60_000));
  assert.deepEqual(outcomes(second), ["inv-2:duplicate@7", "inv-1:contact_reminded_today@1"], "still the same local day");
  const tomorrow = await run(t, new Date(NOW.getTime() + 24 * 3600_000));
  assert.ok(outcomes(tomorrow).includes("inv-1:sent@1"), "the other invoice is sent on a later day inside its window");
});

test("no usable payment link: the stage is recorded as skipped (no_payment_link), nothing is sent, and it is not retried", async () => {
  const t = baseTables();
  t.organizations[0] = { ...t.organizations[0], stripe_connect_charges_enabled: false };
  t.invoices = [invoice("inv-1", 3)];
  t.automation_events = [delivered("inv-1", 100)];
  const { supabase, rpcCalls } = fakeService(t);
  const result = await processInvoiceReminders(supabase, NOW, { log: () => {} });
  assert.deepEqual([outcomes(result), sendCalls.length, gateCalls.length], [["inv-1:no_payment_link@1"], 0, 0]);
  assert.deepEqual((rpcCalls.find((c) => c.name === "complete_workflow_execution")!.args.p_metadata as Row).blocked_reason, "payment_link_unavailable");
  t.organizations[0] = { ...t.organizations[0], stripe_connect_charges_enabled: true };
  const later = await run(t, new Date(NOW.getTime() + 2 * 3600_000));
  assert.deepEqual(outcomes(later), ["inv-1:duplicate@1"]);
});

test("gate denial (e.g. opted out, AI-locked conversation, paid meanwhile): blocked, execution completed, nothing sent, never retried", async () => {
  for (const reason of ["contact_opted_out", "conversation_ai_disabled", "invoice_status_ineligible", "organization_automation_paused"]) {
    gateDeny = reason;
    sendCalls.length = 0;
    const t = baseTables();
    t.invoices = [invoice("inv-1", 3)];
    t.automation_events = [delivered("inv-1", 100)];
    const result = await run(t);
    assert.deepEqual([outcomes(result), result.outcomes[0].reason, sendCalls.length], [["inv-1:blocked@1"], reason, 0], reason);
    gateDeny = null;
    assert.deepEqual(outcomes(await run(t, new Date(NOW.getTime() + 3600_000))), ["inv-1:duplicate@1"], `${reason}: not retried`);
  }
});

test("send failure: the execution fails (sms_send_failed), the run reports a failure, and the stage is not retried; the next stage can still run", async () => {
  sendOk = false;
  const t = baseTables();
  t.invoices = [invoice("inv-1", 3)];
  t.automation_events = [delivered("inv-1", 100)];
  const { supabase, rpcCalls } = fakeService(t);
  const result = await processInvoiceReminders(supabase, NOW, { log: () => {} });
  assert.deepEqual([outcomes(result), result.failed], [["inv-1:failed@1"], 1]);
  assert.equal(rpcCalls.find((c) => c.name === "fail_workflow_execution")!.args.p_error_message, "The invoice reminder SMS could not be sent.");
  sendOk = true;
  assert.deepEqual(outcomes(await run(t, new Date(NOW.getTime() + 3600_000))), ["inv-1:duplicate@1"]);
  const sevenDaysLater = await run(t, new Date(NOW.getTime() + 5 * 24 * 3600_000));
  assert.deepEqual(outcomes(sevenDaysLater), ["inv-1:sent@7"], "stage 7 runs when its window opens");
});

test("idempotency: the event key is invoice.reminder:<invoice>:<stage>; its payload has ids and dates only - no phone, message or link", async () => {
  const t = baseTables();
  t.invoices = [invoice("inv-1", 3)];
  t.automation_events = [delivered("inv-1", 100)];
  const { supabase, rpcCalls } = fakeService(t);
  await processInvoiceReminders(supabase, NOW, { log: () => {} });
  const event = rpcCalls.find((c) => c.name === "create_automation_event")!;
  assert.equal(event.args.p_idempotency_key, invoiceReminderIdempotencyKey("inv-1", 1));
  assert.equal(event.args.p_event_type, "invoice.reminder");
  const payload = JSON.stringify(event.args.p_payload);
  assert.ok(!payload.includes(TOKEN) && !payload.includes("/pay/") && !payload.includes("Reply STOP"));
  assert.match(sendCalls[0].body, new RegExp(`Pay securely: https://app\\.example\\.test/pay/${TOKEN} Reply STOP to opt out\\.$`));
  assert.equal(sendCalls[0].workflowExecutionId, "exec-1");
});

test("organization isolation: another organization's invoices and delivery events never count", async () => {
  const t = baseTables();
  t.invoices = [invoice("inv-1", 3), { ...invoice("inv-9", 3), organization_id: "org-2" }];
  t.automation_events = [delivered("inv-1", 100, "org-2"), delivered("inv-9", 100, "org-2")];
  const result = await run(t);
  assert.deepEqual(outcomes(result), ["inv-1:not_delivered@1"], "org-2's delivery event doesn't unlock org-1's invoice, and org-2's invoice isn't scanned");
});

test("zero-balance or contactless invoices are never candidates", async () => {
  const t = baseTables();
  t.invoices = [invoice("inv-1", 3, { balance_due: 0 }), invoice("inv-2", 3, { contact_id: null })];
  t.automation_events = [delivered("inv-1", 100), delivered("inv-2", 100)];
  const result = await run(t);
  assert.deepEqual([result.candidates, sendCalls.length], [0, 0]);
});

// ---------------------------------------------------------------------------
// Structure and route
// ---------------------------------------------------------------------------

test("structure: sends only through evaluateOutboundGate + sendOutboundMessage - no raw SMS sender, Twilio or n8n", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/automation/invoice-reminders.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(code, /evaluateOutboundGate\(service, \{/);
  assert.match(code, /sendOutboundMessage\(service, \{/);
  assert.match(code, /invoiceId: current\.id,\s*invoiceReminderStage: stage,/);
  assert.doesNotMatch(code, /sendSms\(|twilio|triggerN8n/i);
});

test("route: CRON_SECRET fails closed (401), authorizes before the service client, records liveness as 'invoice-reminders'", async () => {
  const { GET, POST }: typeof import("@/app/api/automation/invoice-reminders/route") = await import(lib("app/api/automation/invoice-reminders/route.ts"));
  const { NextRequest }: typeof import("next/server") = await import("next/server");
  const original = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = "test-secret-value";
    for (const handler of [GET, POST]) {
      assert.equal((await handler(new NextRequest("https://example.test/api/automation/invoice-reminders"))).status, 401);
      assert.equal((await handler(new NextRequest("https://example.test/api/automation/invoice-reminders", { headers: { authorization: "Bearer wrong-secret-value" } }))).status, 401);
    }
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
  const source = fs.readFileSync(path.join(process.cwd(), "app/api/automation/invoice-reminders/route.ts"), "utf8");
  assert.ok(source.indexOf("isAuthorizedCronRequest(request)") < source.indexOf("createServiceRoleClient()"));
  assert.match(source, /recordScheduledAutomationRun\(service, "invoice-reminders", result\.candidates\)/);
  assert.match(source, /ok: !result\.scanFailed && result\.failed === 0/);
  const { SCHEDULED_AUTOMATION_IDS }: typeof import("@/lib/automation-health/scheduled-automation-liveness") = await import(lib("lib/automation-health/scheduled-automation-liveness.ts"));
  assert.ok((SCHEDULED_AUTOMATION_IDS as readonly string[]).includes("invoice-reminders"));
});
