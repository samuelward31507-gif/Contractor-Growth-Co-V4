/**
 * Phase 3G-2b: evaluateOutboundGate's invoice live re-check (invoiceId +
 * invoiceReminderStage) - organization, status, void, balance, contact and
 * the reminder stage window in the organization's timezone - and that every
 * pre-existing check (opt-out, payment, pause, AI-locked conversation,
 * duplicate send) still runs in front of it. Calls without invoiceId are
 * unaffected.
 *
 * Offline: an in-memory fake client. No network, no database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/outbound-gate.invoice.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { evaluateOutboundGate }: typeof import("./outbound-gate") = require(path.join(ROOT, "lib/automation/outbound-gate.ts"));
const { calendarDateInTimeZone }: typeof import("@/lib/invoices/domain") = require(path.join(ROOT, "lib/invoices/domain.ts"));

const TZ = "America/Denver";
const today = calendarDateInTimeZone(new Date(), TZ);
const daysAgo = (days: number) => {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
};

type Rows = Record<string, Record<string, unknown> | null>;

function fakeSupabase(overrides: Rows = {}) {
  const rows: Rows = {
    contacts: { id: "contact-1", organization_id: "org-1", sms_opt_out: false, phone: "+15555550123", phone_normalized: "+15555550123" },
    conversations: { id: "conv-1", organization_id: "org-1", contact_id: "contact-1", lead_id: null, channel: "sms", status: "open", ai_enabled: true },
    workflow_executions: { id: "exec-1", organization_id: "org-1", status: "running" },
    organizations: { id: "org-1", automation_mode: "live", payment_status: "active", automation_paused: false, timezone: TZ },
    messages: null,
    invoices: { id: "inv-1", organization_id: "org-1", status: "sent", balance_due: 450, due_date: daysAgo(3), contact_id: "contact-1", voided_at: null },
    ...overrides,
  };
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "in", "order", "limit"]) builder[name] = () => builder;
      builder.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      return builder;
    },
  } as unknown as SupabaseClient;
}

type GateInput = Parameters<typeof evaluateOutboundGate>[1];
const bodyFor = (amount: string) => `Acme Roofing: Reminder: invoice INV-000123 is still outstanding. Balance due: ${amount}. Pay securely: https://x.test/pay/t Reply STOP to opt out.`;
const INPUT: GateInput = {
  organizationId: "org-1",
  executionId: "exec-1",
  contactId: "contact-1",
  conversationId: "conv-1",
  leadId: null,
  aiResult: { should_send: true, response_message: bodyFor("$450"), needs_human: false },
  invoiceId: "inv-1",
  invoiceReminderStage: 1,
};

const reason = async (overrides: Rows = {}, input: Partial<GateInput> = {}) => {
  const result = await evaluateOutboundGate(fakeSupabase(overrides), { ...INPUT, ...input });
  return result.allowed ? "allowed" : result.reason;
};

test("an eligible invoice (sent, balance, right contact, inside the stage window) is allowed", async () => {
  assert.equal(await reason(), "allowed");
  assert.equal(
    await reason({ invoices: { id: "inv-1", organization_id: "org-1", status: "partially_paid", balance_due: 10.5, due_date: daysAgo(8), contact_id: "contact-1", voided_at: null } }, { invoiceReminderStage: 7, aiResult: { should_send: true, response_message: bodyFor("$10.50"), needs_human: false } }),
    "allowed",
  );
});

test("invoice sends: a stated amount must equal the live balance due exactly; other content-safety patterns still apply", async () => {
  assert.equal(await reason({}, { aiResult: { should_send: true, response_message: bodyFor("$400"), needs_human: false } }), "unsafe_content", "amount differs from the live balance");
  const paidMeanwhile = { invoices: { id: "inv-1", organization_id: "org-1", status: "partially_paid", balance_due: 200, due_date: daysAgo(3), contact_id: "contact-1", voided_at: null } };
  assert.equal(await reason(paidMeanwhile), "unsafe_content", "a payment landed after the message was composed - the stale amount is never sent");
  assert.equal(await reason({}, { aiResult: { should_send: true, response_message: `${bodyFor("$450")} Use promo code SAVE for a discount.`, needs_human: false } }), "unsafe_content", "discount pattern still blocks");
  assert.equal(await reason({}, { aiResult: { should_send: true, response_message: `${bodyFor("$450")} Payment received, thank you.`, needs_human: false } }), "unsafe_content", "payment-claim pattern still blocks");
});

test("the invoice re-check denies: missing, another organization's, draft/paid/void, zero balance, voided, a different contact", async () => {
  const base = { id: "inv-1", organization_id: "org-1", status: "sent", balance_due: 450, due_date: daysAgo(3), contact_id: "contact-1", voided_at: null };
  assert.equal(await reason({ invoices: null }), "invoice_not_found");
  assert.equal(await reason({ invoices: { ...base, organization_id: "org-2" } }), "invoice_wrong_organization");
  for (const status of ["draft", "paid", "void"]) assert.equal(await reason({ invoices: { ...base, status } }), "invoice_status_ineligible", status);
  assert.equal(await reason({ invoices: { ...base, balance_due: 0 } }), "invoice_settled");
  assert.equal(await reason({ invoices: { ...base, voided_at: "2026-10-01T00:00:00Z" } }), "invoice_settled");
  assert.equal(await reason({ invoices: { ...base, contact_id: "contact-2" } }), "invoice_contact_mismatch");
});

test("stage windows in the organization's timezone: the requested stage must match today's window; nothing outside 1-20 days", async () => {
  const at = (days: number) => ({ invoices: { id: "inv-1", organization_id: "org-1", status: "sent", balance_due: 450, due_date: daysAgo(days), contact_id: "contact-1", voided_at: null } });
  for (const [days, stage, expected] of [
    [1, 1, "allowed"],
    [6, 1, "allowed"],
    [7, 1, "invoice_stage_ineligible"],
    [7, 7, "allowed"],
    [13, 7, "allowed"],
    [14, 14, "allowed"],
    [20, 14, "allowed"],
    [21, 14, "invoice_stage_ineligible"],
    [0, 1, "invoice_stage_ineligible"],
    [-2, 1, "invoice_stage_ineligible"],
  ] as const) {
    assert.equal(await reason(at(days), { invoiceReminderStage: stage }), expected, `${days} days, stage ${stage}`);
  }
});

test("existing checks still run first: opt-out, payment inactive, automation paused, AI-locked conversation, duplicate send, not live", async () => {
  assert.equal(await reason({ contacts: { id: "contact-1", organization_id: "org-1", sms_opt_out: true, phone: "+15555550123", phone_normalized: "+15555550123" } }), "contact_opted_out");
  assert.equal(await reason({ organizations: { id: "org-1", automation_mode: "live", payment_status: "suspended", automation_paused: false, timezone: TZ } }), "organization_payment_inactive");
  assert.equal(await reason({ organizations: { id: "org-1", automation_mode: "live", payment_status: "active", automation_paused: true, timezone: TZ } }), "organization_automation_paused");
  assert.equal(await reason({ organizations: { id: "org-1", automation_mode: "test", payment_status: "active", automation_paused: false, timezone: TZ } }), "organization_not_live");
  assert.equal(await reason({ conversations: { id: "conv-1", organization_id: "org-1", contact_id: "contact-1", lead_id: null, channel: "sms", status: "open", ai_enabled: false } }), "conversation_ai_disabled");
  assert.equal(await reason({ messages: { id: "msg-1" } }), "duplicate_outbound_send");
});

test("calls without invoiceId never read invoices (other automations unaffected)", async () => {
  const reads: string[] = [];
  const supabase = fakeSupabase({ invoices: null });
  const tracking = { from: (table: string) => (reads.push(table), (supabase as unknown as { from: (t: string) => unknown }).from(table)) } as unknown as SupabaseClient;
  const plain = { should_send: true, response_message: "Hi there, just checking in about your project. Reply STOP to opt out.", needs_human: false };
  const result = await evaluateOutboundGate(tracking, { ...INPUT, invoiceId: undefined, invoiceReminderStage: undefined, aiResult: plain });
  assert.equal(result.allowed, true);
  assert.ok(!reads.includes("invoices"));
  // Without invoiceId the price check is exactly as before: any dollar amount is rejected.
  const priced = await evaluateOutboundGate(fakeSupabase(), { ...INPUT, invoiceId: undefined, invoiceReminderStage: undefined });
  assert.deepEqual([priced.allowed, priced.allowed ? null : priced.reason], [false, "unsafe_content"]);
});
