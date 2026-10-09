/**
 * Phase 3G-2a: "Send to customer" (lib/invoices/delivery.ts) - every check
 * re-read right before sending (status, balance, contact, phone, opt-out,
 * usable payment link), the send going through sendOutboundMessage (mocked
 * here to capture the call - never a raw provider call), invoice.delivered
 * recorded only on success (one per send, so "Send again" records its own),
 * the approved wording, organization scoping, the page state and that the
 * payment token never reaches logs or errors.
 *
 * Offline: module mocks plus an in-memory fake session client. No network,
 * no database, no local environment file.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./lib/automation/test-loader.mjs --test lib/invoices/delivery.test.ts
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";

const lib = (relative: string) => pathToFileURL(path.join(process.cwd(), relative)).href;

type SendCall = { organizationId: string; contactId: string; conversationId?: string | null; channel?: string; senderType?: string; body: string; simulate?: true; simulationEnv?: unknown };
const sends: SendCall[] = [];
let sendResult: { ok: true; messageId: string; conversationId: string; providerMessageId: string; simulated?: true } | { ok: false; error: string; messageId: string | null; conversationId: string | null; providerUnconfigured?: true; providerErrorCode?: string; recipientOptedOut?: true } = { ok: true, messageId: "msg-1", conversationId: "conv-1", providerMessageId: "SM1" };

mock.module(lib("lib/messaging/outbound.ts"), {
  namedExports: {
    sendOutboundMessage: async (_supabase: unknown, input: SendCall) => (sends.push(input), sendResult),
  },
});

const delivery: typeof import("./delivery") = await import(lib("lib/invoices/delivery.ts"));
const { deliverInvoiceToCustomer, getInvoiceDeliveryState, composeInvoiceDeliveryMessage, formatDueDate, maskPhone, DELIVERY_BLOCK_MESSAGE, deliveryFailureCause } = delivery;

const TOKEN = "a".repeat(48);
const BASE_URL = "https://app.example.test";
const PHONE = "+15555550123";

type Row = Record<string, unknown>;
type World = {
  invoices: Row[];
  contacts: Row[];
  organizations: Row[];
  conversations: Row[];
  events: Row[];
};

const INVOICE: Row = { id: "inv-1", organization_id: "org-1", number: 123, status: "sent", balance_due: 450, due_date: "2026-10-19", contact_id: "contact-1", voided_at: null, payment_token: TOKEN };
const CONTACT: Row = { id: "contact-1", organization_id: "org-1", phone: PHONE, phone_normalized: PHONE, sms_opt_out: false };
const ORG: Row = { id: "org-1", stripe_connect_account_id: "acct_1", stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true, stripe_connect_details_submitted: true, stripe_connect_synced_at: null };

function world(overrides: Partial<World> = {}): World {
  return { invoices: [{ ...INVOICE }], contacts: [{ ...CONTACT }], organizations: [{ ...ORG }], conversations: [], events: [], ...overrides };
}

/** A minimal fake session client: equality filters over in-memory tables, plus conversation insert. */
function fakeSupabase(w: World) {
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const rows = () => ((w as unknown as Record<string, Row[]>)[table === "automation_events" ? "events" : table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value));
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "order", "limit"]) builder[name] = () => builder;
      builder.eq = (column: string, value: unknown) => (filters.push([column, value]), builder);
      builder.maybeSingle = async () => {
        const found = rows();
        const ordered = table === "automation_events" ? [...found].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) : found;
        return { data: ordered[0] ?? null, error: null };
      };
      builder.insert = (row: Row) => ({
        select: () => ({
          single: async () => {
            const created = { id: `conv-${w.conversations.length + 1}`, ...row };
            w.conversations.push(created);
            return { data: created, error: null };
          },
        }),
      });
      return builder;
    },
  } as unknown as SupabaseClient;
}

const CONTEXT = { paymentStatus: "active", baseUrl: BASE_URL, businessName: "Acme Roofing" };

function emitRecorder() {
  const emitted: unknown[] = [];
  return { emitted, emitLifecycleEvent: async (_s: SupabaseClient, input: unknown) => void emitted.push(input) };
}

beforeEach(() => {
  sends.length = 0;
  sendResult = { ok: true, messageId: "msg-1", conversationId: "conv-1", providerMessageId: "SM1" };
});

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

test("wording: the approved initial-delivery text with the business name, invoice number, balance, due date and payment link", () => {
  assert.equal(
    composeInvoiceDeliveryMessage({ businessName: "Acme Roofing", invoiceNumber: 123, balanceDue: 450, dueDate: "2026-10-19", invoiceUrl: `${BASE_URL}/pay/${TOKEN}`, cardPayment: true }),
    `Acme Roofing: Invoice INV-000123 for $450 is ready. It's due Oct 19, 2026. Pay securely: ${BASE_URL}/pay/${TOKEN} Reply STOP to opt out.`,
  );
  // Without online card payment the same invoice page is offered to view - never "Pay securely".
  assert.equal(
    composeInvoiceDeliveryMessage({ businessName: "Acme Roofing", invoiceNumber: 123, balanceDue: 450, dueDate: null, invoiceUrl: `${BASE_URL}/pay/${TOKEN}`, cardPayment: false }),
    `Acme Roofing: Invoice INV-000123 for $450 is ready. View it here: ${BASE_URL}/pay/${TOKEN} Reply STOP to opt out.`,
  );
  assert.equal(formatDueDate("2026-01-01"), "Jan 1, 2026", "a calendar date never shifts a day across time zones");
  assert.equal(maskPhone(PHONE), "•••• 0123");
});

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

test("send: a sendable invoice texts its own customer once through sendOutboundMessage (SMS, user-sent) and records invoice.delivered", async () => {
  const w = world();
  const { emitted, emitLifecycleEvent } = emitRecorder();
  const result = await deliverInvoiceToCustomer(fakeSupabase(w), "org-1", "inv-1", CONTEXT, { emitLifecycleEvent, now: () => new Date("2026-10-10T15:00:00Z") });
  assert.deepEqual(result, { ok: true, deliveredAt: "2026-10-10T15:00:00.000Z" });
  assert.equal(sends.length, 1);
  assert.deepEqual({ ...sends[0], body: undefined }, { organizationId: "org-1", contactId: "contact-1", conversationId: "conv-1", channel: "sms", senderType: "user", body: undefined, sendSmsFn: undefined });
  assert.match(sends[0].body, new RegExp(`Pay securely: ${BASE_URL}/pay/${TOKEN} Reply STOP to opt out\\.$`));
  assert.deepEqual(emitted, [
    { eventType: "invoice.delivered", invoiceId: "inv-1", messageId: "msg-1", payload: { invoice_id: "inv-1", number: 123, contact_id: "contact-1", message_id: "msg-1", balance_due: 450, due_date: "2026-10-19" } },
  ]);
});

test("send: partially paid invoices are sendable and the text names the remaining balance", async () => {
  const w = world({ invoices: [{ ...INVOICE, status: "partially_paid", balance_due: 125.5 }] });
  const { emitLifecycleEvent } = emitRecorder();
  const result = await deliverInvoiceToCustomer(fakeSupabase(w), "org-1", "inv-1", CONTEXT, { emitLifecycleEvent });
  assert.equal(result.ok, true);
  assert.match(sends[0].body, /for \$125\.50 is ready/);
});

test("send again: each successful send records its own invoice.delivered (keyed by its message)", async () => {
  const w = world();
  const { emitted, emitLifecycleEvent } = emitRecorder();
  await deliverInvoiceToCustomer(fakeSupabase(w), "org-1", "inv-1", CONTEXT, { emitLifecycleEvent });
  sendResult = { ok: true, messageId: "msg-2", conversationId: "conv-1", providerMessageId: "SM2" };
  await deliverInvoiceToCustomer(fakeSupabase(w), "org-1", "inv-1", CONTEXT, { emitLifecycleEvent });
  assert.deepEqual((emitted as { messageId: string }[]).map((e) => e.messageId), ["msg-1", "msg-2"]);
  const { invoiceLifecycleIdempotencyKey }: typeof import("@/lib/automation/invoices") = await import(lib("lib/automation/invoices.ts"));
  assert.equal(invoiceLifecycleIdempotencyKey(emitted[1] as Parameters<typeof invoiceLifecycleIdempotencyKey>[0]), "invoice.delivered:inv-1:msg-2");
});

test("blocked: each failed precondition sends nothing, records nothing and returns its fixed reason", async () => {
  const cases: [string, Partial<World>, keyof typeof DELIVERY_BLOCK_MESSAGE, Record<string, unknown>?][] = [
    ["not found / another organization's invoice", { invoices: [{ ...INVOICE, organization_id: "org-2" }] }, "not_found"],
    ["draft", { invoices: [{ ...INVOICE, status: "draft" }] }, "status_ineligible"],
    ["paid", { invoices: [{ ...INVOICE, status: "paid", balance_due: 0 }] }, "status_ineligible"],
    ["void", { invoices: [{ ...INVOICE, status: "void", voided_at: "2026-10-01T00:00:00Z" }] }, "status_ineligible"],
    ["zero balance", { invoices: [{ ...INVOICE, balance_due: 0 }] }, "settled"],
    ["no contact on the invoice", { invoices: [{ ...INVOICE, contact_id: null }] }, "no_contact"],
    ["contact belongs to another organization", { contacts: [{ ...CONTACT, organization_id: "org-2" }] }, "no_contact"],
    ["no phone", { contacts: [{ ...CONTACT, phone: null, phone_normalized: null }] }, "no_phone"],
    ["opted out", { contacts: [{ ...CONTACT, sms_opt_out: true }] }, "opted_out"],
    ["malformed token", { invoices: [{ ...INVOICE, payment_token: "not-a-token" }] }, "link_unavailable"],
  ];
  for (const [name, overrides, reason] of cases) {
    sends.length = 0;
    const { emitted, emitLifecycleEvent } = emitRecorder();
    const result = await deliverInvoiceToCustomer(fakeSupabase(world(overrides)), "org-1", "inv-1", CONTEXT, { emitLifecycleEvent });
    assert.deepEqual(result, { ok: false, error: DELIVERY_BLOCK_MESSAGE[reason] }, name);
    assert.deepEqual([sends.length, emitted.length], [0, 0], name);
  }
});

test("blocked: an organization whose payment isn't active, or no app base URL, never sends a link", async () => {
  const cases: [Record<string, unknown>, keyof typeof DELIVERY_BLOCK_MESSAGE, Partial<World>?][] = [
    [{ ...CONTEXT, paymentStatus: "suspended" }, "subscription_inactive"],
    [{ ...CONTEXT, paymentStatus: null }, "subscription_inactive"],
    [{ ...CONTEXT, baseUrl: null }, "link_unavailable"],
    // Without Stripe Connect the inactive subscription and missing base URL still block.
    [{ ...CONTEXT, paymentStatus: "suspended" }, "subscription_inactive", { organizations: [{ ...ORG, stripe_connect_account_id: null, stripe_connect_charges_enabled: false }] }],
    [{ ...CONTEXT, baseUrl: null }, "link_unavailable", { organizations: [{ ...ORG, stripe_connect_account_id: null, stripe_connect_charges_enabled: false }] }],
  ];
  for (const [context, reason, overrides] of cases) {
    sends.length = 0;
    const { emitted, emitLifecycleEvent } = emitRecorder();
    const result = await deliverInvoiceToCustomer(fakeSupabase(world(overrides)), "org-1", "inv-1", context as typeof CONTEXT, { emitLifecycleEvent });
    assert.deepEqual(result, { ok: false, error: DELIVERY_BLOCK_MESSAGE[reason] }, reason);
    assert.deepEqual([sends.length, emitted.length], [0, 0]);
  }
});

test("no Stripe Connect: the invoice is still delivered, linking to the invoice to view - never offering card payment - and the payment link itself stays unavailable", async () => {
  const noConnect: [string, Row][] = [
    ["never connected", { ...ORG, stripe_connect_account_id: null, stripe_connect_charges_enabled: false, stripe_connect_payouts_enabled: false, stripe_connect_details_submitted: false }],
    ["onboarding incomplete (charges disabled)", { ...ORG, stripe_connect_charges_enabled: false }],
  ];
  for (const [name, org] of noConnect) {
    sends.length = 0;
    const { emitted, emitLifecycleEvent } = emitRecorder();
    const w = world({ organizations: [org] });
    const result = await deliverInvoiceToCustomer(fakeSupabase(w), "org-1", "inv-1", CONTEXT, { emitLifecycleEvent, now: () => new Date("2026-10-09T12:00:00Z") });
    assert.deepEqual(result, { ok: true, deliveredAt: "2026-10-09T12:00:00.000Z" }, name);
    assert.equal(sends.length, 1, name);
    assert.equal(sends[0].body, `Acme Roofing: Invoice INV-000123 for $450 is ready. It's due Oct 19, 2026. View it here: ${BASE_URL}/pay/${TOKEN} Reply STOP to opt out.`, name);
    assert.doesNotMatch(sends[0].body, /Pay securely|pay by card|payment link/i, `${name}: never claims online payment`);
    assert.equal(emitted.length, 1, `${name}: the delivery is recorded`);
    // The page says what will be sent; the copy-payment-link rule is unchanged (still not_accepting).
    assert.deepEqual(await getInvoiceDeliveryState(fakeSupabase(w), "org-1", "inv-1", CONTEXT), { blockedReason: null, maskedPhone: "•••• 0123", lastDeliveredAt: null, cardPayment: false }, name);
    const { describePaymentLink } = await import(lib("lib/payments/payment-link.ts"));
    assert.deepEqual(describePaymentLink({ invoiceStatus: "sent", token: TOKEN, paymentStatus: "active", connect: { accountId: org.stripe_connect_account_id as string | null, chargesEnabled: false }, baseUrl: BASE_URL }), { kind: "not_accepting" }, `${name}: no payment link without Stripe`);
  }
});

test("a failed or blocked send (e.g. opt-out raced in, provider error) records no invoice.delivered, and the error never carries the provider text, phone or token", async () => {
  sendResult = { ok: false, error: `The 'To' number ${PHONE} is not valid`, messageId: "msg-x", conversationId: "conv-1" };
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const { emitted, emitLifecycleEvent } = emitRecorder();
    const result = await deliverInvoiceToCustomer(fakeSupabase(world()), "org-1", "inv-1", CONTEXT, { emitLifecycleEvent });
    assert.deepEqual(result, { ok: false, error: "The text couldn't be sent. Please try again." });
    assert.equal(emitted.length, 0);
    const text = JSON.stringify(logged);
    for (const secret of [PHONE, TOKEN, "/pay/"]) assert.ok(!text.includes(secret), secret);
  } finally {
    console.error = original;
  }
});

test("failure diagnostics: the server log names an actionable cause (and provider code) - the contractor still sees the generic error, and no phone, token, link or provider text is logged", async () => {
  const cases: [typeof sendResult, string, string | null][] = [
    [{ ok: false, error: "SMS delivery is not configured for this environment.", messageId: "msg-1", conversationId: "conv-1", providerUnconfigured: true }, "sms_not_configured", null],
    [{ ok: false, error: `The SMS provider rejected the request. To ${PHONE}`, messageId: "msg-2", conversationId: "conv-1", providerErrorCode: "21608" }, "provider_rejected", "21608"],
    [{ ok: false, error: "The destination phone number is not a valid E.164 number.", messageId: "msg-3", conversationId: "conv-1" }, "send_failed", null],
    [{ ok: false, error: "Could not record the outbound message.", messageId: null, conversationId: "conv-1" }, "not_recorded", null],
  ];
  const original = console.error;
  try {
    for (const [result, cause, code] of cases) {
      sendResult = result;
      const logged: unknown[][] = [];
      console.error = (...args: unknown[]) => void logged.push(args);
      const { emitted, emitLifecycleEvent } = emitRecorder();
      const outcome = await deliverInvoiceToCustomer(fakeSupabase(world()), "org-1", "inv-1", CONTEXT, { emitLifecycleEvent });
      assert.deepEqual(outcome, { ok: false, error: "The text couldn't be sent. Please try again." }, cause);
      assert.equal(emitted.length, 0, cause);
      assert.deepEqual(logged, [["[invoices] Send to customer failed", { organizationId: "org-1", invoiceId: "inv-1", messageId: (result as { messageId: string | null }).messageId, cause, providerErrorCode: code }]], cause);
      const text = JSON.stringify(logged);
      for (const secret of [PHONE, TOKEN, "/pay/", "rejected the request", "View it here", "Pay securely"]) assert.ok(!text.includes(secret), `${cause}: ${secret}`);
    }
  } finally {
    console.error = original;
  }
  assert.equal(deliveryFailureCause({ ok: false, error: "x", messageId: "m", conversationId: "c", recipientOptedOut: true }), "recipient_opted_out");
});

test("simulated send: the same checks and message, passed to the outbound path as simulate - no invoice.delivered, and the result says simulated", async () => {
  sendResult = { ok: true, messageId: "msg-sim", conversationId: "conv-1", providerMessageId: "sim_x", simulated: true };
  const { emitted, emitLifecycleEvent } = emitRecorder();
  const simulationEnv = { VERCEL_ENV: "preview" };
  const result = await deliverInvoiceToCustomer(fakeSupabase(world()), "org-1", "inv-1", { ...CONTEXT, simulate: true }, { emitLifecycleEvent, simulationEnv: simulationEnv as unknown as NodeJS.ProcessEnv, now: () => new Date("2026-10-09T12:00:00Z") });
  assert.deepEqual(result, { ok: true, deliveredAt: "2026-10-09T12:00:00.000Z", simulated: true });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].simulate, true);
  assert.equal(sends[0].simulationEnv, simulationEnv);
  assert.equal(sends[0].body, `Acme Roofing: Invoice INV-000123 for $450 is ready. It's due Oct 19, 2026. Pay securely: ${BASE_URL}/pay/${TOKEN} Reply STOP to opt out.`, "the exact message a real send would use");
  assert.equal(emitted.length, 0, "a simulation is never recorded as a delivery");
});

test("simulated send keeps every safeguard: opt-out, inactive subscription, wrong status and another organization's invoice still block before anything is recorded", async () => {
  sendResult = { ok: true, messageId: "msg-sim", conversationId: "conv-1", providerMessageId: "sim_x", simulated: true };
  const cases: [Partial<World>, Record<string, unknown>, keyof typeof DELIVERY_BLOCK_MESSAGE][] = [
    [{ contacts: [{ ...CONTACT, sms_opt_out: true }] }, {}, "opted_out"],
    [{}, { paymentStatus: "suspended" }, "subscription_inactive"],
    [{ invoices: [{ ...INVOICE, status: "draft" }] }, {}, "status_ineligible"],
    [{ invoices: [{ ...INVOICE, organization_id: "org-2" }] }, {}, "not_found"],
  ];
  for (const [overrides, context, reason] of cases) {
    sends.length = 0;
    const { emitted, emitLifecycleEvent } = emitRecorder();
    const result = await deliverInvoiceToCustomer(fakeSupabase(world(overrides)), "org-1", "inv-1", { ...CONTEXT, ...context, simulate: true }, { emitLifecycleEvent });
    assert.deepEqual(result, { ok: false, error: DELIVERY_BLOCK_MESSAGE[reason] }, reason);
    assert.deepEqual([sends.length, emitted.length], [0, 0], reason);
  }
});

test("a normal send never asks for simulation", async () => {
  const { emitLifecycleEvent } = emitRecorder();
  await deliverInvoiceToCustomer(fakeSupabase(world()), "org-1", "inv-1", CONTEXT, { emitLifecycleEvent });
  assert.equal(sends.length, 1);
  assert.equal("simulate" in sends[0], false);
});

test("structure: the simulate action refuses outside a simulation environment before reading anything, and the UI offers it only when the page says it's available", () => {
  const action = fs.readFileSync(path.join(process.cwd(), "app/(app)/invoices/actions.ts"), "utf8");
  const body = action.slice(action.indexOf("export async function simulateInvoiceSendToCustomer"));
  assert.ok(body.indexOf("if (!canSimulateSmsDelivery())") < body.indexOf("await requireOrganization()"), "the environment guard runs first");
  assert.match(body, /await requireOrganization\(\);/, "still the signed-in member's own session and organization");
  assert.match(body, /simulate: true \}\);/);
  assert.doesNotMatch(action, /createServiceRoleClient/);
  const ui = fs.readFileSync(path.join(process.cwd(), "app/(app)/invoices/[id]/_components/invoice-actions.tsx"), "utf8");
  assert.match(ui, /\{delivery\.simulationAvailable \? \(\s*<button[\s\S]{0,120}?onClick=\{\(\) => run\(\(\) => simulateInvoiceSendToCustomer\(invoice\.id\)\)\}/);
  assert.match(ui, /"Simulate send \(no SMS\)"/);
  assert.match(ui, /Simulated send: no SMS was delivered and the customer was not contacted\./);
  const page = fs.readFileSync(path.join(process.cwd(), "app/(app)/invoices/[id]/page.tsx"), "utf8");
  assert.match(page, /simulationAvailable: canSimulateSmsDelivery\(\),/);
});

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

test("page state: sendable shows the masked number and the latest successful delivery; blocked shows the reason", async () => {
  const w = world({ events: [
    { organization_id: "org-1", event_type: "invoice.delivered", entity_type: "invoice", entity_id: "inv-1", created_at: "2026-10-05T10:00:00Z" },
    { organization_id: "org-1", event_type: "invoice.delivered", entity_type: "invoice", entity_id: "inv-1", created_at: "2026-10-08T10:00:00Z" },
    { organization_id: "org-2", event_type: "invoice.delivered", entity_type: "invoice", entity_id: "inv-1", created_at: "2026-10-09T10:00:00Z" },
  ] });
  assert.deepEqual(await getInvoiceDeliveryState(fakeSupabase(w), "org-1", "inv-1", CONTEXT), { blockedReason: null, maskedPhone: "•••• 0123", lastDeliveredAt: "2026-10-08T10:00:00Z", cardPayment: true });
  const blocked = await getInvoiceDeliveryState(fakeSupabase(world({ contacts: [{ ...CONTACT, sms_opt_out: true }] })), "org-1", "inv-1", CONTEXT);
  assert.deepEqual(blocked, { blockedReason: "opted_out", maskedPhone: null, lastDeliveredAt: null, cardPayment: null });
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("structure: the delivery module uses sendOutboundMessage only - no raw SMS sender, Twilio, n8n or outbound-gate bypass - and the action uses the session", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/invoices/delivery.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(code, /sendOutboundMessage\(supabase, \{/);
  assert.doesNotMatch(code, /sendSms\(|twilio|n8n|createServiceRoleClient/i);
  assert.doesNotMatch(code, /console\.(error|log|warn)\([^)]*(paymentUrl|payment_token|body)/, "never logs the link, token or message");
  const action = fs.readFileSync(path.join(process.cwd(), "app/(app)/invoices/actions.ts"), "utf8");
  assert.match(action, /export async function sendInvoiceToCustomer\(invoiceId: string\)/);
  assert.match(action.slice(action.indexOf("export async function sendInvoiceToCustomer")), /await requireOrganization\(\);/);
  assert.doesNotMatch(action, /createServiceRoleClient/);
});

test("UI: Send to customer / Send again behind a confirmation dialog, disabled with the reason when blocked", () => {
  const ui = fs.readFileSync(path.join(process.cwd(), "app/(app)/invoices/[id]/_components/invoice-actions.tsx"), "utf8");
  assert.match(ui, /\{isResend \? "Send again" : "Send to customer"\}/);
  assert.match(ui, /disabled=\{isPending \|\| sendBlocked !== null\}/);
  assert.match(ui, /dialog === "send" && delivery/);
  assert.match(ui, /run\(\(\) => sendInvoiceToCustomer\(invoice\.id\)\)/);
  assert.match(ui, /Last sent to customer \{delivery\.lastDeliveredLabel\}/);
  // The confirmation says what the text links to: card payment only when it's available.
  assert.match(ui, /delivery\.cardPayment \? "a secure payment link" : "a link to view the invoice/);
  assert.match(fs.readFileSync(path.join(process.cwd(), "app/(app)/invoices/[id]/page.tsx"), "utf8"), /cardPayment: deliveryState\.cardPayment === true/);
});
