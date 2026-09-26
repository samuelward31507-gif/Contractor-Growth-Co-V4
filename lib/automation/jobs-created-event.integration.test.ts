/**
 * Trackpr 2.0, n8n job-created payload fix: regression test for a confirmed
 * P1 defect found during a real production lifecycle test - emitJobCreatedEvent's
 * stored automation_events.payload only ever contained job_id/estimate_id,
 * never contact_id/lead_id/conversation_id, even for a job with a real,
 * valid contact. The n8n callback route (app/api/automation/n8n-callback/
 * route.ts) re-derives contactId/leadId/conversationId for the outbound
 * gate exclusively from this stored payload, never from the separate
 * contract object dispatched to n8n - so every job.created send was
 * unconditionally denied with missing_contact_id, for every organization,
 * every time. The identical defect class was already fixed for
 * job.post_followup (see lib/automation/post-job-followup.integration.test.ts) -
 * this proves the same fix for job.created.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/jobs-created-event.integration.test.ts
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
const { emitJobCreatedEvent }: typeof import("./jobs") = require(path.join(REPO_ROOT, "lib/automation/jobs.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

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
let sessionSupabase: ReturnType<typeof createSupabaseClient>;
const testUserIds: string[] = [];

/**
 * emitJobCreatedEvent's own n8n-dispatch call uses Next.js's after(), which
 * has no valid scope outside a real Next.js request - the same documented
 * test-harness limitation this codebase already tolerates identically in
 * lib/automation/post-job-followup.integration.test.ts's emit() wrapper. By
 * the time after() is reached, the automation_events row this test actually
 * asserts on has already been written and committed.
 */
async function emit(jobId: string, estimateId: string | null) {
  try {
    await emitJobCreatedEvent(sessionSupabase, organizationId, jobId, estimateId);
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("`after` was called outside a request scope"))) throw err;
  }
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Job-Created Event Payload Test Org", payment_status: "active", automation_mode: "live" }).select("id").single();
  organizationId = org!.id;

  const stamp = Date.now();
  const memberUser = await createTestUser(`job-created-event-${stamp}@example.com`, testUserIds);
  await service.from("organization_members").insert({ organization_id: organizationId, user_id: memberUser.id, role: "member" });
  sessionSupabase = await signInAs(memberUser.email, memberUser.password);
});

after(async () => {
  await service.from("workflow_executions").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("jobs").delete().eq("organization_id", organizationId);
  await service.from("estimates").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organization_members").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
  for (const id of testUserIds) {
    await service.auth.admin.deleteUser(id);
  }
});

test("A. a normal job with a real contact/lead produces a stored event payload carrying job_id, contact_id, lead_id, conversation_id, and estimate_id", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: `+1555581${Math.floor(1000 + Math.random() * 8999)}`, first_name: "Regression Customer" }).select("id").single();
  const { data: lead } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contact!.id, status: "won", temperature: "warm", source: "website" }).select("id").single();
  const { data: estimate } = await service.from("estimates").insert({ organization_id: organizationId, contact_id: contact!.id, lead_id: lead!.id, title: "Regression Estimate", status: "accepted", amount: 2500 }).select("id").single();
  const { data: job } = await service
    .from("jobs")
    .insert({ organization_id: organizationId, contact_id: contact!.id, lead_id: lead!.id, estimate_id: estimate!.id, title: "Regression Test Job", status: "scheduled" })
    .select("id")
    .single();

  await emit(job!.id, estimate!.id);

  const { data: event } = await service.from("automation_events").select("payload").eq("organization_id", organizationId).eq("event_type", "job.created").eq("entity_id", job!.id).single();

  assert.ok(event, "expected a job.created event row to have been created");
  const payload = event!.payload as Record<string, unknown>;
  assert.equal(payload.job_id, job!.id);
  assert.equal(payload.estimate_id, estimate!.id);
  assert.equal(payload.contact_id, contact!.id, "contact_id must be present and correct in the STORED payload - this is exactly the field the n8n callback route's outbound gate re-derives contactId from, and its absence is the confirmed root cause of the missing_contact_id defect");
  assert.equal(payload.lead_id, lead!.id);
  assert.ok(typeof payload.conversation_id === "string" && (payload.conversation_id as string).length > 0, "a conversation must have been opened/reused and its id stored");

  const { data: conversation } = await service.from("conversations").select("id, contact_id").eq("id", payload.conversation_id as string).single();
  assert.ok(conversation, "the stored conversation_id must resolve to a real conversation row");
  assert.equal(conversation!.contact_id, contact!.id);
});

test("B. a job with no linked contact still creates the event, with genuinely null contact_id/lead_id/conversation_id - never fabricated", async () => {
  const { data: job } = await service.from("jobs").insert({ organization_id: organizationId, contact_id: null, lead_id: null, title: "Contactless Regression Job", status: "scheduled" }).select("id").single();

  await emit(job!.id, null);

  const { data: event } = await service.from("automation_events").select("payload").eq("organization_id", organizationId).eq("event_type", "job.created").eq("entity_id", job!.id).single();

  assert.ok(event);
  const payload = event!.payload as Record<string, unknown>;
  assert.equal(payload.job_id, job!.id);
  assert.equal(payload.estimate_id, undefined, "no estimate_id key at all when no estimate was involved - matches the existing, unchanged estimateId-omitted shape");
  assert.equal(payload.contact_id, null);
  assert.equal(payload.lead_id, null);
  assert.equal(payload.conversation_id, null, "no contact means no conversation can be opened - never fabricated");
});

test("C. the stored payload's identifiers match exactly what the n8n callback route's outbound gate re-derives contactId/leadId/conversationId from - the regression this fix specifically prevents", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: `+1555582${Math.floor(1000 + Math.random() * 8999)}`, first_name: "Downstream Contract Customer" }).select("id").single();
  const { data: job } = await service.from("jobs").insert({ organization_id: organizationId, contact_id: contact!.id, title: "Downstream Contract Job", status: "scheduled" }).select("id").single();

  await emit(job!.id, null);

  const { data: event } = await service.from("automation_events").select("payload").eq("organization_id", organizationId).eq("event_type", "job.created").eq("entity_id", job!.id).single();
  const payload = event!.payload as { job_id: string; contact_id: string | null; lead_id: string | null; conversation_id: string | null };

  // This is exactly the read the n8n callback route performs (see
  // app/api/automation/n8n-callback/route.ts's shared contactId/leadId/
  // conversationId derivation): typeof event.payload?.contact_id ===
  // "string" ? event.payload.contact_id : null. A real contact must never
  // resolve to null here - that is precisely how missing_contact_id was
  // wrongly produced for a job that legitimately had a contact.
  const derivedContactId = typeof payload.contact_id === "string" ? payload.contact_id : null;
  assert.equal(derivedContactId, contact!.id, "the callback route's own contactId derivation must resolve to the real contact, never null, for a job that has one");
});
