/**
 * Integration tests proving failWorkflowExecution/failWorkflowExecutionAsService/
 * completeWorkflowExecution/completeWorkflowExecutionAsService (lib/automation/
 * executions.ts) actually record and resolve Automation Health + Alerting V1
 * incidents end-to-end, through the real production code path - not just the
 * lib/automation-health/service.ts building blocks in isolation (see that
 * module's own service.integration.test.ts). Against an isolated,
 * fully-cleaned-up test organization on the real Supabase project. Run with:
 *
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation/executions-health.integration.test.ts
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
const { startWorkflowExecutionAsService, failWorkflowExecutionAsService, completeWorkflowExecutionAsService }: typeof import("./executions") = require(
  path.join(REPO_ROOT, "lib/automation/executions.ts"),
);

const service = createServiceRoleClient();
let organizationId: string;

async function makeEventAndExecution(workflowName: string) {
  const { data: event } = await service
    .from("automation_events")
    .insert({ organization_id: organizationId, event_type: "lead.created", entity_type: "lead", entity_id: null, payload: {} })
    .select("id")
    .single();
  const started = await startWorkflowExecutionAsService(service, event!.id, workflowName);
  if (!started.ok) throw new Error(`failed to start execution: ${started.error}`);
  return started.execution.id;
}

async function activeIncidentFor(automationId: string, category: string) {
  const { data } = await service
    .from("automation_incidents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("fingerprint", `${category}:${automationId}`)
    .in("status", ["open", "acknowledged"])
    .maybeSingle();
  return data;
}

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Executions Health Wiring Integration Test Org" }).select("id").single();
  organizationId = org!.id;
});

after(async () => {
  await service.from("automation_incidents").delete().eq("organization_id", organizationId);
  await service.from("workflow_executions").delete().eq("organization_id", organizationId);
  await service.from("automation_events").delete().eq("organization_id", organizationId);
  await service.from("organizations").delete().eq("id", organizationId);
});

test("failWorkflowExecutionAsService with category 'n8n_dispatch_failed' records an n8n_dispatch_failed incident attributed to the real catalog automation", async () => {
  const executionId = await makeEventAndExecution("lead_created_followup");
  const result = await failWorkflowExecutionAsService(service, executionId, "The automation orchestrator rejected the request (status 500).", "n8n_dispatch_failed");
  assert.equal(result.ok, true);

  const incident = await activeIncidentFor("instant-lead-followup", "n8n_dispatch_failed");
  assert.ok(incident, "a real n8n_dispatch_failed incident must exist for instant-lead-followup");
  assert.equal(incident.workflow_execution_id, executionId);
});

test("failWorkflowExecutionAsService with category 'sms_send_failed' records an sms_send_failed incident", async () => {
  const executionId = await makeEventAndExecution("lead_created_followup");
  await failWorkflowExecutionAsService(service, executionId, "The SMS provider rejected the request.", "sms_send_failed");

  const incident = await activeIncidentFor("instant-lead-followup", "sms_send_failed");
  assert.ok(incident);
});

test("a subsequent successful completion of the same automation resolves its active failure incidents", async () => {
  const failedExecutionId = await makeEventAndExecution("lead_created_followup");
  await failWorkflowExecutionAsService(service, failedExecutionId, "Could not reach the automation orchestrator.", "n8n_dispatch_failed");

  const openIncident = await activeIncidentFor("instant-lead-followup", "n8n_dispatch_failed");
  assert.ok(openIncident, "precondition: the failure incident must be open before the successful completion");

  const succeededExecutionId = await makeEventAndExecution("lead_created_followup");
  const completed = await completeWorkflowExecutionAsService(service, succeededExecutionId, { should_send: false });
  assert.equal(completed.ok, true);

  const stillOpen = await activeIncidentFor("instant-lead-followup", "n8n_dispatch_failed");
  assert.equal(stillOpen, null, "a successful completion must resolve the automation's active failure incident");
});

test("a failure on one automation never resolves or affects a different automation's active incident", async () => {
  const executionId = await makeEventAndExecution("appointment_created_followup");
  await failWorkflowExecutionAsService(service, executionId, "Could not reach the automation orchestrator.", "n8n_dispatch_failed");
  const unrelatedIncident = await activeIncidentFor("appointment-lifecycle", "n8n_dispatch_failed");
  assert.ok(unrelatedIncident);

  // A successful completion of a COMPLETELY different automation must not touch it.
  const otherExecutionId = await makeEventAndExecution("lead_created_followup");
  await completeWorkflowExecutionAsService(service, otherExecutionId, { should_send: false });

  const stillThere = await activeIncidentFor("appointment-lifecycle", "n8n_dispatch_failed");
  assert.ok(stillThere, "an unrelated automation's incident must survive a different automation's success");
});

// ==================== Trackpr 2.0, n8n dispatch timeout fix ====================
//
// The confirmed production defect: a dispatch-side timeout (triggerN8nWorkflow's
// own fetch() aborting - see lib/automation/n8n.ts) raced against a real,
// already-successful callback completion for the SAME execution, and the
// stale timeout won, leaving a genuinely successful workflow recorded as
// "failed" with a real, misleading incident. These tests simulate the
// callback side of that race directly (completeWorkflowExecutionAsService
// landing first) and prove failWorkflowExecutionAsService can no longer
// overwrite it - never touching n8n or triggerN8nWorkflow itself.

test("4a. a dispatch-timeout failure arriving AFTER the callback already completed the execution never overwrites it, and never creates a false incident", async () => {
  const executionId = await makeEventAndExecution("lead_created_followup");

  const completed = await completeWorkflowExecutionAsService(service, executionId, { should_send: false });
  assert.equal(completed.ok, true);

  // Simulates the stale dispatch-side timeout handler running after the
  // real callback already won the race.
  const staleFailure = await failWorkflowExecutionAsService(service, executionId, "Could not reach the automation orchestrator.", "n8n_dispatch_failed");
  assert.equal(staleFailure.ok, true, "the stale failure attempt must be treated as a benign no-op, never a hard error");
  if (staleFailure.ok) assert.equal(staleFailure.execution.status, "completed", "the execution's real, already-recorded outcome must be preserved, never overwritten");

  const { data: row } = await service.from("workflow_executions").select("status, error_message").eq("id", executionId).single();
  assert.equal(row!.status, "completed");
  assert.equal(row!.error_message, null, "no failure error message must ever be written onto an execution a real callback already completed");

  const falseIncident = await activeIncidentFor("instant-lead-followup", "n8n_dispatch_failed");
  assert.equal(falseIncident, null, "a stale timeout racing against a real success must never create a misleading incident");
});

test("4b. two genuinely concurrent failure attempts for the same execution never double-record - the second is a safe no-op", async () => {
  const executionId = await makeEventAndExecution("lead_created_followup");

  const first = await failWorkflowExecutionAsService(service, executionId, "Could not reach the automation orchestrator.", "n8n_dispatch_failed");
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.execution.status, "failed");

  const second = await failWorkflowExecutionAsService(service, executionId, "Could not reach the automation orchestrator.", "n8n_dispatch_failed");
  assert.equal(second.ok, true, "a second, redundant failure attempt for an already-failed execution must be a safe no-op, not an error");
  if (second.ok) assert.equal(second.execution.status, "failed");

  const { data: row } = await service.from("workflow_executions").select("error_message").eq("id", executionId).single();
  assert.equal(row!.error_message, "Could not reach the automation orchestrator.", "the original failure's error message must be preserved, not silently replaced");
});

test("4c. the normal, expected case - a genuinely still-running execution is still correctly recorded as failed", async () => {
  const executionId = await makeEventAndExecution("lead_created_followup");

  const result = await failWorkflowExecutionAsService(service, executionId, "The automation orchestrator rejected the request (status 503).", "n8n_dispatch_failed");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.execution.status, "failed", "a genuinely running execution that really does fail must still be recorded as failed - this fix must never mask a real failure");

  const incident = await activeIncidentFor("instant-lead-followup", "n8n_dispatch_failed");
  assert.ok(incident, "a real failure must still create a real incident");
});
