/**
 * Phase 1B-5: unit tests for lib/automation/invoices.ts - the internal
 * lifecycle markers for invoices and payments. A hand-built fake client
 * (auth + the three automation RPCs), no network: a stubbed global fetch
 * proves nothing is dispatched. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/invoices.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { emitInvoiceLifecycleEvent, emitInvoiceLifecycleEventAsService, invoiceLifecycleIdempotencyKey, INVOICE_LIFECYCLE_EVENT_TYPES }: typeof import("./invoices") = require("./invoices.ts");
const { getAutomationForEventType }: typeof import("./catalog") = require("./catalog.ts");

type Row = Record<string, unknown>;
type RpcCall = { fn: string; args: Row };

function makeFakeClient(options: { user?: { id: string } | null; duplicate?: boolean; failCreate?: boolean; throwOn?: string } = {}) {
  const rpcCalls: RpcCall[] = [];
  const user = options.user === undefined ? { id: "user-a" } : options.user;
  function respond(fn: string, args: Row) {
    if (options.throwOn === fn) throw new Error(`boom from ${fn}`);
    if (fn === "create_automation_event") {
      if (options.failCreate) return { data: null, error: { message: "rpc failed" } };
      return { data: { id: "evt-1", organization_id: "org-a", event_type: args.p_event_type, entity_type: args.p_entity_type, entity_id: args.p_entity_id, status: "pending", payload: args.p_payload, is_duplicate: Boolean(options.duplicate) }, error: null };
    }
    if (fn === "start_workflow_execution") return { data: { id: "exec-1", organization_id: "org-a", workflow_name: args.p_workflow_name, attempt: 1, status: "running" }, error: null };
    if (fn === "complete_workflow_execution") return { data: { id: "exec-1", organization_id: "org-a", workflow_name: "invoice_issued_lifecycle", attempt: 1, status: "completed" }, error: null };
    return { data: {}, error: null };
  }
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) builder[method] = () => builder;
  builder.maybeSingle = () => Promise.resolve({ data: null, error: null });
  const client = {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: () => builder,
    rpc: (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      const result = respond(fn, args);
      return { single: () => Promise.resolve(result), then: (resolve: (value: unknown) => void) => resolve(result) };
    },
  } as unknown as SupabaseClient;
  return { client, rpcCalls };
}

const ISSUED = { eventType: "invoice.issued" as const, invoiceId: "inv-1", payload: { invoice_id: "inv-1", number: 7, job_id: "job-1", contact_id: "contact-1", total: 1300.25, issued_at: "2026-10-01T15:00:00.000Z", due_date: "2026-10-15" } };

test("idempotency keys derive from the business fact: invoice id, invoice id + completing payment, or payment id", () => {
  assert.equal(invoiceLifecycleIdempotencyKey(ISSUED), "invoice.issued:inv-1");
  assert.equal(invoiceLifecycleIdempotencyKey({ eventType: "invoice.voided", invoiceId: "inv-1", payload: { invoice_id: "inv-1", number: 7, job_id: "job-1", contact_id: null, total: 10, previous_status: "sent" } }), "invoice.voided:inv-1");
  assert.equal(invoiceLifecycleIdempotencyKey({ eventType: "invoice.paid", invoiceId: "inv-1", completingPaymentId: "pay-9", payload: { invoice_id: "inv-1", number: 7, job_id: "job-1", contact_id: null, total: 10, amount_paid: 10, paid_at: null, completing_payment_id: "pay-9" } }), "invoice.paid:inv-1:pay-9");
  assert.equal(invoiceLifecycleIdempotencyKey({ eventType: "payment.recorded", paymentId: "pay-9", payload: { payment_id: "pay-9", invoice_id: "inv-1", number: 7, job_id: "job-1", contact_id: null, amount: 10, method: "cash", received_at: "2026-10-01T00:00:00.000Z", invoice_status_after: "paid", amount_paid_after: 10 } }), "payment.recorded:pay-9");
});

test("none of the four event types is claimed by a catalog automation, so they are never gated by an enable toggle or automation_paused, and never dispatched", () => {
  for (const eventType of INVOICE_LIFECYCLE_EVENT_TYPES) {
    assert.equal(getAutomationForEventType(eventType), null, eventType);
  }
});

test("the marker is created, started and completed as lifecycle_only through the session RPCs, with the payload verbatim and no fetch of any kind", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("no network allowed");
  }) as typeof fetch;
  try {
    const { client, rpcCalls } = makeFakeClient();
    await emitInvoiceLifecycleEvent(client, ISSUED);
    assert.deepEqual(rpcCalls.map((call) => call.fn), ["create_automation_event", "start_workflow_execution", "complete_workflow_execution", "resolve_automation_incidents_by_fingerprint"]);
    assert.deepEqual(rpcCalls[0].args, { p_event_type: "invoice.issued", p_entity_type: "invoice", p_entity_id: "inv-1", p_payload: ISSUED.payload, p_idempotency_key: "invoice.issued:inv-1" });
    assert.equal(rpcCalls[1].args.p_workflow_name, "invoice_issued_lifecycle");
    assert.deepEqual(rpcCalls[2].args.p_metadata, { lifecycle_only: true, invoice_id: "inv-1" });
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("payment.recorded is recorded against the customer_payment entity with payment_id in the completion metadata", async () => {
  const { client, rpcCalls } = makeFakeClient();
  await emitInvoiceLifecycleEvent(client, { eventType: "payment.recorded", paymentId: "pay-9", payload: { payment_id: "pay-9", invoice_id: "inv-1", number: 7, job_id: "job-1", contact_id: null, amount: 10, method: "cash", received_at: "2026-10-01T00:00:00.000Z", invoice_status_after: "paid", amount_paid_after: 10 } });
  assert.equal(rpcCalls[0].args.p_entity_type, "customer_payment");
  assert.equal(rpcCalls[0].args.p_entity_id, "pay-9");
  assert.equal(rpcCalls[1].args.p_workflow_name, "payment_recorded_lifecycle");
  assert.deepEqual(rpcCalls[2].args.p_metadata, { lifecycle_only: true, payment_id: "pay-9" });
});

test("a duplicate (same idempotency key already recorded) creates no execution", async () => {
  const { client, rpcCalls } = makeFakeClient({ duplicate: true });
  await emitInvoiceLifecycleEvent(client, ISSUED);
  assert.deepEqual(rpcCalls.map((call) => call.fn), ["create_automation_event"]);
});

test("no session, an RPC failure, or a thrown error never propagates - the ledger write is the source of truth", async () => {
  const noSession = makeFakeClient({ user: null });
  await assert.doesNotReject(() => emitInvoiceLifecycleEvent(noSession.client, ISSUED));
  assert.equal(noSession.rpcCalls.length, 0, "createAutomationEvent refuses without a user before any RPC");

  const failing = makeFakeClient({ failCreate: true });
  await assert.doesNotReject(() => emitInvoiceLifecycleEvent(failing.client, ISSUED));
  assert.deepEqual(failing.rpcCalls.map((call) => call.fn), ["create_automation_event"]);

  const throwing = makeFakeClient({ throwOn: "start_workflow_execution" });
  await assert.doesNotReject(() => emitInvoiceLifecycleEvent(throwing.client, ISSUED));
});

// ---------------------------------------------------------------------------
// Phase 1C: the service-role twin, used by the Stripe Connect webhook
// ---------------------------------------------------------------------------

const RECORDED_ONLINE = { eventType: "payment.recorded" as const, paymentId: "pay-online", payload: { payment_id: "pay-online", invoice_id: "inv-1", number: 7, job_id: "job-1", contact_id: null, amount: 1300.25, method: "card_online", received_at: "2026-10-05T12:00:00.000Z", invoice_status_after: "paid", amount_paid_after: 1300.25 } };

test("service variant: records the same event, key and payload WITHOUT a user session, passing the trusted organization id to the RPC", async () => {
  const { client, rpcCalls } = makeFakeClient({ user: null });
  await emitInvoiceLifecycleEventAsService(client, "org-a", RECORDED_ONLINE);
  // completeWorkflowExecutionAsService then runs its existing, shared
  // failure-resolution step (the same as every service-role lifecycle path).
  assert.deepEqual(rpcCalls.map((call) => call.fn), ["create_automation_event", "start_workflow_execution", "complete_workflow_execution", "resolve_automation_incidents_by_fingerprint"]);
  assert.equal(rpcCalls[0].args.p_organization_id, "org-a");
  assert.equal(rpcCalls[0].args.p_event_type, "payment.recorded");
  assert.equal(rpcCalls[0].args.p_idempotency_key, invoiceLifecycleIdempotencyKey(RECORDED_ONLINE));
  assert.deepEqual(rpcCalls[0].args.p_payload, RECORDED_ONLINE.payload);
  assert.equal(rpcCalls[1].args.p_workflow_name, "payment_recorded_lifecycle");
  assert.deepEqual(rpcCalls[2].args.p_metadata, { lifecycle_only: true, payment_id: "pay-online" });
});

test("service variant: a duplicate creates no execution, and failures never propagate", async () => {
  const duplicate = makeFakeClient({ user: null, duplicate: true });
  await emitInvoiceLifecycleEventAsService(duplicate.client, "org-a", ISSUED);
  assert.deepEqual(duplicate.rpcCalls.map((call) => call.fn), ["create_automation_event"]);

  const failing = makeFakeClient({ user: null, failCreate: true });
  await assert.doesNotReject(() => emitInvoiceLifecycleEventAsService(failing.client, "org-a", ISSUED));
  const throwing = makeFakeClient({ user: null, throwOn: "complete_workflow_execution" });
  await assert.doesNotReject(() => emitInvoiceLifecycleEventAsService(throwing.client, "org-a", ISSUED));
});
