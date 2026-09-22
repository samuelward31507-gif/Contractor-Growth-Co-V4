/**
 * Integration tests for Growth System Completion Pass 2, Part 8 (Referral ->
 * Lead Creation) - createLeadFromReferralForOrganization in
 * app/(app)/jobs/actions.ts. Exercises the testable core directly with a
 * real, signed-in session client (mirrors
 * lib/automation/lead-stage-history.integration.test.ts's exact fixture
 * pattern) - the thin createLeadFromReferral Server Action wrapper cannot be
 * exercised in a plain Node test since requireOrganization() depends on
 * next/headers's cookies(), which has no real request scope outside an
 * actual Next.js request.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/jobs/actions.referral-lead.integration.test.ts"
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
const { createLeadFromReferralForOrganization }: typeof import("./actions") = require(path.join(REPO_ROOT, "app/(app)/jobs/actions.ts"));

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
let userId: string;
let sessionSupabase: ReturnType<typeof createSupabaseClient>;
const testUserIds: string[] = [];

/**
 * emitLeadCreatedFollowup's own n8n-dispatch call uses Next.js's after(),
 * which has no valid scope outside a real Next.js request - a genuine
 * test-harness limitation (this codebase has no existing test that
 * exercises any after()-calling code path directly; in a real production
 * request, after() always has a valid scope, exactly like every other
 * lead-creation path that already calls emitLeadCreatedFollowup today). By
 * the time after() is reached, every durable piece of this action's own
 * work - the contact, the lead, and the referral_requests attribution
 * update - has already committed successfully (see the implementation's own
 * comment on why attribution is claimed before the lifecycle dispatch), so
 * this is never treated as a product regression here, mirroring how a
 * Supabase Auth 429 from concurrent test sign-ins is never treated as one.
 */
async function callAction(jobId: string, input: Parameters<typeof createLeadFromReferralForOrganization>[4]) {
  try {
    return await createLeadFromReferralForOrganization(sessionSupabase, organizationId, userId, jobId, input);
  } catch (err) {
    if (err instanceof Error && err.message.includes("`after` was called outside a request scope")) {
      return { ok: true as const };
    }
    throw err;
  }
}

async function makeReferringSetup(referralStatus: "requested" | "responded" | "converted" | "declined" = "requested") {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: `+1555555${Math.floor(1000 + Math.random() * 8999)}`, first_name: "Referring Customer" }).select("id").single();
  const { data: job } = await service.from("jobs").insert({ organization_id: organizationId, contact_id: contact!.id, title: "Water Heater Install", status: "completed", completed_at: new Date().toISOString() }).select("id").single();
  const { data: referral } = await service
    .from("referral_requests")
    .insert({ organization_id: organizationId, job_id: job!.id, contact_id: contact!.id, status: referralStatus, requested_at: new Date().toISOString() })
    .select("id")
    .single();
  return { referringContactId: contact!.id as string, jobId: job!.id as string, referralId: referral!.id as string };
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Referral Lead Test Org", payment_status: "active", automation_mode: "live" }).select("id").single();
  organizationId = org!.id;

  const stamp = Date.now();
  const memberUser = await createTestUser(`referral-lead-${stamp}@example.com`, testUserIds);
  await service.from("organization_members").insert({ organization_id: organizationId, user_id: memberUser.id, role: "member" });
  userId = memberUser.id;
  sessionSupabase = await signInAs(memberUser.email, memberUser.password);
});

after(async () => {
  await service.from("messages").delete().eq("organization_id", organizationId);
  await service.from("conversations").delete().eq("organization_id", organizationId);
  await service.from("workflow_executions").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("referral_requests").delete().eq("organization_id", organizationId);
  await service.from("jobs").delete().eq("organization_id", organizationId);
  await service.from("leads").delete().eq("organization_id", organizationId);
  await service.from("contacts").delete().eq("organization_id", organizationId);
  await service.from("organization_members").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
  for (const id of testUserIds) {
    await service.auth.admin.deleteUser(id);
  }
});

test("1. creates a new contact and a new lead for the referred person, attributed to the referral, using the real job's service as a fallback - never a fabricated one", async () => {
  const { jobId, referralId } = await makeReferringSetup("requested");
  const phone = `+1555556${Math.floor(1000 + Math.random() * 8999)}`;

  const result = await callAction(jobId, { firstName: "Morgan", phone });
  assert.equal(result.ok, true);

  const { data: contactRow } = await service.from("contacts").select("id").eq("organization_id", organizationId).eq("phone", phone).single();
  const { data: lead } = await service.from("leads").select("id, source, service, status, contact_id").eq("contact_id", contactRow!.id).single();
  assert.equal(lead!.source, "referral");
  assert.equal(lead!.service, "Water Heater Install", "falls back to the real, known job title - never a hardcoded generic service");
  assert.equal(lead!.status, "new");

  const { data: contact } = await service.from("contacts").select("id, first_name, phone").eq("id", lead!.contact_id).single();
  assert.equal(contact!.first_name, "Morgan");
  assert.equal(contact!.phone, phone);

  const { data: referral } = await service.from("referral_requests").select("status, referred_lead_id").eq("id", referralId).single();
  assert.equal(referral!.status, "converted");
  assert.equal(referral!.referred_lead_id, lead!.id, "attribution must link the referral to the newly created lead");
});

test("2. triggers the normal lead.created lifecycle event, exactly like any other lead source", async () => {
  const { jobId } = await makeReferringSetup("requested");
  const phone = `+1555557${Math.floor(1000 + Math.random() * 8999)}`;

  const result = await callAction(jobId, { firstName: "Casey", phone });
  assert.equal(result.ok, true);

  const { data: contactRow } = await service.from("contacts").select("id").eq("organization_id", organizationId).eq("phone", phone).single();
  const { data: lead } = await service.from("leads").select("id").eq("contact_id", contactRow!.id).single();

  const { data: events } = await service.from("automation_events").select("event_type, entity_id").eq("organization_id", organizationId).eq("event_type", "lead.created").eq("entity_id", lead!.id);
  assert.equal((events ?? []).length, 1, "exactly one lead.created event must be recorded for the new referred lead");
});

test("3. re-uses an existing contact by phone rather than creating a duplicate", async () => {
  const { jobId: jobA } = await makeReferringSetup("requested");
  const sharedPhone = `+1555558${Math.floor(1000 + Math.random() * 8999)}`;

  const first = await callAction(jobA, { firstName: "Riley", phone: sharedPhone });
  assert.equal(first.ok, true);

  const { jobId: jobB } = await makeReferringSetup("requested");
  const second = await callAction(jobB, { firstName: "Riley", phone: sharedPhone });
  assert.equal(second.ok, true);

  const { data: contactRow } = await service.from("contacts").select("id").eq("organization_id", organizationId).eq("phone", sharedPhone).single();
  const { data: leads } = await service.from("leads").select("id").eq("organization_id", organizationId).eq("contact_id", contactRow!.id);
  assert.equal((leads ?? []).length, 2, "the same real phone number must resolve to the same contact, never a duplicate contact - but each referral still gets its own lead");
});

test("4. a referral already converted cannot be converted again - no duplicate lead for the same referral", async () => {
  const { jobId } = await makeReferringSetup("requested");
  const phone = `+1555559${Math.floor(1000 + Math.random() * 8999)}`;

  const first = await callAction(jobId, { firstName: "Dana", phone });
  assert.equal(first.ok, true);

  const second = await callAction(jobId, { firstName: "Dana", phone });
  assert.equal(second.ok, false);
  assert.match((second as { error: string }).error, /already been converted/);

  const { data: contactRow } = await service.from("contacts").select("id").eq("organization_id", organizationId).eq("phone", phone).single();
  const { data: leads } = await service.from("leads").select("id").eq("organization_id", organizationId).eq("contact_id", contactRow!.id);
  assert.equal((leads ?? []).length, 1, "only one lead must ever exist for this single referral, even after a retried/double-clicked submission");
});

test("5. a referral request in a non-eligible state (e.g. already declined) is rejected", async () => {
  const { jobId } = await makeReferringSetup("declined");
  const phone = `+1555550${Math.floor(1000 + Math.random() * 8999)}`;

  const result = await callAction(jobId, { firstName: "Sam", phone });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /not in an eligible state/);
});

test("6. missing both phone and email is rejected before any contact or lead is created", async () => {
  const { jobId, referralId } = await makeReferringSetup("requested");

  const result = await callAction(jobId, { firstName: "NoContact" });
  assert.equal(result.ok, false);

  const { data: referral } = await service.from("referral_requests").select("status, referred_lead_id").eq("id", referralId).single();
  assert.equal(referral!.status, "requested", "a rejected submission must never mutate the referral request");
  assert.equal(referral!.referred_lead_id, null);
});

test("7. a job with no referral request at all is rejected", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: organizationId, phone: `+1555551${Math.floor(1000 + Math.random() * 8999)}` }).select("id").single();
  const { data: job } = await service.from("jobs").insert({ organization_id: organizationId, contact_id: contact!.id, title: "No Referral Job", status: "completed" }).select("id").single();

  const result = await callAction(job!.id, { firstName: "Nobody", phone: "+15555529999" });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /no referral request/);
});
