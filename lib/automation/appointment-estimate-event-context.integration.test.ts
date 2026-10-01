/**
 * appointment.created, appointment.no_show, and estimate.sent store the send
 * context the n8n callback re-derives from - contact_id and the contact's
 * open SMS conversation - in the event payload itself (never lead_id).
 * Before this, the payload held only appointment_id/estimate_id, so every AI
 * confirmation was blocked with missing_contact_id.
 *
 * Runs only against the test Supabase project, with disposable orgs/users.
 * n8n is never reached: dispatch runs inside next/server's after(), which
 * throws outside a request scope here (tolerated, as in
 * no-show-detection.integration.test.ts), and N8N_BASE_URL is cleared. The
 * n8n step is simulated by POSTing its result to the real callback route.
 * No real SMS: the Twilio env vars are cleared, so the callback's send
 * attempt fails as "not configured" without a network call - the attempted
 * message row is what proves the gate let it through.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/appointment-estimate-event-context.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

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

const PRODUCTION_PROJECT_REF = "mywznmxtlgajnczjvbmk";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!SUPABASE_URL || SUPABASE_URL.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error("Refusing to run: appointment-estimate-event-context.integration.test.ts only runs against the test Supabase project, never production.");
}

delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.N8N_BASE_URL;

const require = createRequire(path.join(REPO_ROOT, "package.json"));
const { emitAppointmentCreated, emitAppointmentNoShow }: typeof import("./appointments") = require(path.join(REPO_ROOT, "lib/automation/appointments.ts"));
const { emitEstimateSent }: typeof import("./estimates") = require(path.join(REPO_ROOT, "lib/automation/estimates.ts"));
const { NextRequest } = require("next/server");
const { POST }: typeof import("@/app/api/automation/n8n-callback/route") = require(path.join(REPO_ROOT, "app/api/automation/n8n-callback/route.ts"));

const options = { auth: { autoRefreshToken: false, persistSession: false } };
const service = createSupabaseClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
const anon = createSupabaseClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, options);

let organizationId: string;
let userId: string;
let session: SupabaseClient;
let phoneCounter = 0;

/** after() throws outside a request scope in this harness - everything this test checks is committed before it. */
async function tolerateAfter(run: () => Promise<void>) {
  try {
    await run();
  } catch (e) {
    if (!String(e).includes("after` was called outside a request scope")) throw e;
  }
}

async function makeContact() {
  phoneCounter += 1;
  const phone = `+1555555${String(3000 + phoneCounter).padStart(4, "0")}`;
  const { data, error } = await service.from("contacts").insert({ organization_id: organizationId, first_name: "Context", last_name: `Test ${phoneCounter}`, phone, phone_normalized: phone }).select("id").single();
  if (error) throw error;
  return data!.id as string;
}

async function makeAppointment(contactId: string | null, status = "scheduled", leadId: string | null = null) {
  const start = new Date(Date.now() + (10 + phoneCounter) * 24 * 3600 * 1000);
  const { data, error } = await service
    .from("appointments")
    .insert({ organization_id: organizationId, contact_id: contactId, lead_id: leadId, title: "Context test visit", start_at: start.toISOString(), end_at: new Date(start.getTime() + 3600 * 1000).toISOString(), status })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

async function storedEvent(eventType: string, entityId: string) {
  const { data } = await service.from("automation_events").select("id, payload").eq("organization_id", organizationId).eq("event_type", eventType).eq("entity_id", entityId);
  return data ?? [];
}

async function openConversations(contactId: string) {
  const { data } = await service.from("conversations").select("id, lead_id").eq("organization_id", organizationId).eq("contact_id", contactId).eq("channel", "sms").eq("status", "open");
  return data ?? [];
}

/** Simulates n8n POSTing its AI result back for the execution started from this event. */
async function callback(eventId: string) {
  const { data: execution } = await service.from("workflow_executions").select("id").eq("automation_event_id", eventId).single();
  const response = await POST(
    new NextRequest("http://localhost/api/automation/n8n-callback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trackpr-webhook-secret": process.env.N8N_WEBHOOK_SECRET! },
      body: JSON.stringify({
        execution_id: execution!.id,
        event_id: eventId,
        organization_id: organizationId,
        ai_result: { should_send: true, response_message: "Thanks! We'll see you then. Reply here if anything changes.", qualification_status: "qualified", missing_information: [], urgency: "normal", needs_human: false, model: "test-model", intent: "confirmation", summary: "context test", booking_intent: null, usage: null },
      }),
    }),
  );
  const { count: messages } = await service.from("messages").select("id", { count: "exact", head: true }).eq("workflow_execution_id", execution!.id);
  return { json: await response.json(), messages: messages ?? 0 };
}

before(async () => {
  const { data: org, error } = await service.from("organizations").insert({ name: "Event Context Test Org", payment_status: "active", automation_mode: "live", timezone: "UTC" }).select("id").single();
  if (error) throw error;
  organizationId = org!.id;
  await service.from("ai_settings").insert({ organization_id: organizationId, ai_enabled: true });
  await service.from("business_hours").insert(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => ({ organization_id: organizationId, day_of_week: day, is_open: true, open_time: "00:00", close_time: "23:59" })));

  const email = `event-context-${Date.now()}@example.com`;
  const password = "a-real-test-password-123";
  const { data: user, error: userError } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw userError;
  userId = user.user!.id;
  await service.from("organization_members").insert({ organization_id: organizationId, user_id: userId, role: "owner" });
  const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  if (signInError || !signIn.session) throw signInError ?? new Error("no session");
  session = createSupabaseClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { ...options, global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } } });
});

after(async () => {
  for (const table of ["messages", "ai_interactions", "automation_incidents", "workflow_executions", "automation_events", "appointments", "estimates", "conversations", "leads", "contacts", "business_hours", "ai_settings"]) {
    await service.from(table).delete().eq("organization_id", organizationId);
  }
  await service.from("organizations").delete().eq("id", organizationId);
  if (userId) await service.auth.admin.deleteUser(userId);
});

test("1. appointment.created stores { appointment_id, contact_id, conversation_id } (no lead_id), and the callback is no longer blocked for missing context", async () => {
  const contactId = await makeContact();
  const appointmentId = await makeAppointment(contactId);
  await tolerateAfter(() => emitAppointmentCreated(session, appointmentId));

  const events = await storedEvent("appointment.created", appointmentId);
  assert.equal(events.length, 1);
  const conversations = await openConversations(contactId);
  assert.equal(conversations.length, 1);
  assert.deepEqual(events[0].payload, { appointment_id: appointmentId, contact_id: contactId, conversation_id: conversations[0].id });

  const { json, messages } = await callback(events[0].id);
  assert.notEqual(json.blockedReason, "missing_contact_id");
  assert.notEqual(json.blockedReason, "missing_conversation_id");
  assert.equal(json.blockedReason, undefined, JSON.stringify(json));
  assert.equal(messages, 1, "the gate allowed it and the send was attempted");
});

test("2. appointment.no_show (signed-in path) stores the same context, and the callback reaches the send", async () => {
  const contactId = await makeContact();
  const appointmentId = await makeAppointment(contactId, "no_show");
  await tolerateAfter(() => emitAppointmentNoShow(session, appointmentId));

  const events = await storedEvent("appointment.no_show", appointmentId);
  assert.equal(events.length, 1);
  const conversations = await openConversations(contactId);
  assert.deepEqual(events[0].payload, { appointment_id: appointmentId, contact_id: contactId, conversation_id: conversations[0].id });

  const { json, messages } = await callback(events[0].id);
  assert.equal(json.blockedReason, undefined, JSON.stringify(json));
  assert.equal(messages, 1);
});

test("3. estimate.sent stores { estimate_id, contact_id, conversation_id } (no lead_id), and the callback reaches the send", async () => {
  const contactId = await makeContact();
  const { data: estimate, error } = await service.from("estimates").insert({ organization_id: organizationId, contact_id: contactId, title: "Context test estimate", amount: 1200, status: "sent", sent_at: new Date().toISOString() }).select("id").single();
  if (error) throw error;
  await tolerateAfter(() => emitEstimateSent(session, estimate!.id));

  const events = await storedEvent("estimate.sent", estimate!.id);
  assert.equal(events.length, 1);
  const conversations = await openConversations(contactId);
  assert.deepEqual(events[0].payload, { estimate_id: estimate!.id, contact_id: contactId, conversation_id: conversations[0].id });

  const { json, messages } = await callback(events[0].id);
  assert.equal(json.blockedReason, undefined, JSON.stringify(json));
  assert.equal(messages, 1);
});

test("4. an appointment with no contact is unchanged: null context stored, the callback still blocks with missing_contact_id", async () => {
  const appointmentId = await makeAppointment(null);
  await tolerateAfter(() => emitAppointmentCreated(session, appointmentId));

  const events = await storedEvent("appointment.created", appointmentId);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, { appointment_id: appointmentId, contact_id: null, conversation_id: null });

  const { json, messages } = await callback(events[0].id);
  assert.equal(json.blockedReason, "missing_contact_id");
  assert.equal(messages, 0);
});

test("5. idempotency is preserved: emitting twice creates one event and one open conversation", async () => {
  const contactId = await makeContact();
  const appointmentId = await makeAppointment(contactId);
  await tolerateAfter(() => emitAppointmentCreated(session, appointmentId));
  await tolerateAfter(() => emitAppointmentCreated(session, appointmentId));

  assert.equal((await storedEvent("appointment.created", appointmentId)).length, 1);
  assert.equal((await openConversations(contactId)).length, 1);
});

test("6. an existing conversation whose lead_id differs from the appointment's is not blocked as lead_conversation_mismatch (lead_id is not stored)", async () => {
  const contactId = await makeContact();
  const { data: existing } = await service.from("conversations").insert({ organization_id: organizationId, contact_id: contactId, channel: "sms", status: "open", lead_id: null }).select("id").single();
  const { data: lead, error } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contactId, status: "new", source: "manual" }).select("id").single();
  if (error) throw error;
  const appointmentId = await makeAppointment(contactId, "scheduled", lead!.id);
  await tolerateAfter(() => emitAppointmentCreated(session, appointmentId));

  const events = await storedEvent("appointment.created", appointmentId);
  assert.deepEqual(events[0].payload, { appointment_id: appointmentId, contact_id: contactId, conversation_id: existing!.id }, "the existing open conversation is reused, not duplicated");

  const { json, messages } = await callback(events[0].id);
  assert.notEqual(json.blockedReason, "lead_conversation_mismatch");
  assert.equal(json.blockedReason, undefined, JSON.stringify(json));
  assert.equal(messages, 1);
});
