/**
 * Agency client delivery (lib/agency/delivery.ts): the task gate, readiness
 * checks (Passed / Failed / Unverified - never Passed without evidence),
 * live-health display (never "healthy" when unlinked, unmanaged or
 * unreadable), next actions, and input parsing. The database rules
 * themselves are proven by supabase/pending/scratch/validate-agency-client-delivery.mjs.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agency/delivery.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeHealth,
  isDateKey,
  isOverdue,
  launchBlockers,
  liveHealth,
  nextActions,
  parseCustomTask,
  parseModules,
  readinessChecks,
  taskGate,
  todayKey,
  unverifiedChecks,
  type DeliveryClient,
  type DeliveryTask,
  type LinkedSignals,
  type ReadinessCheck,
} from "./delivery";
import type { OrganizationHealthSummary } from "@/lib/automation-health/types";
import type { SetupChecklist } from "@/lib/onboarding/checklist";

const client = (o: Partial<DeliveryClient> = {}): DeliveryClient => ({
  id: "c1",
  name: "Acme Roofing",
  contactName: "Dana",
  contactEmail: "dana@example.com",
  contactPhone: null,
  setupFee: 2500,
  monthlyFee: 1497,
  currency: "USD",
  scope: "Lead response and texting",
  status: "onboarding",
  statusChangedAt: "2026-10-01T00:00:00Z",
  ownerUserId: null,
  targetLaunchDate: null,
  services: ["sms"],
  onboardingStartedAt: "2026-10-01T00:00:00Z",
  launchedAt: null,
  launchedBy: null,
  organizationId: null,
  organizationLinkedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...o,
});
let n = 0;
const task = (o: Partial<DeliveryTask> = {}): DeliveryTask => ({
  id: `t${++n}`,
  clientId: "c1",
  templateKey: null,
  module: "core",
  category: "other",
  title: `Task ${n}`,
  description: null,
  required: true,
  waitingOn: "agency",
  status: "todo",
  blockedReason: null,
  wontDoReason: null,
  ownerUserId: null,
  dueDate: null,
  sortOrder: 10,
  completedAt: null,
  completedBy: null,
  updatedAt: "2026-10-01T00:00:00Z",
  ...o,
});
const done = (o: Partial<DeliveryTask> = {}) => task({ status: "done", completedAt: "2026-10-02T00:00:00Z", completedBy: "u1", ...o });
const allDone = () => [done({ templateKey: "core.end_to_end_test" }), done({ templateKey: "core.client_acceptance", waitingOn: "client" }), done()];
const health = (o: Partial<OrganizationHealthSummary> = {}): OrganizationHealthSummary => ({
  organizationId: "o1",
  status: "healthy",
  activeIncidentCount: 0,
  criticalIncidentCount: 0,
  warningIncidentCount: 0,
  infoIncidentCount: 0,
  stuckExecutionCount: 0,
  smsDeliveryFailureCount: 0,
  humanEscalationCount: 0,
  failedWorkflowExecutions: 0,
  automationSuccessRate: null,
  lastSuccessfulActivityAt: null,
  lastFailureAt: null,
  paymentStatus: "active",
  automationPaused: false,
  staleScheduledAutomationCount: 0,
  incidentsUnavailable: false,
  generatedAt: "2026-10-09T00:00:00Z",
  ...o,
});
const checklist = (complete: Record<string, boolean>): SetupChecklist =>
  ({
    stage: "testing",
    items: Object.entries(complete).map(([key, c]) => ({ key, label: key, complete: c, state: c ? "ready" : "not_ready" })),
    readiness: {},
    testLeadOutcome: null,
  }) as unknown as SetupChecklist;
const linked = (o: Partial<Extract<LinkedSignals, { kind: "linked" }>> = {}): LinkedSignals => ({
  kind: "linked",
  organizationId: "o1",
  organizationName: "Acme Trackpr",
  health: health(),
  checklist: checklist({ testVerified: true, sms: true, leadCapture: true, calendar: true }),
  paymentStatus: "active",
  paused: false,
  ...o,
});
const byKey = (checks: ReadinessCheck[], key: string) => checks.find((c) => c.key === key);

test("task gate: every required task done and nothing blocked - optional tasks and wont_do don't hold it, a blocked optional task does", () => {
  assert.equal(taskGate([]).passes, false, "no tasks is not ready");
  assert.equal(taskGate([done(), task({ required: false })]).passes, true);
  assert.equal(taskGate([done(), task()]).passes, false);
  assert.equal(taskGate([done(), task({ required: false, status: "wont_do", wontDoReason: "n/a" })]).passes, true);
  const blockedOptional = taskGate([done(), task({ required: false, status: "blocked", blockedReason: "waiting" })]);
  assert.equal(blockedOptional.passes, false);
  assert.equal(blockedOptional.blocked.length, 1);
  const g = taskGate([done(), task(), task({ required: false, waitingOn: "client" }), done({ waitingOn: "client" })]);
  assert.deepEqual([g.requiredTotal, g.requiredDone, g.clientInputsOpen.length], [3, 2, 1]);
});

test("readiness without a linked account: task checks from tasks; every account check Unverified - no Trackpr account linked; never Passed", () => {
  const checks = readinessChecks(client({ services: ["sms", "lead_response", "booking", "online_payments", "crm"] }), allDone(), { kind: "not_linked" });
  for (const key of ["required_tasks", "blockers", "client_inputs", "testing"]) assert.equal(byKey(checks, key)?.status, "passed", key);
  const account = checks.filter((c) => !["required_tasks", "blockers", "client_inputs", "testing"].includes(c.key));
  assert.deepEqual(
    account.map((c) => c.key),
    ["trackpr_account", "payment_status", "automation_health", "module_sms", "module_lead_response", "module_booking", "module_online_payments"],
  );
  for (const c of account) {
    assert.equal(c.status, "unverified", c.key);
    assert.equal(c.detail, "Unverified - no Trackpr account linked");
    assert.equal(c.critical, false);
  }
  assert.equal(launchBlockers(checks).length, 0);
  assert.equal(unverifiedChecks(checks).length, 7);
});

test("readiness: an unmanaged or unreadable link reads as Unverified with its own reason", () => {
  const notManaged = readinessChecks(client(), allDone(), { kind: "not_managed", organizationId: "o1" });
  assert.equal(byKey(notManaged, "trackpr_account")?.status, "unverified");
  assert.match(byKey(notManaged, "trackpr_account")?.detail ?? "", /isn't Agency-managed/);
  const unavailable = readinessChecks(client(), allDone(), { kind: "unavailable", organizationId: "o1" });
  assert.equal(byKey(unavailable, "automation_health")?.status, "unverified");
  assert.match(byKey(unavailable, "automation_health")?.detail ?? "", /couldn't be read/);
});

test("readiness: task failures are critical; open required client input and missing testing block launch", () => {
  const checks = readinessChecks(client(), [done(), task({ waitingOn: "client", title: "Send logo" }), task({ status: "blocked", blockedReason: "no access", title: "Access" })], { kind: "not_linked" });
  assert.equal(byKey(checks, "required_tasks")?.status, "failed");
  assert.equal(byKey(checks, "blockers")?.status, "failed");
  assert.match(byKey(checks, "blockers")?.detail ?? "", /Access: no access/);
  assert.equal(byKey(checks, "client_inputs")?.critical, true);
  assert.equal(byKey(checks, "testing")?.status, "failed");
  assert.deepEqual(launchBlockers(checks).map((c) => c.key), ["required_tasks", "blockers", "client_inputs", "testing"]);
  const noAcceptance = readinessChecks(client(), [done({ templateKey: "core.end_to_end_test" }), task({ templateKey: "core.client_acceptance", required: false })], { kind: "not_linked" });
  assert.equal(byKey(noAcceptance, "testing")?.status, "failed", "the end-to-end test alone isn't enough - client acceptance is needed too");
  const noTest = readinessChecks(client(), [task({ templateKey: "core.end_to_end_test", required: false }), done({ templateKey: "core.client_acceptance" })], { kind: "not_linked" });
  assert.equal(byKey(noTest, "testing")?.status, "failed");
  const optionalInput = readinessChecks(client(), [...allDone(), task({ required: false, waitingOn: "client" })], { kind: "not_linked" });
  assert.equal(byKey(optionalInput, "client_inputs")?.status, "failed");
  assert.equal(byKey(optionalInput, "client_inputs")?.critical, false, "an open optional client input is shown, not blocking");
});

test("readiness with a linked, managed account: passes only on real signals; payment and unhealthy are critical", () => {
  const ok = readinessChecks(client({ services: ["sms", "lead_response", "booking"] }), allDone(), linked());
  for (const key of ["trackpr_account", "payment_status", "automation_health", "test_lead_verified", "module_sms", "module_lead_response", "module_booking"]) assert.equal(byKey(ok, key)?.status, "passed", key);
  assert.equal(launchBlockers(ok).length, 0);
  assert.equal(unverifiedChecks(ok).length, 0);

  const unpaid = readinessChecks(client(), allDone(), linked({ paymentStatus: "suspended" }));
  assert.deepEqual([byKey(unpaid, "payment_status")?.status, byKey(unpaid, "payment_status")?.critical], ["failed", true]);
  assert.deepEqual(launchBlockers(unpaid).map((c) => c.key), ["payment_status"]);

  const unhealthy = readinessChecks(client(), allDone(), linked({ health: health({ status: "unhealthy", criticalIncidentCount: 2 }) }));
  assert.deepEqual([byKey(unhealthy, "automation_health")?.status, byKey(unhealthy, "automation_health")?.critical], ["failed", true]);
  const degraded = readinessChecks(client(), allDone(), linked({ health: health({ status: "degraded", activeIncidentCount: 1 }) }));
  assert.deepEqual([byKey(degraded, "automation_health")?.status, byKey(degraded, "automation_health")?.critical], ["failed", false]);

  const smsMissing = readinessChecks(client(), allDone(), linked({ checklist: checklist({ testVerified: false, sms: false }) }));
  assert.equal(byKey(smsMissing, "module_sms")?.status, "failed");
  assert.equal(byKey(smsMissing, "test_lead_verified")?.status, "failed");
});

test("readiness with a linked account: unreadable health, payment or checklist is Unverified, never Passed; online payments always Unverified", () => {
  const checks = readinessChecks(client({ services: ["sms", "online_payments"] }), allDone(), linked({ health: null, paymentStatus: null, checklist: null }));
  for (const key of ["payment_status", "automation_health", "test_lead_verified", "module_sms", "module_online_payments"]) assert.equal(byKey(checks, key)?.status, "unverified", key);
  const incidentsUnreadable = readinessChecks(client(), allDone(), linked({ health: health({ incidentsUnavailable: true }) }));
  assert.equal(byKey(incidentsUnreadable, "automation_health")?.status, "unverified");
  const onlyPaymentsUnverified = readinessChecks(client({ services: ["online_payments"] }), allDone(), linked());
  assert.deepEqual(unverifiedChecks(onlyPaymentsUnverified).map((c) => c.key), ["module_online_payments"]);
});

test("live health: not linked, not managed and unreadable are never healthy; each status names its reason and next step", () => {
  assert.equal(liveHealth({ kind: "not_linked" }).label, "Unverified");
  assert.equal(liveHealth({ kind: "not_managed", organizationId: "o1" }).label, "Unverified");
  assert.equal(liveHealth({ kind: "unavailable", organizationId: "o1" }).label, "Unavailable");
  assert.equal(liveHealth(linked({ health: null })).label, "Unavailable");
  assert.equal(liveHealth(linked({ health: health({ incidentsUnavailable: true }) })).label, "Unavailable");
  for (const s of [liveHealth({ kind: "not_linked" }), liveHealth(linked({ health: null }))]) assert.notEqual(s.tone, "success");

  assert.deepEqual(describeHealth(health()).label, "Healthy");
  const blocked = describeHealth(health({ status: "payment_blocked", paymentStatus: "payment_required" }));
  assert.equal(blocked.tone, "danger");
  assert.match(blocked.reason, /payment required/);
  const paused = describeHealth(health({ status: "paused", automationPaused: true }));
  assert.equal(paused.label, "Paused");
  assert.match(paused.nextStep, /manual decision/);
  assert.match(describeHealth(health({ status: "unhealthy", criticalIncidentCount: 1 })).reason, /^1 critical incident open\.$/);
  assert.match(describeHealth(health({ status: "degraded", activeIncidentCount: 2, staleScheduledAutomationCount: 1 })).reason, /2 open incidents; 1 scheduled automation gone quiet/);
});

test("overdue: open tasks with a due date before today only", () => {
  assert.equal(isOverdue({ dueDate: "2026-10-08", status: "todo" }, "2026-10-09"), true);
  assert.equal(isOverdue({ dueDate: "2026-10-09", status: "todo" }, "2026-10-09"), false);
  assert.equal(isOverdue({ dueDate: "2026-10-08", status: "done" }, "2026-10-09"), false);
  assert.equal(isOverdue({ dueDate: "2026-10-08", status: "wont_do" }, "2026-10-09"), false);
  assert.equal(isOverdue({ dueDate: null, status: "todo" }, "2026-10-09"), false);
});

test("next actions: blocked first, then overdue, ready, readiness, client input, not started; bounded", () => {
  const clients = [
    client({ id: "a", name: "Alpha", status: "onboarding_not_started" }),
    client({ id: "b", name: "Bravo" }),
    client({ id: "c", name: "Charlie", status: "ready_to_launch" }),
    client({ id: "d", name: "Delta" }),
    client({ id: "e", name: "Echo", status: "live" }),
  ];
  const tasks = [
    task({ clientId: "b", title: "Access", status: "blocked", blockedReason: "no login" }),
    task({ clientId: "b", title: "Logo", waitingOn: "client", dueDate: "2026-10-01" }),
    done({ clientId: "d" }),
    task({ clientId: "e", title: "Late but live", dueDate: "2026-10-01" }),
  ];
  const actions = nextActions(clients, tasks, "2026-10-09");
  assert.deepEqual(
    actions.map((a) => `${a.kind}:${a.clientName}`),
    ["blocked:Bravo", "overdue:Bravo", "overdue:Echo", "ready:Charlie", "readiness:Delta", "client_input:Bravo", "not_started:Alpha"],
  );
  assert.equal(nextActions(clients, tasks, "2026-10-09", 2).length, 2);
});

test("custom task, modules and dates are validated", () => {
  assert.equal(parseCustomTask({ title: " " }).ok, false);
  assert.equal(parseCustomTask({ title: "x".repeat(201) }).ok, false);
  assert.equal(parseCustomTask({ title: "Ok", category: "nope" }).ok, false);
  assert.equal(parseCustomTask({ title: "Ok", waitingOn: "someone" }).ok, false);
  assert.equal(parseCustomTask({ title: "Ok", dueDate: "2026-02-30" }).ok, false);
  assert.equal(parseCustomTask({ title: "Ok", description: "x".repeat(2001) }).ok, false);
  assert.deepEqual(parseCustomTask({ title: "  Order signs ", required: "on", waitingOn: "client", category: "other", dueDate: "2026-10-20" }), {
    ok: true,
    value: { title: "Order signs", description: null, category: "other", required: true, waitingOn: "client", dueDate: "2026-10-20" },
  });
  assert.equal((parseCustomTask({ title: "Ok" }) as { value: { required: boolean } }).value.required, false);

  assert.deepEqual(parseModules(["sms", "crm", "sms"]), ["crm", "sms"]);
  assert.deepEqual(parseModules([]), []);
  assert.equal(parseModules(["sms", "hacking"]), null);
  assert.equal(isDateKey("2026-13-01"), false);
  assert.equal(isDateKey("2026-10-09"), true);
  assert.equal(todayKey("America/Denver", new Date("2026-10-10T03:00:00Z")), "2026-10-09");
});
