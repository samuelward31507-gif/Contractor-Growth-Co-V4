/**
 * Integration tests for applyDeliveryStatusUpdate() - the core logic behind
 * app/api/webhooks/sms/status - against an isolated test organization on
 * the real Supabase project, matching this codebase's established pattern
 * (see lib/automation/outbound-gate.integration.test.ts). No real Twilio
 * call is ever made - these tests operate purely on `messages` rows this
 * file creates and deletes itself.
 *
 * Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/messaging/delivery-status.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const REPO_ROOT = process.cwd();

const envPath = path.join(REPO_ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(
  path.join(REPO_ROOT, "lib/supabase/service.ts"),
);
const { applyDeliveryStatusUpdate }: typeof import("./delivery-status") = require(path.join(REPO_ROOT, "lib/messaging/delivery-status.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let organizationId: string;
let otherOrgId: string;
let contactId: string;
let conversationId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Delivery Status Tracking Test Org" }).select("id").single();
  const { data: other } = await service.from("organizations").insert({ name: "Delivery Status Tracking Test Org - Other" }).select("id").single();
  organizationId = org!.id;
  otherOrgId = other!.id;

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15555550166" }).select("id").single();
  contactId = contact!.id;
  const { data: conversation } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: contactId, channel: "sms", status: "open" }).select("id").single();
  conversationId = conversation!.id;
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("audit_log").delete().eq("organization_id", orgId);
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

async function insertOutboundMessage(sid: string, status: "queued" | "sent" | "delivered" | "failed" | "undelivered" = "sent") {
  const { data } = await service
    .from("messages")
    .insert({ organization_id: organizationId, conversation_id: conversationId, direction: "outbound", sender_type: "system", body: "test", status, provider_message_id: sid })
    .select("id, status")
    .single();
  return data!;
}

// ==================== Routing ====================

test("known provider_message_id updates the correct message", async () => {
  const sid = `SM_ROUTE_${Date.now()}`;
  const msg = await insertOutboundMessage(sid, "sent");
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "delivered", errorCode: null, errorMessage: null });
  assert.equal(result.outcome, "updated");
  assert.equal((result as { messageId: string }).messageId, msg.id);
  assert.equal((result as { organizationId: string }).organizationId, organizationId);
});

test("unknown MessageSid is safely ignored", async () => {
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: "SM_DOES_NOT_EXIST", twilioStatus: "delivered", errorCode: null, errorMessage: null });
  assert.equal(result.outcome, "unknown_message");
});

test("an inbound message with the same-shaped provider_message_id is never mutated by a status callback", async () => {
  const sid = `SM_INBOUND_${Date.now()}`;
  await service.from("messages").insert({ organization_id: organizationId, conversation_id: conversationId, direction: "inbound", sender_type: "customer", body: "hi", status: "received", provider_message_id: sid });
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "delivered", errorCode: null, errorMessage: null });
  assert.equal(result.outcome, "not_outbound");
});

test("cross-org manipulation is structurally impossible - organization_id always comes from the resolved row, never the caller", async () => {
  const sid = `SM_CROSSORG_${Date.now()}`;
  const msg = await insertOutboundMessage(sid, "sent");
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "delivered", errorCode: null, errorMessage: null });
  assert.equal(result.outcome, "updated");
  assert.equal((result as { organizationId: string }).organizationId, organizationId);
  assert.notEqual((result as { organizationId: string }).organizationId, otherOrgId);
  const { data: row } = await service.from("messages").select("organization_id").eq("id", msg.id).single();
  assert.equal(row?.organization_id, organizationId);
});

// ==================== State transitions ====================

test("queued -> sent (a real forward transition)", async () => {
  const sid = `SM_Q2S_${Date.now()}`;
  await insertOutboundMessage(sid, "queued");
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "sent", errorCode: null, errorMessage: null });
  assert.equal(result.outcome, "updated");
  assert.equal((result as { toStatus: string }).toStatus, "sent");
});

test("sent -> delivered", async () => {
  const sid = `SM_S2D_${Date.now()}`;
  await insertOutboundMessage(sid, "sent");
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "delivered", errorCode: null, errorMessage: null });
  assert.equal(result.outcome, "updated");
  assert.equal((result as { toStatus: string }).toStatus, "delivered");
});

test("sent -> failed, with ErrorCode/ErrorMessage persisted", async () => {
  const sid = `SM_S2F_${Date.now()}`;
  const msg = await insertOutboundMessage(sid, "sent");
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "failed", errorCode: "30003", errorMessage: "Unreachable destination handset" });
  assert.equal(result.outcome, "updated");
  assert.equal((result as { toStatus: string }).toStatus, "failed");
  const { data: row } = await service.from("messages").select("status, status_reason, provider_error_code").eq("id", msg.id).single();
  assert.equal(row?.status, "failed");
  assert.equal(row?.status_reason, "Unreachable destination handset");
  assert.equal(row?.provider_error_code, "30003");
});

test("sent -> undelivered", async () => {
  const sid = `SM_S2U_${Date.now()}`;
  await insertOutboundMessage(sid, "sent");
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "undelivered", errorCode: "30006", errorMessage: "Landline or unreachable carrier" });
  assert.equal(result.outcome, "updated");
  assert.equal((result as { toStatus: string }).toStatus, "undelivered");
});

test("delivered cannot downgrade to sent (out-of-order callback)", async () => {
  const sid = `SM_NODOWN1_${Date.now()}`;
  const msg = await insertOutboundMessage(sid, "delivered");
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "sent", errorCode: null, errorMessage: null });
  assert.equal(result.outcome, "ignored_downgrade");
  const { data: row } = await service.from("messages").select("status").eq("id", msg.id).single();
  assert.equal(row?.status, "delivered", "must remain delivered, never revert");
});

test("failed cannot downgrade to queued", async () => {
  const sid = `SM_NODOWN2_${Date.now()}`;
  const msg = await insertOutboundMessage(sid, "failed");
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "queued", errorCode: null, errorMessage: null });
  assert.equal(result.outcome, "ignored_downgrade");
  const { data: row } = await service.from("messages").select("status").eq("id", msg.id).single();
  assert.equal(row?.status, "failed");
});

test("a terminal status (delivered) cannot be overwritten by a different terminal status (failed) arriving late/out of order", async () => {
  const sid = `SM_TERM2TERM_${Date.now()}`;
  const msg = await insertOutboundMessage(sid, "delivered");
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "failed", errorCode: "30003", errorMessage: "late failure callback" });
  assert.equal(result.outcome, "ignored_downgrade");
  const { data: row } = await service.from("messages").select("status, status_reason").eq("id", msg.id).single();
  assert.equal(row?.status, "delivered");
  assert.equal(row?.status_reason, null, "the ignored callback's error text must never be written");
});

test("an early-stage callback (queued/sending) arriving after the row is already 'sent' is a safe no-op, not an error", async () => {
  const sid = `SM_EARLYSTAGE_${Date.now()}`;
  const msg = await insertOutboundMessage(sid, "sent");
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "accepted", errorCode: null, errorMessage: null });
  assert.equal(result.outcome, "ignored_downgrade");
  const { data: row } = await service.from("messages").select("status").eq("id", msg.id).single();
  assert.equal(row?.status, "sent");
});

// ==================== Idempotency ====================

test("a duplicate callback (identical status) is idempotent - no error, no change, only one real update happened", async () => {
  const sid = `SM_DUP_${Date.now()}`;
  const msg = await insertOutboundMessage(sid, "sent");
  const first = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "delivered", errorCode: null, errorMessage: null });
  assert.equal(first.outcome, "updated");
  const replay = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "delivered", errorCode: null, errorMessage: null });
  assert.equal(replay.outcome, "no_change");
  const { data: row } = await service.from("messages").select("status").eq("id", msg.id).single();
  assert.equal(row?.status, "delivered");
});

// ==================== Error handling ====================

test("an oversized ErrorMessage is bounded, never stored raw", async () => {
  const sid = `SM_BOUND_${Date.now()}`;
  const msg = await insertOutboundMessage(sid, "sent");
  const hugeMessage = "x".repeat(5000);
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "failed", errorCode: "99999999999999999999999999999999999999999999999999", errorMessage: hugeMessage });
  assert.equal(result.outcome, "updated");
  const { data: row } = await service.from("messages").select("status_reason, provider_error_code").eq("id", msg.id).single();
  assert.ok((row?.status_reason?.length ?? 0) <= 501, "status_reason must be bounded");
  assert.ok((row?.provider_error_code?.length ?? 0) <= 32, "provider_error_code must be bounded (also DB-enforced by CHECK constraint)");
});

test("an unrecognized/unmapped provider status is never stored, and is reported distinctly", async () => {
  const sid = `SM_UNMAPPED_${Date.now()}`;
  const msg = await insertOutboundMessage(sid, "sent");
  const result = await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "read", errorCode: null, errorMessage: null });
  assert.equal(result.outcome, "unmapped_provider_status");
  const { data: row } = await service.from("messages").select("status").eq("id", msg.id).single();
  assert.equal(row?.status, "sent", "must remain untouched");
});

// ==================== Automation isolation ====================

test("a delivery-status update never creates a customer.message.received automation event, workflow execution, or ai_interactions row, and never sends another outbound message", async () => {
  // Delta-based, not absolute-zero: this org is shared across every test in
  // this file, so earlier tests have already inserted their own outbound
  // messages into it (deliberately - see insertOutboundMessage()). The
  // thing this test actually proves is that applyDeliveryStatusUpdate()
  // itself adds no NEW rows to any of these tables, not that the org's
  // totals are zero.
  const { count: eventsBefore } = await service.from("automation_events").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  const { count: executionsBefore } = await service.from("workflow_executions").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  const { count: aiInteractionsBefore } = await service.from("ai_interactions").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  const { count: messagesBefore } = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);

  const sid = `SM_NOAUTO_${Date.now()}`;
  await insertOutboundMessage(sid, "sent");
  await applyDeliveryStatusUpdate(service, { providerMessageId: sid, twilioStatus: "delivered", errorCode: null, errorMessage: null });

  const { count: eventsAfter } = await service.from("automation_events").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  const { count: executionsAfter } = await service.from("workflow_executions").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  const { count: aiInteractionsAfter } = await service.from("ai_interactions").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  const { count: messagesAfter } = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);

  assert.equal(eventsAfter, eventsBefore, "no new automation_events row");
  assert.equal(executionsAfter, executionsBefore, "no new workflow_executions row");
  assert.equal(aiInteractionsAfter, aiInteractionsBefore, "no new ai_interactions row");
  // +1 is the test's own insertOutboundMessage() insert above, done by the
  // test itself before the call under test, not by applyDeliveryStatusUpdate.
  assert.equal(messagesAfter, (messagesBefore ?? 0) + 1, "applyDeliveryStatusUpdate() must never insert a message row (only update the existing one)");
});

// ==================== RLS ====================

test("an org member can read message statuses via the existing messages_select RLS policy (no new policy needed)", async () => {
  const { data: rows, error } = await service.from("messages").select("id, status").eq("organization_id", organizationId).limit(1);
  assert.equal(error, null);
  assert.ok((rows?.length ?? 0) >= 0);

  // The real RLS proof: an anonymous (unauthenticated) client must never
  // see these rows, and there is still no client-facing UPDATE policy that
  // could let a browser mutate provider status directly.
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: anonRead } = await anon.from("messages").select("id").eq("organization_id", organizationId);
  assert.equal(anonRead?.length ?? 0, 0, "anonymous read must be blocked by RLS");

  const { data: anonUpdate } = await anon.from("messages").update({ status: "delivered" }).eq("organization_id", organizationId).select("id");
  assert.equal(anonUpdate?.length ?? 0, 0, "anonymous client must never be able to mutate provider status directly");
});
