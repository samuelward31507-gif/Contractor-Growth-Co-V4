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
  // "ai" and "booking" are optional/never-configured-yet on this fresh
  // fixture org and never block Go Live readiness - see canGoLive, which
  // only ever checks business/hours/sms. "calendar" IS included in this
  // check: with no connection at all it correctly reports
  // state: "disabled_by_intent" (complete: true), a valid choice, not a gap.
  assert.equal(readiness.items.every((i) => i.key === "ai" || i.key === "booking" || i.complete), true);
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

// ==================== Growth System Completion Pass 1: booking/calendar readiness ====================

test("11. booking: never configured at all reports state 'not_ready' (complete: false) - a real gap, not a choice", async () => {
  const readiness = await computeOnboardingReadiness(service, setupOrgId);
  const item = readiness.items.find((i) => i.key === "booking");
  assert.equal(item?.state, "not_ready");
  assert.equal(item?.complete, false);
});

test("12. booking: configured and explicitly left disabled reports state 'disabled_by_intent' (complete: true) - a valid choice, not a gap", async () => {
  await service.from("booking_settings").upsert({ organization_id: readyOrgId, booking_enabled: false }, { onConflict: "organization_id" });
  const readiness = await computeOnboardingReadiness(service, readyOrgId);
  const item = readiness.items.find((i) => i.key === "booking");
  assert.equal(item?.state, "disabled_by_intent");
  assert.equal(item?.complete, true);
  await service.from("booking_settings").delete().eq("organization_id", readyOrgId);
});

test("13. booking: configured and enabled reports state 'ready'", async () => {
  await service.from("booking_settings").upsert({ organization_id: readyOrgId, booking_enabled: true }, { onConflict: "organization_id" });
  const readiness = await computeOnboardingReadiness(service, readyOrgId);
  const item = readiness.items.find((i) => i.key === "booking");
  assert.equal(item?.state, "ready");
  assert.equal(item?.complete, true);
  await service.from("booking_settings").delete().eq("organization_id", readyOrgId);
});

test("14. calendar: no connection at all reports state 'disabled_by_intent' (complete: true) - not every contractor uses Google Calendar", async () => {
  const readiness = await computeOnboardingReadiness(service, setupOrgId);
  const item = readiness.items.find((i) => i.key === "calendar");
  assert.equal(item?.state, "disabled_by_intent");
  assert.equal(item?.complete, true);
});

test("15. calendar: a connected but unhealthy (status: 'error') connection reports state 'not_ready' (complete: false) - a real, broken thing that needs attention", async () => {
  await service.from("calendar_connections").insert({ organization_id: readyOrgId, provider: "google", account_email: "owner@example.com", status: "error", last_error: "token revoked" });
  const readiness = await computeOnboardingReadiness(service, readyOrgId);
  const item = readiness.items.find((i) => i.key === "calendar");
  assert.equal(item?.state, "not_ready");
  assert.equal(item?.complete, false);
  await service.from("calendar_connections").delete().eq("organization_id", readyOrgId);
});

test("16. calendar: a connected and healthy connection reports state 'ready'", async () => {
  await service.from("calendar_connections").insert({ organization_id: readyOrgId, provider: "google", account_email: "owner@example.com", status: "connected" });
  const readiness = await computeOnboardingReadiness(service, readyOrgId);
  const item = readiness.items.find((i) => i.key === "calendar");
  assert.equal(item?.state, "ready");
  assert.equal(item?.complete, true);
  await service.from("calendar_connections").delete().eq("organization_id", readyOrgId);
});

test("17. booking/calendar readiness never blocks canGoLive - only business/hours/sms do", async () => {
  const { canGoLive }: typeof import("./checklist") = require(path.join(REPO_ROOT, "lib/onboarding/checklist.ts"));
  const check = canGoLive({
    items: [
      { key: "business", label: "Business profile", complete: true, state: "ready" },
      { key: "hours", label: "Business hours", complete: true, state: "ready" },
      { key: "sms", label: "SMS configured", complete: true, state: "ready" },
      { key: "booking", label: "AI appointment booking", complete: false, state: "not_ready" },
      { key: "calendar", label: "Google Calendar sync", complete: false, state: "not_ready" },
    ],
  });
  assert.equal(check.allowed, true, "booking/calendar must never block Go Live - they are surfaced, not enforced");
});
