/**
 * Integration tests for First Client Onboarding V1's readiness computation
 * (lib/onboarding/readiness.ts) - the single source of truth shared by the
 * client-facing onboarding hub (app/onboarding) and the agency's read-only
 * organization detail page. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/onboarding/readiness.integration.test.ts
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
const { computeOnboardingReadiness, getLatestTestLeadOutcome, ONBOARDING_TEST_LEAD_SOURCE }: typeof import("./readiness") = require(
  path.join(REPO_ROOT, "lib/onboarding/readiness.ts"),
);

const service = createServiceRoleClient();

let setupOrgId: string;
let blockedOrgId: string;
let testingOrgId: string;
let readyOrgId: string;
let liveOrgId: string;

before(async () => {
  // organizations.name is NOT NULL, so "setup" incompleteness is exercised
  // via a real name with no phone yet - the actual, reachable incomplete
  // state a new signup leaves behind before Settings is ever touched.
  const { data: setup } = await service.from("organizations").insert({ name: "Onboarding Test - Setup" }).select("id").single();
  setupOrgId = setup!.id;

  const { data: blocked } = await service.from("organizations").insert({ name: "Onboarding Test - Blocked", phone: "+15555550111" }).select("id").single();
  blockedOrgId = blocked!.id;

  const { data: testing } = await service
    .from("organizations")
    .insert({ name: "Onboarding Test - Testing", phone: "+15555550112", sms_phone_number: "+15555550113" })
    .select("id")
    .single();
  testingOrgId = testing!.id;
  await service.from("business_hours").delete().eq("organization_id", testingOrgId); // ensure genuinely empty

  const { data: ready } = await service
    .from("organizations")
    .insert({ name: "Onboarding Test - Ready", phone: "+15555550114", sms_phone_number: "+15555550115" })
    .select("id")
    .single();
  readyOrgId = ready!.id;
  await service.from("business_hours").insert({ organization_id: readyOrgId, day_of_week: "monday", is_open: true, open_time: "09:00", close_time: "17:00" });

  const { data: live } = await service
    .from("organizations")
    .insert({ name: "Onboarding Test - Live", phone: "+15555550116", automation_mode: "live" })
    .select("id")
    .single();
  liveOrgId = live!.id;
});

after(async () => {
  for (const id of [setupOrgId, blockedOrgId, testingOrgId, readyOrgId, liveOrgId]) {
    if (id) await service.from("organizations").delete().eq("id", id);
  }
});

test("1. a newly signed-up org with no phone yet reports status 'setup'", async () => {
  const readiness = await computeOnboardingReadiness(service, setupOrgId);
  assert.equal(readiness.status, "setup");
  assert.equal(readiness.items.find((i) => i.key === "business")?.complete, false);
});

test("2. business complete but SMS missing reports status 'blocked' - matching the exact gate updateAutomationMode enforces", async () => {
  const readiness = await computeOnboardingReadiness(service, blockedOrgId);
  assert.equal(readiness.status, "blocked");
  assert.equal(readiness.items.find((i) => i.key === "business")?.complete, true);
  assert.equal(readiness.items.find((i) => i.key === "sms")?.complete, false);
});

test("3. business + SMS complete but hours not configured reports status 'testing'", async () => {
  const readiness = await computeOnboardingReadiness(service, testingOrgId);
  assert.equal(readiness.status, "testing");
  assert.equal(readiness.items.find((i) => i.key === "hours")?.complete, false);
});

test("4. business + SMS + hours all complete reports status 'ready' - Go Live is available", async () => {
  const readiness = await computeOnboardingReadiness(service, readyOrgId);
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.items.every((i) => i.key === "ai" || i.complete), true);
});

test("5. automation_mode 'live' always reports status 'live', regardless of other configuration", async () => {
  const readiness = await computeOnboardingReadiness(service, liveOrgId);
  assert.equal(readiness.status, "live");
  assert.equal(readiness.automationMode, "live");
});

test("6. every new organization defaults to automation_mode 'test' (Go Live is always an explicit, separate step)", async () => {
  const readiness = await computeOnboardingReadiness(service, readyOrgId);
  assert.equal(readiness.automationMode, "test");
});

test("7. organization isolation: readiness for one organization never reflects another's configuration", async () => {
  const blockedReadiness = await computeOnboardingReadiness(service, blockedOrgId);
  const readyReadiness = await computeOnboardingReadiness(service, readyOrgId);
  assert.notEqual(blockedReadiness.status, readyReadiness.status);
  assert.equal(blockedReadiness.items.find((i) => i.key === "sms")?.complete, false);
  assert.equal(readyReadiness.items.find((i) => i.key === "sms")?.complete, true);
});

test("8. lead capture is always reported complete - every organization has a lead_intake_token from creation", async () => {
  const readiness = await computeOnboardingReadiness(service, setupOrgId);
  assert.equal(readiness.items.find((i) => i.key === "leadCapture")?.complete, true);
});

test("9. getLatestTestLeadOutcome returns null when no onboarding test lead has ever been sent", async () => {
  const outcome = await getLatestTestLeadOutcome(service, setupOrgId);
  assert.equal(outcome, null);
});

test("10. getLatestTestLeadOutcome correctly reads back a real test lead's automation event and execution", async () => {
  const { data: contact } = await service.from("contacts").insert({ organization_id: readyOrgId, first_name: "Test", last_name: "Lead", phone: "+15555550100" }).select("id").single();
  const { data: lead } = await service
    .from("leads")
    .insert({ organization_id: readyOrgId, contact_id: contact!.id, service: "Onboarding test lead", source: ONBOARDING_TEST_LEAD_SOURCE, status: "new", temperature: "cold" })
    .select("id")
    .single();
  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: readyOrgId, event_type: "lead.created", entity_type: "lead", entity_id: lead!.id, status: "processing", payload: {}, idempotency_key: `lead.created:${lead!.id}` })
    .select("id")
    .single();
  await service.from("workflow_executions").insert({
    organization_id: readyOrgId,
    automation_event_id: event!.id,
    workflow_name: "lead_created_followup",
    status: "completed",
    attempt: 1,
    metadata: { should_send: false, blocked_reason: "organization_not_live" },
  });

  const outcome = await getLatestTestLeadOutcome(service, readyOrgId);
  assert.equal(outcome?.leadId, lead!.id);
  assert.equal(outcome?.executionStatus, "completed");
  assert.equal(outcome?.blockedReason, "organization_not_live");
});
