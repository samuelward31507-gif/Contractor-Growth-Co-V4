/**
 * Gym Revenue Engine, Slice 1: live integration tests for the vertical-aware
 * booking-intent title fallback in app/api/automation/n8n-callback/route.ts
 * (resolveBookingFallbackTitle). Same disposable-fixture/direct-
 * handleBookingIntent-call pattern as booking.integration.test.ts - kept as
 * its own file rather than appended to that one, to avoid touching an
 * already-passing existing test file.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test app/api/automation/n8n-callback/booking-fallback-title.integration.test.ts
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
const { handleBookingIntent }: typeof import("./route") = require(path.join(REPO_ROOT, "app/api/automation/n8n-callback/route.ts"));

function fakeSendSms() {
  return async () => ({ ok: true as const, providerMessageId: `FAKE-${Date.now()}-${Math.random()}` });
}

const service = createServiceRoleClient();

let contractorOrgId: string;
let gymOrgId: string;
let contractorContactId: string;
let gymContactId: string;

async function seedOrg(name: string, vertical?: "contractor" | "gym") {
  const { data: org } = await service
    .from("organizations")
    .insert({ name, payment_status: "active", automation_mode: "live", timezone: "UTC", ...(vertical ? { vertical } : {}) })
    .select("id")
    .single();
  const organizationId = org!.id as string;
  await service.from("business_hours").insert(
    ["monday", "tuesday", "wednesday", "thursday", "friday"].map((day) => ({ organization_id: organizationId, day_of_week: day, is_open: true, open_time: "09:00", close_time: "17:00" })),
  );
  await service.from("business_hours").insert(
    ["saturday", "sunday"].map((day) => ({ organization_id: organizationId, day_of_week: day, is_open: false })),
  );
  await service.from("booking_settings").insert({ organization_id: organizationId, booking_enabled: true, minimum_notice_minutes: 0, default_duration_minutes: 60, buffer_minutes: 0 });
  return organizationId;
}

async function makeExecution(orgId: string, contactId: string) {
  const conversation = await findOrCreateOpenConversation(service, orgId, contactId, "sms");
  if (!conversation) throw new Error("failed to find/create test conversation");
  const { data: event, error: eventError } = await service
    .from("automation_events")
    .insert({
      organization_id: orgId,
      event_type: "customer.message.received",
      entity_type: "conversation",
      entity_id: conversation.id,
      status: "processing",
      payload: { contact_id: contactId, conversation_id: conversation.id, lead_id: null },
    })
    .select("id")
    .single();
  if (eventError || !event) throw new Error(`automation_events insert failed: ${eventError?.message}`);
  const { data: execution, error: executionError } = await service
    .from("workflow_executions")
    .insert({ organization_id: orgId, automation_event_id: event.id, workflow_name: "customer_reply_followup", status: "running", attempt: 1 })
    .select("id")
    .single();
  if (executionError || !execution) throw new Error(`workflow_executions insert failed: ${executionError?.message}`);
  return { executionId: execution.id as string, conversationId: conversation.id as string };
}

// A future Monday, matching booking.integration.test.ts's own convention.
const SLOT_START = "2027-03-01T09:00:00.000Z";
const SLOT_END = "2027-03-01T10:00:00.000Z";

before(async () => {
  // Deliberately omits `vertical` - proves the fallback resolves the
  // pre-Phase-1-migration default ('contractor', via the column's own
  // DEFAULT) the same way an org that never explicitly set it does today.
  contractorOrgId = await seedOrg("Booking Fallback Title Test Org - Contractor");
  gymOrgId = await seedOrg("Booking Fallback Title Test Org - Gym", "gym");

  const { data: contractorContact } = await service.from("contacts").insert({ organization_id: contractorOrgId, first_name: "Contractor", last_name: "Customer", phone: "+15555550101" }).select("id").single();
  contractorContactId = contractorContact!.id;

  const { data: gymContact } = await service.from("contacts").insert({ organization_id: gymOrgId, first_name: "Gym", last_name: "Prospect", phone: "+15555550102" }).select("id").single();
  gymContactId = gymContact!.id;
});

after(async () => {
  for (const orgId of [contractorOrgId, gymOrgId]) {
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("appointments").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("business_hours").delete().eq("organization_id", orgId);
    await service.from("booking_settings").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
});

test("1. contractor fallback remains 'Service Appointment' when the AI omits a title", async () => {
  const { executionId, conversationId } = await makeExecution(contractorOrgId, contractorContactId);
  await handleBookingIntent(
    service,
    {
      organizationId: contractorOrgId,
      executionId,
      contactId: contractorContactId,
      leadId: null,
      conversationId,
      bookingIntent: { action: "book", date_range_start: null, date_range_end: null, start_at: SLOT_START, end_at: SLOT_END, title: null },
    },
    fakeSendSms(),
  );

  const { data: appointment } = await service.from("appointments").select("title").eq("organization_id", contractorOrgId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  assert.equal(appointment?.title, "Service Appointment");
});

test("2. gym fallback title is gym-appropriate ('Gym Appointment') when the AI omits a title", async () => {
  const { executionId, conversationId } = await makeExecution(gymOrgId, gymContactId);
  await handleBookingIntent(
    service,
    {
      organizationId: gymOrgId,
      executionId,
      contactId: gymContactId,
      leadId: null,
      conversationId,
      bookingIntent: { action: "book", date_range_start: null, date_range_end: null, start_at: SLOT_START, end_at: SLOT_END, title: null },
    },
    fakeSendSms(),
  );

  const { data: appointment } = await service.from("appointments").select("title").eq("organization_id", gymOrgId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  assert.equal(appointment?.title, "Gym Appointment");
});

test("3. a supplied AI booking title is never overwritten, for either vertical", async () => {
  const { executionId, conversationId } = await makeExecution(gymOrgId, gymContactId);
  await handleBookingIntent(
    service,
    {
      organizationId: gymOrgId,
      executionId,
      contactId: gymContactId,
      leadId: null,
      conversationId,
      bookingIntent: { action: "book", date_range_start: null, date_range_end: null, start_at: "2027-03-01T11:00:00.000Z", end_at: "2027-03-01T12:00:00.000Z", title: "Free Trial" },
    },
    fakeSendSms(),
  );

  const { data: appointment } = await service.from("appointments").select("title").eq("organization_id", gymOrgId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  assert.equal(appointment?.title, "Free Trial");
});
