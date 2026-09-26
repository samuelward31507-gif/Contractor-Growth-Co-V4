/**
 * Trackpr 2.0, Launch Certification QA fix: regression test for a
 * confirmed, 100%-reproducible defect found during a real, fresh end-to-end
 * lifecycle test - emitPostJobFollowup's stored automation_events.payload
 * only ever contained job_id, never contact_id/lead_id/conversation_id,
 * even though a real, valid contact was linked to the job. The n8n callback
 * route (app/api/automation/n8n-callback/route.ts) re-derives contactId for
 * the outbound gate exclusively from this stored payload, never from the
 * separate contract object dispatched to n8n - so every job.post_followup
 * send was unconditionally denied with missing_contact_id, for every
 * organization, every time. This test proves the stored payload now
 * carries the real values the callback route depends on.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/post-job-followup.integration.test.ts
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
const { emitPostJobFollowup }: typeof import("./post-job-followup") = require(path.join(REPO_ROOT, "lib/automation/post-job-followup.ts"));

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
 * emitPostJobFollowup's own n8n-dispatch call uses Next.js's after(), which
 * has no valid scope outside a real Next.js request - the same documented
 * test-harness limitation this codebase already tolerates identically in
 * app/(app)/jobs/actions.referral-lead.integration.test.ts's callAction().
 * By the time after() is reached, the automation_events row this test
 * actually asserts on has already been written and committed.
 */
async function emit(jobId: string) {
  try {
    await emitPostJobFollowup(sessionSupabase, organizationId, jobId);
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("`after` was called outside a request scope"))) throw err;
  }
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Post-Job Followup Payload Test Org", payment_status: "active", automation_mode: "live" }).select("id").single();
  organizationId = org!.id;

  const stamp = Date.now();
  const memberUser = await createTestUser(`post-job-followup-${stamp}@example.com`, testUserIds);
  await service.from("organization_members").insert({ organization_id: organizationId, user_id: memberUser.id, role: "member" });
  sessionSupabase = await signInAs(memberUser.email, memberUser.password);
});

after(async () => {
  await service.from("workflow_executions").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("jobs").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organization_members").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
  for (const id of testUserIds) {
    await service.auth.admin.deleteUser(id);
  }
});

test("the stored job.post_followup event payload carries the real contact_id, lead_id, and conversation_id - not just job_id", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: `+1555580${Math.floor(1000 + Math.random() * 8999)}`, first_name: "Regression Customer" }).select("id").single();
  const { data: lead } = await service.from("leads").insert({ organization_id: organizationId, contact_id: contact!.id, status: "won", temperature: "warm", source: "website" }).select("id").single();
  const { data: job } = await service
    .from("jobs")
    .insert({ organization_id: organizationId, contact_id: contact!.id, lead_id: lead!.id, title: "Regression Test Job", status: "completed", completed_at: new Date().toISOString() })
    .select("id")
    .single();

  await emit(job!.id);

  const { data: event } = await service
    .from("automation_events")
    .select("payload")
    .eq("organization_id", organizationId)
    .eq("event_type", "job.post_followup")
    .eq("entity_id", job!.id)
    .single();

  assert.ok(event, "expected a job.post_followup event row to have been created");
  const payload = event!.payload as Record<string, unknown>;
  assert.equal(payload.job_id, job!.id);
  assert.equal(payload.contact_id, contact!.id, "contact_id must be present and correct in the STORED payload - the n8n callback route re-derives it from exactly this column, never from the separate n8n dispatch contract");
  assert.equal(payload.lead_id, lead!.id);
  assert.ok(typeof payload.conversation_id === "string" && payload.conversation_id.length > 0, "a conversation must have been opened/reused and its id stored");

  // The conversation_id stored in the payload must be a real, existing
  // conversation for this contact - not a fabricated or stale value.
  const { data: conversation } = await service.from("conversations").select("id, contact_id").eq("id", payload.conversation_id as string).single();
  assert.ok(conversation, "the stored conversation_id must resolve to a real conversation row");
  assert.equal(conversation!.contact_id, contact!.id);
});

test("a job with no linked contact still creates the event, with a genuinely null contact_id (never fabricated)", async () => {
  const { data: job } = await service
    .from("jobs")
    .insert({ organization_id: organizationId, contact_id: null, title: "Contactless Regression Job", status: "completed", completed_at: new Date().toISOString() })
    .select("id")
    .single();

  await emit(job!.id);

  const { data: event } = await service
    .from("automation_events")
    .select("payload")
    .eq("organization_id", organizationId)
    .eq("event_type", "job.post_followup")
    .eq("entity_id", job!.id)
    .single();

  assert.ok(event);
  const payload = event!.payload as Record<string, unknown>;
  assert.equal(payload.contact_id, null);
  assert.equal(payload.conversation_id, null, "no contact means no conversation can be opened - never fabricated");
});
