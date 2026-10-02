/**
 * Phase 2K: automation event, workflow execution and leads-touched counts at
 * real volume against disposable TEST fixtures - 1,500 automation events
 * (100 failed and 50 pending past row 1,000; 1,100 lead events over 1,050
 * distinct leads) and 1,300 workflow executions (120 failed past row 1,000)
 * in the period, all past the API's 1,000-row cap; 300 events and 200 failed
 * executions in the previous period that must not be counted; organization
 * isolation. The snapshot checked here is exactly what Agency receives. A
 * read failure can't be induced safely on TEST; it is unit-tested in
 * automation.scale.test.ts.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/automation.scale.integration.test.ts
 *
 * Inserts are plain rows - no automation, n8n, Twilio or provider call (the
 * only trigger on these tables maintains updated_at). No execution is left
 * "running", so the automation health check never sees a stuck fixture.
 * after() deletes both fixture organizations; everything else cascades.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
require("@next/env").loadEnvConfig(REPO_ROOT, true, { info() {}, error() {} });
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("lwofqffxagxiqodqvcfr")) throw new Error("Phase 2K scale fixtures run against the TEST project only.");

const { createServiceRoleClient }: typeof import("@/lib/supabase/service") = require(path.join(REPO_ROOT, "lib/supabase/service.ts"));
const { getAutomationAndFollowUpMetrics, resolveDateRange }: typeof import("./queries") = require(path.join(REPO_ROOT, "lib/bi/queries.ts"));
const { getBusinessMetricsSnapshot }: typeof import("./metrics") = require(path.join(REPO_ROOT, "lib/bi/metrics.ts"));

const service = createServiceRoleClient();
const TZ = "UTC";
const NOW = new Date();
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const EVENT_TYPES = ["lead.lost_nurture", "lead.reactivation", "estimate.followup", "job.post_followup", "appointment.reminder"];
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const LEAD_IDS = range(1050).map(() => randomUUID());
let orgA = "";
let orgB = "";

async function insertAll(table: string, rows: Record<string, unknown>[], columns = "id"): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await service.from(table).insert(rows.slice(i, i + 500) as never).select(columns);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Record<string, unknown>[]));
  }
  return out;
}

before(async () => {
  const orgs = await insertAll("organizations", [{ name: "Phase 2K Automation Scale Test Org A", timezone: TZ }, { name: "Phase 2K Automation Scale Test Org B", timezone: TZ }], "id, name");
  orgA = orgs.find((o) => String(o.name).endsWith("A"))!.id as string;
  orgB = orgs.find((o) => String(o.name).endsWith("B"))!.id as string;

  await insertAll("automation_events", [
    // The period: 1,500 events, types cycling; the first 1,100 are lead events over 1,050 distinct leads.
    ...range(1500).map((i) => ({
      organization_id: orgA,
      event_type: EVENT_TYPES[i % 5],
      entity_type: i < 1100 ? "lead" : "appointment",
      entity_id: i < 1100 ? LEAD_IDS[i % 1050] : randomUUID(),
      status: i >= 1000 && i < 1100 ? "failed" : i >= 1100 && i < 1150 ? "pending" : "completed",
      created_at: daysAgo(2),
    })),
    // The previous period - never counted.
    ...range(300).map(() => ({ organization_id: orgA, event_type: "lead.reactivation", entity_type: "lead", entity_id: randomUUID(), status: "failed", created_at: daysAgo(40) })),
  ]);
  await insertAll("workflow_executions", [
    ...range(1300).map((i) => ({ organization_id: orgA, workflow_name: ["lead-nurture", "estimate-followup"][i % 2], status: i >= 1000 && i < 1120 ? "failed" : i >= 1120 && i < 1150 ? "cancelled" : "completed", started_at: daysAgo(2) })),
    ...range(200).map(() => ({ organization_id: orgA, workflow_name: "lead-nurture", status: "failed", started_at: daysAgo(40) })),
  ]);

  await insertAll("automation_events", range(3).map(() => ({ organization_id: orgB, event_type: "lead.reactivation", entity_type: "lead", entity_id: randomUUID(), status: "completed", created_at: daysAgo(2) })));
  await insertAll("workflow_executions", [
    { organization_id: orgB, workflow_name: "lead-nurture", status: "completed", started_at: daysAgo(2) },
    { organization_id: orgB, workflow_name: "lead-nurture", status: "failed", started_at: daysAgo(2) },
  ]);
});

after(async () => {
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    const { error } = await service.from("organizations").delete().eq("id", orgId);
    if (error) console.error(`PHASE2K_FIXTURE_CLEANUP_FAILED=${orgId}: ${error.message}`);
  }
});

test("1,500 events and 1,300 executions in the period: exact status, type and workflow counts - failed executions past row 1,000 included", async () => {
  const { automation: a, followUp: f, failed } = await getAutomationAndFollowUpMetrics(service, orgA, resolveDateRange("last30Days", NOW, TZ));
  assert.equal(failed, false);
  assert.deepEqual([a.totalAutomationEvents, a.completedAutomationEvents, a.failedAutomationEvents, a.pendingAutomationEvents], [1500, 1350, 100, 50], "the previous period's 300 failed events are never counted");
  assert.deepEqual(a.automationEventsByType, Object.fromEntries(EVENT_TYPES.map((t) => [t, 300])));
  assert.deepEqual([a.totalWorkflowExecutions, a.completedWorkflows, a.failedWorkflows, a.cancelledWorkflows, a.runningWorkflows], [1300, 1150, 120, 30, 0], "the previous period's 200 failed executions are never counted");
  assert.deepEqual(a.workflowExecutionsByName, { "lead-nurture": 650, "estimate-followup": 650 });
  assert.deepEqual([f.leadLostNurtureEvents, f.leadReactivationEvents, f.estimateFollowupEvents, f.postJobFollowupEvents, f.appointmentAutomationEvents], [300, 300, 300, 300, 400]);
});

test("the snapshot Agency receives: complete automation figures, 1,050 distinct leads touched; nothing unavailable", async () => {
  const s = await getBusinessMetricsSnapshot(service, orgA, "last30Days", { timeZone: TZ, now: NOW });
  assert.equal(s.automationUnavailable, false);
  const m = s.automationMetrics;
  assert.deepEqual([m.automationEvents, m.workflowExecutions, m.successfulWorkflowExecutions, m.failedWorkflowExecutions, m.automationSuccessRate], [1500, 1300, 1150, 120, (1150 / 1270) * 100]);
  assert.deepEqual([s.followUpMetrics.leadsTouchedByAutomation, s.followUpMetrics.appointmentReminderEvents], [1050, 300]);
  assert.ok(!s.dataQuality.notes.some((n) => n.startsWith("Automation and follow-up counts could not be read")));
});

test("organization isolation: B sees only its own events, executions and leads", async () => {
  const s = await getBusinessMetricsSnapshot(service, orgB, "last30Days", { timeZone: TZ, now: NOW });
  assert.deepEqual([s.automationMetrics.automationEvents, s.automationMetrics.workflowExecutions, s.automationMetrics.failedWorkflowExecutions, s.followUpMetrics.leadsTouchedByAutomation, s.automationUnavailable], [3, 2, 1, 3, false]);
});
