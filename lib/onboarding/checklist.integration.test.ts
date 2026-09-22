/**
 * Integration tests for First Contractor Onboarding + Internal Client Setup
 * System (lib/onboarding/checklist.ts) - the setup checklist, derived
 * lifecycle stage, and Go Live gate built on top of
 * lib/onboarding/readiness.ts's computeOnboardingReadiness. Mirrors
 * lib/onboarding/readiness.integration.test.ts's setup (real DB-backed test
 * organizations) and lib/settings/sms-routing.integration.test.ts's real
 * per-role/cross-org RLS pattern for the new organizations/
 * notification_settings columns this feature added.
 *
 * Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/onboarding/checklist.integration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
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
const { computeSetupChecklist, canGoLive }: typeof import("./checklist") = require(path.join(REPO_ROOT, "lib/onboarding/checklist.ts"));

const service = createServiceRoleClient();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let newOrgId: string;
let configuringOrgId: string;
let testingOrgId: string;
let readyOrgId: string;
let liveOrgId: string;
let orgAId: string;
let orgBId: string;
const testUserIds: string[] = [];
const cleanupOrgIds: string[] = [];

async function createTestUser(email: string) {
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`failed to create test user ${email}: ${error?.message}`);
  testUserIds.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function signInAs(email: string, password: string) {
  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

let ownerA: { id: string; email: string; password: string };
let ownerB: { id: string; email: string; password: string };

before(async () => {
  const { data: newOrg } = await service.from("organizations").insert({ name: "Checklist Test - New" }).select("id").single();
  newOrgId = newOrg!.id;

  const { data: configuringOrg } = await service
    .from("organizations")
    .insert({ name: "Checklist Test - Configuring", phone: "+15555550120" })
    .select("id")
    .single();
  configuringOrgId = configuringOrg!.id;

  const { data: testingOrg } = await service
    .from("organizations")
    .insert({ name: "Checklist Test - Testing", phone: "+15555550121", sms_phone_number: "+15555550122" })
    .select("id")
    .single();
  testingOrgId = testingOrg!.id;
  await service.from("business_hours").insert({ organization_id: testingOrgId, day_of_week: "monday", is_open: true, open_time: "09:00", close_time: "17:00" });

  const { data: readyOrg } = await service
    .from("organizations")
    .insert({ name: "Checklist Test - Ready", phone: "+15555550123", sms_phone_number: "+15555550124" })
    .select("id")
    .single();
  readyOrgId = readyOrg!.id;
  await service.from("business_hours").insert({ organization_id: readyOrgId, day_of_week: "monday", is_open: true, open_time: "09:00", close_time: "17:00" });

  const { data: liveOrg } = await service
    .from("organizations")
    .insert({ name: "Checklist Test - Live", phone: "+15555550125", sms_phone_number: "+15555550126", automation_mode: "live" })
    .select("id")
    .single();
  liveOrgId = liveOrg!.id;

  const { data: orgA } = await service.from("organizations").insert({ name: "Checklist Test Org A" }).select("id").single();
  const { data: orgB } = await service.from("organizations").insert({ name: "Checklist Test Org B" }).select("id").single();
  orgAId = orgA!.id;
  orgBId = orgB!.id;

  cleanupOrgIds.push(newOrgId, configuringOrgId, testingOrgId, readyOrgId, liveOrgId, orgAId, orgBId);

  const stamp = Date.now();
  ownerA = await createTestUser(`checklist-owner-a-${stamp}@example.com`);
  ownerB = await createTestUser(`checklist-owner-b-${stamp}@example.com`);

  await service.from("organization_members").insert([
    { organization_id: orgAId, user_id: ownerA.id, role: "owner" },
    { organization_id: orgBId, user_id: ownerB.id, role: "owner" },
  ]);
});

after(async () => {
  for (const orgId of cleanupOrgIds) {
    await service.from("workflow_executions").delete().eq("organization_id", orgId);
    await service.from("automation_events").delete().eq("organization_id", orgId);
    await service.from("leads").delete().eq("organization_id", orgId);
    await service.from("contacts").delete().eq("organization_id", orgId);
    await service.from("business_hours").delete().eq("organization_id", orgId);
    await service.from("organization_members").delete().eq("organization_id", orgId);
    await service.from("organizations").delete().eq("id", orgId);
  }
  for (const userId of testUserIds) {
    await service.auth.admin.deleteUser(userId);
  }
});

// ==================== Stage derivation ====================

test("1. a brand-new organization with no phone yet is stage 'new'", async () => {
  const checklist = await computeSetupChecklist(service, newOrgId);
  assert.equal(checklist.stage, "new");
  assert.equal(checklist.items.find((i) => i.key === "business")?.complete, false);
});

test("2. business complete but hours/SMS missing is stage 'configuring'", async () => {
  const checklist = await computeSetupChecklist(service, configuringOrgId);
  assert.equal(checklist.stage, "configuring");
  assert.equal(checklist.items.find((i) => i.key === "business")?.complete, true);
  assert.equal(checklist.items.find((i) => i.key === "sms")?.complete, false);
});

test("3. business + hours + SMS + lead capture complete but no test yet is stage 'testing'", async () => {
  const checklist = await computeSetupChecklist(service, testingOrgId);
  assert.equal(checklist.stage, "testing");
  assert.equal(checklist.items.find((i) => i.key === "hours")?.complete, true);
  assert.equal(checklist.items.find((i) => i.key === "testCompleted")?.complete, false);
});

test("4. lead capture is always complete - every organization has a lead_intake_token from creation", async () => {
  const checklist = await computeSetupChecklist(service, newOrgId);
  assert.equal(checklist.items.find((i) => i.key === "leadCapture")?.complete, true);
});

test("5. a verified test lead (blocked only by organization_not_live, exactly as Test mode should behave) moves the org to stage 'ready'", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: readyOrgId, first_name: "Test", last_name: "Lead", phone: "+15555550100" }).select("id").single();
  const { data: lead } = await service
    .from("leads")
    .insert({ organization_id: readyOrgId, contact_id: contact!.id, service: "Onboarding test lead", source: "onboarding_test", status: "new", temperature: "cold" })
    .select("id")
    .single();
  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: readyOrgId, event_type: "lead.created", entity_type: "lead", entity_id: lead!.id, status: "processing", payload: {}, idempotency_key: `lead.created:${lead!.id}:checklist` })
    .select("id")
    .single();
  await service.from("workflow_executions").insert({
    organization_id: readyOrgId,
    automation_event_id: event!.id,
    workflow_name: "lead_created_followup",
    status: "completed",
    attempt: 1,
    metadata: { should_send: true, blocked_reason: "organization_not_live" },
  });

  const checklist = await computeSetupChecklist(service, readyOrgId);
  assert.equal(checklist.items.find((i) => i.key === "testCompleted")?.complete, true);
  assert.equal(checklist.items.find((i) => i.key === "testVerified")?.complete, true, "organization_not_live must count as a verified test, not a failure");
  assert.equal(checklist.stage, "ready");
});

test("6. a test blocked for a different reason (e.g. the automation service being unavailable) does NOT count as verified", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: configuringOrgId, first_name: "Test", last_name: "Lead", phone: "+15555550101" }).select("id").single();
  await service.from("organizations").update({ sms_phone_number: "+15555550199" }).eq("id", configuringOrgId);
  await service.from("business_hours").insert({ organization_id: configuringOrgId, day_of_week: "monday", is_open: true, open_time: "09:00", close_time: "17:00" });
  const { data: lead } = await service
    .from("leads")
    .insert({ organization_id: configuringOrgId, contact_id: contact!.id, service: "Onboarding test lead", source: "onboarding_test", status: "new", temperature: "cold" })
    .select("id")
    .single();
  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: configuringOrgId, event_type: "lead.created", entity_type: "lead", entity_id: lead!.id, status: "failed", payload: {}, idempotency_key: `lead.created:${lead!.id}:checklist-fail` })
    .select("id")
    .single();
  await service.from("workflow_executions").insert({
    organization_id: configuringOrgId,
    automation_event_id: event!.id,
    workflow_name: "lead_created_followup",
    status: "failed",
    attempt: 1,
    metadata: {},
  });

  const checklist = await computeSetupChecklist(service, configuringOrgId);
  assert.equal(checklist.items.find((i) => i.key === "testCompleted")?.complete, true, "a test was attempted");
  assert.equal(checklist.items.find((i) => i.key === "testVerified")?.complete, false, "a genuine failure must never read as verified");
});

test("7. automation_mode 'live' is always stage 'live', regardless of everything else", async () => {
  const checklist = await computeSetupChecklist(service, liveOrgId);
  assert.equal(checklist.stage, "live");
  assert.equal(checklist.items.find((i) => i.key === "goLive")?.complete, true);
});

test("8. organization isolation: the checklist for one organization never reflects another's configuration", async () => {
  const configuring = await computeSetupChecklist(service, configuringOrgId);
  const ready = await computeSetupChecklist(service, readyOrgId);
  assert.notEqual(configuring.stage, ready.stage);
  assert.equal(configuring.items.find((i) => i.key === "hours")?.complete, true, "set in test 6 for org isolation only, not the ready org's hours");
  assert.equal(ready.items.find((i) => i.key === "sms")?.complete, true);
});

// ==================== Go Live gate ====================

test("9. canGoLive rejects a new organization (no business profile)", () => {
  const result = canGoLive({ items: [{ key: "business", label: "Business profile", complete: false, state: "not_ready" }] });
  assert.equal(result.allowed, false);
});

test("10. canGoLive rejects when business hours are not configured, even with business + SMS complete", () => {
  const result = canGoLive({
    items: [
      { key: "business", label: "Business profile", complete: true, state: "ready" },
      { key: "hours", label: "Business hours", complete: false, state: "not_ready" },
      { key: "sms", label: "SMS configured", complete: true, state: "ready" },
    ],
  });
  assert.equal(result.allowed, false);
  assert.match(result.allowed ? "" : result.reason, /business hours/i);
});

test("11. canGoLive rejects when SMS is not configured, even with business + hours complete", () => {
  const result = canGoLive({
    items: [
      { key: "business", label: "Business profile", complete: true, state: "ready" },
      { key: "hours", label: "Business hours", complete: true, state: "ready" },
      { key: "sms", label: "SMS configured", complete: false, state: "not_ready" },
    ],
  });
  assert.equal(result.allowed, false);
});

test("12. canGoLive allows when business + hours + SMS are all complete, without requiring a verified test lead", () => {
  const result = canGoLive({
    items: [
      { key: "business", label: "Business profile", complete: true, state: "ready" },
      { key: "hours", label: "Business hours", complete: true, state: "ready" },
      { key: "sms", label: "SMS configured", complete: true, state: "ready" },
      { key: "testVerified", label: "Test lead verified", complete: false, state: "not_ready" },
    ],
  });
  assert.equal(result.allowed, true, "Go Live must never be permanently blocked by the n8n outage");
});

// ==================== RLS: new columns follow existing table policies ====================

test("13. an owner of a different organization cannot update org A's new profile fields (cross-org denial)", async () => {
  const clientB = await signInAs(ownerB.email, ownerB.password);
  const { data: updated } = await clientB
    .from("organizations")
    .update({ facebook_url: "https://facebook.com/hacked", estimate_process: "hacked" })
    .eq("id", orgAId)
    .select("id");
  assert.equal(updated?.length ?? 0, 0, "org B's owner has no admin membership in org A");
  const { data } = await service.from("organizations").select("facebook_url, estimate_process").eq("id", orgAId).single();
  assert.equal(data?.facebook_url, null);
  assert.equal(data?.estimate_process, null);
});

test("14. an org's own owner CAN update their new profile fields", async () => {
  const clientA = await signInAs(ownerA.email, ownerA.password);
  const { error } = await clientA
    .from("organizations")
    .update({ facebook_url: "https://facebook.com/realbiz", emergency_service: true, lead_sources: ["website", "referral"] })
    .eq("id", orgAId);
  assert.equal(error, null);
  const { data } = await service.from("organizations").select("facebook_url, emergency_service, lead_sources").eq("id", orgAId).single();
  assert.equal(data?.facebook_url, "https://facebook.com/realbiz");
  assert.equal(data?.emergency_service, true);
  assert.deepEqual(data?.lead_sources, ["website", "referral"]);
});

test("15. an anonymous caller cannot set escalation_contact_name on notification_settings", async () => {
  const anon = createSupabaseClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: updated } = await anon
    .from("notification_settings")
    .upsert({ organization_id: orgAId, escalation_contact_name: "Hacker" }, { onConflict: "organization_id" })
    .select("id");
  assert.equal(updated?.length ?? 0, 0);
});
