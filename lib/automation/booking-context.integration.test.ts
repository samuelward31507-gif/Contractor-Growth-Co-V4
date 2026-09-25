/**
 * Pass 1 hardening follow-up: a focused integration test for
 * getRecentBookingContext's organization_id defense-in-depth filter
 * (lib/automation/booking-context.ts). Writes a real completed
 * check_availability offer under one organization, directly (no need for
 * booking_settings/business_hours fixtures, since this test only exercises
 * the read path, not slot computation), then proves a lookup scoped to a
 * DIFFERENT organization id can never read it back - even though the
 * conversation_id itself is reused across both lookups, and even though the
 * outer automation_events query was already organization-scoped before this
 * filter was added.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/booking-context.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));

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

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { findOrCreateOpenConversation }: typeof import("@/lib/conversations/queries") = require(path.join(REPO_ROOT, "lib/conversations/queries.ts"));
const { createAutomationEventAsService }: typeof import("./events") = require(path.join(REPO_ROOT, "lib/automation/events.ts"));
const { startWorkflowExecutionAsService, completeWorkflowExecutionAsService }: typeof import("./executions") = require(path.join(REPO_ROOT, "lib/automation/executions.ts"));
const { getRecentBookingContext }: typeof import("./booking-context") = require(path.join(REPO_ROOT, "lib/automation/booking-context.ts"));

const service = createServiceRoleClient();

let organizationId: string;
let otherOrgId: string;
let contactId: string;
let conversationId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Booking Context Isolation Test Org", payment_status: "active", automation_mode: "live", timezone: "UTC" }).select("id").single();
  organizationId = org!.id;
  const { data: other } = await service.from("organizations").insert({ name: "Booking Context Isolation Test Org (Other)", payment_status: "active", automation_mode: "live" }).select("id").single();
  otherOrgId = other!.id;

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: "+15555730001" }).select("id").single();
  contactId = contact!.id;
  const conversation = await findOrCreateOpenConversation(service, organizationId, contactId, "sms");
  conversationId = conversation!.id;

  // A real completed check_availability offer, written the same way
  // route.ts's own check_availability branch writes one - directly, rather
  // than through the full POST() callback, since this test only exercises
  // getRecentBookingContext's read path.
  const eventResult = await createAutomationEventAsService(service, organizationId, {
    eventType: "customer.message.received",
    entityType: "conversation",
    entityId: conversationId,
    payload: { conversation_id: conversationId, contact_id: contactId },
    idempotencyKey: `test:booking-context-isolation:${conversationId}`,
  });
  if (!eventResult.ok || eventResult.duplicate || eventResult.skipped) throw new Error("failed to create fixture automation event");
  const executionResult = await startWorkflowExecutionAsService(service, eventResult.event.id, "customer_reply_followup");
  if (!executionResult.ok) throw new Error("failed to start fixture workflow execution");
  await completeWorkflowExecutionAsService(service, executionResult.execution.id, {
    should_send: false,
    booking_action: "check_availability",
    availability_status: "available",
    offered_slots: [{ start_at: "2027-04-01T09:00:00.000Z", end_at: "2027-04-01T10:00:00.000Z" }],
    offered_title: "Consult",
    reschedule_appointment_id: null,
  });
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("getRecentBookingContext: a real offer is found when scoped to the organization that owns it (positive control)", async () => {
  const context = await getRecentBookingContext(service, organizationId, conversationId);
  assert.ok(context, "expected the real offer to be found");
  assert.equal(context?.type, "offer");
});

test("getRecentBookingContext: the exact same conversation_id, looked up under a DIFFERENT organization_id, returns null - the offer must never leak cross-tenant", async () => {
  const context = await getRecentBookingContext(service, otherOrgId, conversationId);
  assert.equal(context, null, "a workflow_executions row belonging to a different organization must never be returned");
});
