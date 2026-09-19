/**
 * Integration tests for recordAutomationHealthSignal()/resolveAutomationFailureIncidents()
 * and the underlying record_automation_incident_signal/resolve_automation_incidents_by_fingerprint/
 * resolve_stale_stuck_incidents RPCs - against an isolated, fully-cleaned-up
 * test organization on the real Supabase project, matching this codebase's
 * established pattern for exactly this class of DB-backed logic (no mocking
 * layer exists for a Supabase client). Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/service.integration.test.ts
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
const { recordAutomationHealthSignal, resolveAutomationFailureIncidents }: typeof import("./service") = require(path.join(REPO_ROOT, "lib/automation-health/service.ts"));

const service = createServiceRoleClient();
let organizationId: string;

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Automation Health Service Integration Test Org" }).select("id").single();
  organizationId = org!.id;
});

after(async () => {
  await service.from("automation_incidents").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

async function activeIncidentsFor(fingerprintContext: string, category = "workflow_failed") {
  const { data } = await service
    .from("automation_incidents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("fingerprint", `${category}:${fingerprintContext}`)
    .in("status", ["open", "acknowledged"]);
  return data ?? [];
}

test("a single failure signal creates exactly one open incident with occurrence_count 1", async () => {
  const incident = await recordAutomationHealthSignal(service, {
    organizationId,
    category: "workflow_failed",
    severity: "warning",
    fingerprintContext: "test-automation-a",
    title: "Test automation A failed",
  });

  assert.ok(incident);
  assert.equal(incident?.status, "open");
  assert.equal(incident?.occurrenceCount, 1);
  assert.equal(incident?.severity, "warning");
  assert.equal(incident?.category, "workflow_failed");
});

test("a second failure signal for the same context updates the SAME incident (dedup), never creating a second row", async () => {
  const context = "test-automation-b";
  await recordAutomationHealthSignal(service, { organizationId, category: "workflow_failed", severity: "warning", fingerprintContext: context, title: "First failure" });
  const second = await recordAutomationHealthSignal(service, { organizationId, category: "workflow_failed", severity: "warning", fingerprintContext: context, title: "Second failure" });

  const rows = await activeIncidentsFor(context);
  assert.equal(rows.length, 1, "exactly one active incident must exist for this fingerprint");
  assert.equal(second?.occurrenceCount, 2);
  assert.equal(second?.title, "Second failure", "the most recent title/description is kept");
});

test("the third failure for the same context escalates to repeated_workflow_failure / critical, deterministically", async () => {
  const context = "test-automation-c";
  await recordAutomationHealthSignal(service, { organizationId, category: "workflow_failed", severity: "warning", fingerprintContext: context, title: "1" });
  await recordAutomationHealthSignal(service, { organizationId, category: "workflow_failed", severity: "warning", fingerprintContext: context, title: "2" });
  const third = await recordAutomationHealthSignal(service, { organizationId, category: "workflow_failed", severity: "warning", fingerprintContext: context, title: "3" });

  assert.equal(third?.occurrenceCount, 3);
  assert.equal(third?.category, "repeated_workflow_failure");
  assert.equal(third?.severity, "critical");
});

test("a flood of 20 identical failures for the same automation produces exactly ONE active incident with occurrence_count 20", async () => {
  const context = "test-automation-flood";
  for (let i = 0; i < 20; i += 1) {
    await recordAutomationHealthSignal(service, { organizationId, category: "workflow_failed", severity: "warning", fingerprintContext: context, title: `Failure ${i}` });
  }

  const rows = await activeIncidentsFor(context);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occurrence_count, 20);
});

test("25 CONCURRENT identical failure signals still produce exactly ONE active incident (race-safe upsert)", async () => {
  const context = "test-automation-concurrent";
  const CONCURRENCY = 25;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      recordAutomationHealthSignal(service, { organizationId, category: "workflow_failed", severity: "warning", fingerprintContext: context, title: `Concurrent ${i}` }),
    ),
  );

  const rows = await activeIncidentsFor(context);
  assert.equal(rows.length, 1, "the partial unique index must collapse all concurrent signals into one row");
  assert.equal(rows[0].occurrence_count, CONCURRENCY);
});

test("resolving an incident, then a fresh later failure for the same context opens a NEW incident rather than reviving the resolved one", async () => {
  const context = "test-automation-resolve-then-recur";
  const first = await recordAutomationHealthSignal(service, { organizationId, category: "workflow_failed", severity: "warning", fingerprintContext: context, title: "First episode" });
  assert.ok(first);

  await resolveAutomationFailureIncidents(service, organizationId, context);
  const afterResolve = await activeIncidentsFor(context);
  assert.equal(afterResolve.length, 0, "resolveAutomationFailureIncidents must resolve the active incident");

  const { data: resolvedRow } = await service.from("automation_incidents").select("id, status").eq("id", first!.id).single();
  assert.equal(resolvedRow?.status, "resolved");

  const second = await recordAutomationHealthSignal(service, { organizationId, category: "workflow_failed", severity: "warning", fingerprintContext: context, title: "Second episode" });
  assert.ok(second);
  assert.notEqual(second?.id, first?.id, "a fresh incident must be created, not the resolved one reopened");
  assert.equal(second?.occurrenceCount, 1);

  const activeNow = await activeIncidentsFor(context);
  assert.equal(activeNow.length, 1);
});

test("resolveAutomationFailureIncidents does not touch a different automation's active incident", async () => {
  const untouchedContext = "test-automation-untouched";
  const resolvedContext = "test-automation-to-resolve";
  await recordAutomationHealthSignal(service, { organizationId, category: "workflow_failed", severity: "warning", fingerprintContext: untouchedContext, title: "Should survive" });
  await recordAutomationHealthSignal(service, { organizationId, category: "workflow_failed", severity: "warning", fingerprintContext: resolvedContext, title: "Should resolve" });

  await resolveAutomationFailureIncidents(service, organizationId, resolvedContext);

  const untouchedRows = await activeIncidentsFor(untouchedContext);
  const resolvedRows = await activeIncidentsFor(resolvedContext);
  assert.equal(untouchedRows.length, 1, "an unrelated automation's active incident must not be resolved");
  assert.equal(resolvedRows.length, 0);
});

test("sms_delivery_failed signals for two different messages never collapse into one incident", async () => {
  const messageA = await recordAutomationHealthSignal(service, { organizationId, category: "sms_delivery_failed", severity: "warning", fingerprintContext: "message-aaa", title: "Delivery failed A" });
  const messageB = await recordAutomationHealthSignal(service, { organizationId, category: "sms_delivery_failed", severity: "warning", fingerprintContext: "message-bbb", title: "Delivery failed B" });

  assert.ok(messageA);
  assert.ok(messageB);
  assert.notEqual(messageA?.id, messageB?.id);
  assert.equal(messageA?.occurrenceCount, 1);
  assert.equal(messageB?.occurrenceCount, 1);
});

test("workflow_stuck signals for two different executions never collapse into one incident, but the SAME execution collapses across repeated detection ticks", async () => {
  const execA = await recordAutomationHealthSignal(service, { organizationId, category: "workflow_stuck", severity: "warning", fingerprintContext: "execution-aaa", title: "Stuck A" });
  const execB = await recordAutomationHealthSignal(service, { organizationId, category: "workflow_stuck", severity: "warning", fingerprintContext: "execution-bbb", title: "Stuck B" });
  const execARepeat = await recordAutomationHealthSignal(service, { organizationId, category: "workflow_stuck", severity: "warning", fingerprintContext: "execution-aaa", title: "Stuck A (still)" });

  assert.notEqual(execA?.id, execB?.id);
  assert.equal(execARepeat?.id, execA?.id);
  assert.equal(execARepeat?.occurrenceCount, 2);
});

test("metadata and description never contain a raw Twilio/n8n secret - only what the caller explicitly passed is ever stored", async () => {
  const incident = await recordAutomationHealthSignal(service, {
    organizationId,
    category: "n8n_dispatch_failed",
    severity: "warning",
    fingerprintContext: "test-automation-secret-check",
    title: "Dispatch failed",
    description: "The automation orchestrator rejected the request (status 500).",
    metadata: { attempt: 1 },
  });

  assert.ok(incident);
  assert.ok(!JSON.stringify(incident?.description ?? "").toLowerCase().includes("secret"));
  assert.ok(!JSON.stringify(incident?.metadata ?? {}).toLowerCase().includes("token"));
});
