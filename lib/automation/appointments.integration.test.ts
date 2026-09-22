/**
 * Integration tests for the Growth System Completion Pass 1 additions to
 * lib/automation/appointments.ts: customer-facing, deterministic messages on
 * appointment cancellation and reschedule (Part 7). appointment.completed's
 * pre-existing lifecycle-only (no message) behavior is also re-verified here
 * as a regression guard.
 *
 * emitAppointmentLifecycleEvent uses the plain (non-service) event/execution
 * helpers throughout - exactly like app/(app)/appointments/actions.ts's own
 * real callers always have an authenticated session - so these tests sign in
 * a real throwaway member user (never the shared anon client, matching this
 * codebase's own established pattern - see lib/reviews-referrals/
 * tracking.integration.test.ts) rather than calling it with the service-role
 * client directly. Every send goes through the existing sendSmsFn injection
 * seam - no real Twilio call is ever made.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/appointments.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const { createClient: createSupabaseClient } = require("@supabase/supabase-js");

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
const { emitAppointmentLifecycleEvent }: typeof import("./appointments") = require(path.join(REPO_ROOT, "lib/automation/appointments.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function fakeSend() {
  return async () => ({ ok: true as const, providerMessageId: `FAKE-${Date.now()}-${Math.random()}` });
}

async function createTestUser(email: string, testUserIds: string[]) {
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`failed to create test user ${email}: ${error?.message}`);
  testUserIds.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function signInAs(email: string, password: string) {
  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return client;
}

let organizationId: string;
let otherOrgId: string;
let contactId: string;
let sessionSupabase: ReturnType<typeof createSupabaseClient>;
const testUserIds: string[] = [];
let slotHour = 9;

async function insertAppointment(status: "scheduled" | "confirmed" | "cancelled" = "scheduled") {
  const hour = slotHour++;
  const { data } = await service
    .from("appointments")
    .insert({
      organization_id: organizationId,
      contact_id: contactId,
      title: "AC Repair",
      start_at: `2027-01-04T${String(hour).padStart(2, "0")}:00:00.000Z`,
      end_at: `2027-01-04T${String(hour).padStart(2, "0")}:30:00.000Z`,
      status,
    })
    .select("id")
    .single();
  if (!data) throw new Error("failed to insert test appointment");
  return data.id as string;
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Appointment Lifecycle Message Test Org", automation_mode: "live", payment_status: "active", timezone: "UTC" }).select("id").single();
  organizationId = org!.id;
  const { data: other } = await service.from("organizations").insert({ name: "Appointment Lifecycle Message Test Org (Other)", automation_mode: "live", payment_status: "active" }).select("id").single();
  otherOrgId = other!.id;

  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Jane", last_name: "Doe", phone: "+15555550190" }).select("id").single();
  contactId = contact!.id;

  const stamp = Date.now();
  const memberUser = await createTestUser(`appt-lifecycle-${stamp}@example.com`, testUserIds);
  await service.from("organization_members").insert({ organization_id: organizationId, user_id: memberUser.id, role: "member" });
  sessionSupabase = await signInAs(memberUser.email, memberUser.password);
});

after(async () => {
  for (const orgId of [organizationId, otherOrgId]) {
    await service.from("messages").delete().eq("organization_id", orgId);
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("conversations").delete().eq("organization_id", orgId);
    await service.from("appointments").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("organization_members").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
});

test("1. a cancelled appointment sends a deterministic cancellation SMS through the real gate + send path", async () => {
  const appointmentId = await insertAppointment("scheduled");
  await service.from("appointments").update({ status: "cancelled" }).eq("id", appointmentId);

  await emitAppointmentLifecycleEvent(sessionSupabase, appointmentId, "appointment.cancelled", undefined, fakeSend());

  const { data: messages } = await service.from("messages").select("body, direction, status").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(1);
  assert.equal(messages?.length, 1);
  assert.equal(messages?.[0].direction, "outbound");
  assert.equal(messages?.[0].status, "sent");
  assert.match(messages?.[0].body ?? "", /cancelled/i);
});

test("2. a rescheduled appointment sends a deterministic reschedule SMS with the new date/time", async () => {
  const appointmentId = await insertAppointment("confirmed");
  const newStart = "2027-01-05T15:00:00.000Z";
  const newEnd = "2027-01-05T15:30:00.000Z";
  await service.from("appointments").update({ start_at: newStart, end_at: newEnd }).eq("id", appointmentId);
  const { data: updated } = await service.from("appointments").select("updated_at").eq("id", appointmentId).single();

  await emitAppointmentLifecycleEvent(sessionSupabase, appointmentId, "appointment.rescheduled", updated!.updated_at, fakeSend());

  const { data: messages } = await service.from("messages").select("body, direction, status").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(1);
  assert.equal(messages?.length, 1);
  assert.equal(messages?.[0].status, "sent");
  assert.match(messages?.[0].body ?? "", /moved to/i);
});

test("3. duplicate prevention: retrying the exact same cancellation event never sends a second message", async () => {
  const appointmentId = await insertAppointment("scheduled");
  await service.from("appointments").update({ status: "cancelled" }).eq("id", appointmentId);

  await emitAppointmentLifecycleEvent(sessionSupabase, appointmentId, "appointment.cancelled", undefined, fakeSend());
  const messagesAfterFirst = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);

  await emitAppointmentLifecycleEvent(sessionSupabase, appointmentId, "appointment.cancelled", undefined, fakeSend());
  const messagesAfterSecond = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);

  assert.equal(messagesAfterSecond.count, messagesAfterFirst.count, "a retried cancellation for the same appointment must never send a second message");

  const { data: events } = await service.from("automation_events").select("id").eq("organization_id", organizationId).eq("entity_id", appointmentId).eq("event_type", "appointment.cancelled");
  assert.equal(events?.length, 1, "a retried cancellation for the same appointment must resolve to the same automation_events row, not a second one");
});

test("4. appointment.completed remains lifecycle-only - no customer message is sent", async () => {
  const appointmentId = await insertAppointment("scheduled");
  await service.from("appointments").update({ status: "completed" }).eq("id", appointmentId);

  const before2 = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  await emitAppointmentLifecycleEvent(sessionSupabase, appointmentId, "appointment.completed", undefined, fakeSend());
  const after2 = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);

  assert.equal(after2.count, before2.count, "appointment.completed must never send a customer message");
});

test("5. an opted-out contact never receives a cancellation message - the gate's own opt-out check still applies to this deterministic send", async () => {
  const { data: optedOutContact } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Opted", last_name: "Out", phone: "+15555550191", sms_opt_out: true }).select("id").single();
  const { data: appt } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: optedOutContact!.id, title: "AC Repair", start_at: "2027-01-06T09:00:00.000Z", end_at: "2027-01-06T09:30:00.000Z", status: "cancelled" })
    .select("id")
    .single();

  const before2 = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
  await emitAppointmentLifecycleEvent(sessionSupabase, appt!.id, "appointment.cancelled", undefined, fakeSend());
  const after2 = await service.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);

  assert.equal(after2.count, before2.count, "an opted-out contact must never receive this message");
});

test("6. cross-org isolation: a cancellation event for organization A never touches organization B's data", async () => {
  const appointmentId = await insertAppointment("scheduled");
  await service.from("appointments").update({ status: "cancelled" }).eq("id", appointmentId);

  await emitAppointmentLifecycleEvent(sessionSupabase, appointmentId, "appointment.cancelled", undefined, fakeSend());

  const { data: otherOrgMessages } = await service.from("messages").select("id").eq("organization_id", otherOrgId);
  assert.equal(otherOrgMessages?.length, 0);
});
