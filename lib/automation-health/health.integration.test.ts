/**
 * Integration tests for getOrganizationHealth()/getAutomationHealthSummaries() -
 * against an isolated, fully-cleaned-up test organization on the real
 * Supabase project. Uses the service-role client throughout (these functions
 * are generic over SupabaseClient - RLS is bypassed here deliberately, the
 * same way lib/agency/health.ts already does, since organization scope comes
 * from the explicit organizationId argument, not RLS). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/health.integration.test.ts
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
const { getOrganizationHealth, getAutomationHealthSummaries }: typeof import("./health") = require(path.join(REPO_ROOT, "lib/automation-health/health.ts"));

const service = createServiceRoleClient();
let organizationId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Automation Health Calc Integration Test Org" }).select("id").single();
  organizationId = org!.id;
});

after(async () => {
  await service.from("automation_incidents").delete().eq("organization_id", organizationId);
  await service.from("workflow_executions").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("an organization with no incidents and no execution history is healthy, with null (not zero) success rate", async () => {
  const health = await getOrganizationHealth(service, organizationId);
  assert.equal(health.status, "healthy");
  assert.equal(health.activeIncidentCount, 0);
  assert.equal(health.automationSuccessRate, null, "zero completed-or-failed executions must never be reported as a fabricated 0%/100% rate");
});

test("an organization with an active warning incident is degraded, not unhealthy", async () => {
  await service.rpc("record_automation_incident_signal", {
    p_organization_id: organizationId,
    p_category: "n8n_dispatch_failed",
    p_severity: "warning",
    p_fingerprint: `n8n_dispatch_failed:health-calc-warning-${Date.now()}`,
    p_title: "Warning-level incident",
  });

  const health = await getOrganizationHealth(service, organizationId);
  assert.equal(health.status, "degraded");
  assert.equal(health.warningIncidentCount >= 1, true);
  assert.equal(health.criticalIncidentCount, 0);
});

test("an organization with an active critical incident is unhealthy, overriding any lesser incidents present", async () => {
  await service.rpc("record_automation_incident_signal", {
    p_organization_id: organizationId,
    p_category: "n8n_callback_failed",
    p_severity: "critical",
    p_fingerprint: `n8n_callback_failed:health-calc-critical-${Date.now()}`,
    p_title: "Critical-level incident",
  });

  const health = await getOrganizationHealth(service, organizationId);
  assert.equal(health.status, "unhealthy");
  assert.equal(health.criticalIncidentCount >= 1, true);
});

test("stuckExecutionCount and smsDeliveryFailureCount reflect only active incidents of their own category", async () => {
  const stamp = Date.now();
  await service.rpc("record_automation_incident_signal", {
    p_organization_id: organizationId,
    p_category: "workflow_stuck",
    p_severity: "warning",
    p_fingerprint: `workflow_stuck:health-calc-stuck-exec-${stamp}`,
    p_title: "Stuck execution",
  });
  await service.rpc("record_automation_incident_signal", {
    p_organization_id: organizationId,
    p_category: "sms_delivery_failed",
    p_severity: "warning",
    p_fingerprint: `sms_delivery_failed:health-calc-message-${stamp}`,
    p_title: "Delivery failed",
  });

  const health = await getOrganizationHealth(service, organizationId);
  assert.equal(health.stuckExecutionCount >= 1, true);
  assert.equal(health.smsDeliveryFailureCount >= 1, true);
});

test("getAutomationHealthSummaries never includes the safety-layer automation (it has no workflow of its own)", async () => {
  const summaries = await getAutomationHealthSummaries(service, organizationId);
  assert.ok(!summaries.some((s) => s.automationId === "safe-ai-outbound"));
});

test("an automation with a real, active critical incident attributed to it is reported unhealthy with that incident counted", async () => {
  await service.rpc("record_automation_incident_signal", {
    p_organization_id: organizationId,
    p_category: "sms_send_failed",
    p_severity: "critical",
    p_fingerprint: `sms_send_failed:instant-lead-followup-health-calc-${Date.now()}`,
    p_title: "Instant Lead Follow-Up send failing",
    p_automation_id: "instant-lead-followup",
  });

  const summaries = await getAutomationHealthSummaries(service, organizationId);
  const target = summaries.find((s) => s.automationId === "instant-lead-followup");
  assert.ok(target);
  assert.equal(target?.status, "unhealthy");
  assert.equal(target!.criticalIncidentCount >= 1, true);
});

test("an automation with zero recorded executions reports a null failure rate, never a fabricated 0%", async () => {
  const summaries = await getAutomationHealthSummaries(service, organizationId);
  const target = summaries.find((s) => s.automationId === "lead-reactivation");
  assert.ok(target);
  assert.equal(target?.recentFailures, 0);
  assert.equal(target?.recentSuccesses, 0);
  assert.equal(target?.failureRate, null);
});

// HANDOFF-01: these two use their own dedicated, disposable organizations
// (rather than the file's shared `organizationId`) because the tests above
// already leave that shared org with an active critical incident - exactly
// the "otherwise healthy" baseline these two tests need to isolate against.
test("HANDOFF-01: an organization with ONLY an open human escalation reports the same healthy status it would otherwise have", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Automation Health - Human Escalation Isolation Test Org" }).select("id").single();
  const escalationOrgId = org!.id;
  try {
    const before = await getOrganizationHealth(service, escalationOrgId);
    assert.equal(before.status, "healthy");
    assert.equal(before.humanEscalationCount, 0);

    await service.rpc("record_automation_incident_signal", {
      p_organization_id: escalationOrgId,
      p_category: "human_escalation_requested",
      p_severity: "warning",
      p_fingerprint: `human_escalation_requested:health-calc-escalation-${Date.now()}`,
      p_title: "AI escalated a conversation to a human",
    });

    const after = await getOrganizationHealth(service, escalationOrgId);
    assert.equal(after.status, "healthy", "a human escalation must never degrade automation health status");
    assert.equal(after.activeIncidentCount, 0, "a human escalation must never count toward the generic active incident total");
    assert.equal(after.criticalIncidentCount, 0);
    assert.equal(after.warningIncidentCount, 0);
    assert.equal(after.humanEscalationCount, 1, "the escalation must still be tracked in its own dedicated field");
  } finally {
    await service.from("automation_incidents").delete().eq("organization_id", escalationOrgId);
    await service.from("organizations").delete().eq("id", escalationOrgId);
  }
});

test("HANDOFF-01: a human escalation never masks a genuine critical incident's unhealthy status, and both counts remain correct together", async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Automation Health - Escalation Plus Critical Test Org" }).select("id").single();
  const mixedOrgId = org!.id;
  try {
    await service.rpc("record_automation_incident_signal", {
      p_organization_id: mixedOrgId,
      p_category: "human_escalation_requested",
      p_severity: "warning",
      p_fingerprint: `human_escalation_requested:health-calc-mixed-${Date.now()}`,
      p_title: "AI escalated a conversation to a human",
    });
    await service.rpc("record_automation_incident_signal", {
      p_organization_id: mixedOrgId,
      p_category: "n8n_callback_failed",
      p_severity: "critical",
      p_fingerprint: `n8n_callback_failed:health-calc-mixed-${Date.now()}`,
      p_title: "Critical incident",
    });

    const health = await getOrganizationHealth(service, mixedOrgId);
    assert.equal(health.status, "unhealthy");
    assert.equal(health.criticalIncidentCount, 1);
    assert.equal(health.activeIncidentCount, 1, "the human escalation must be excluded from this total, leaving only the real critical incident");
    assert.equal(health.humanEscalationCount, 1);
  } finally {
    await service.from("automation_incidents").delete().eq("organization_id", mixedOrgId);
    await service.from("organizations").delete().eq("id", mixedOrgId);
  }
});
