/**
 * Performance Pass 3: computeOrganizationHealth() reads its inputs with ONE
 * call to organization_health_inputs (supabase/migrations/20260930044405_organization_health_inputs.sql)
 * instead of six PostgREST requests. Unit-level proof of the call shape and
 * of the mapping from the function's jsonb to the summary; end-to-end parity
 * with the old six-read implementation against the real schema is proven by
 * supabase/pending/scratch/validate-organization-health-sql.mjs.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/automation-health/health-inputs.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getOrganizationHealth }: typeof import("./health") = require("./health.ts");
const { resolveDateRange }: typeof import("@/lib/bi/queries") = require("../bi/queries.ts");

const ORG = "11111111-1111-4111-8111-111111111111";

function fakeClient(response: { data: unknown; error: unknown }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let fromCalls = 0;
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve(response);
    },
    from: () => {
      fromCalls += 1;
      throw new Error("computeOrganizationHealth must not read tables directly");
    },
  };
  return { client: client as unknown as Parameters<typeof getOrganizationHealth>[0], calls, fromCalls: () => fromCalls };
}

const withoutClock = <T extends { generatedAt: string }>(summary: T): Omit<T, "generatedAt"> => {
  const copy: Partial<T> = { ...summary };
  delete copy.generatedAt;
  return copy as Omit<T, "generatedAt">;
};

test("one request: organization_health_inputs with the organization and the same last-30-days window as before, no table reads", async () => {
  const { client, calls, fromCalls } = fakeClient({ data: null, error: null });
  await getOrganizationHealth(client, ORG);
  const range = resolveDateRange("last30Days");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "organization_health_inputs");
  assert.deepEqual(calls[0].args, { p_organization_id: ORG, p_executions_from: range.from, p_executions_to: range.to });
  assert.equal(fromCalls(), 0);
});

test("maps every input field into the summary", async () => {
  const recent = new Date(Date.now() - 5 * 60_000).toISOString();
  const stale = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const { client } = fakeClient({
    data: {
      window_status_counts: { completed: 3, failed: 1 },
      name_stats: [
        { workflow_name: "a", last_status: "completed", last_execution_at: "2026-10-15T10:00:00+00:00", failed: 0 },
        { workflow_name: "b", last_status: "failed", last_execution_at: "2026-10-15T11:00:00+00:00", failed: 2 },
        { workflow_name: "c", last_status: "completed", last_execution_at: "2026-10-15T09:00:00+00:00", failed: 1 },
      ],
      incidents: [
        { category: "workflow_stuck", severity: "critical" },
        { category: "sms_delivery_failed", severity: "warning" },
        { category: "human_escalation_requested", severity: "critical" },
      ],
      organization: { payment_status: "active", automation_paused: false },
      liveness: [
        { automation_id: "appointment-reminders", last_ran_at: recent, last_candidate_count: 1 },
        { automation_id: "estimate-followup", last_ran_at: stale, last_candidate_count: 0 },
      ],
    },
    error: null,
  });
  const summary = withoutClock(await getOrganizationHealth(client, ORG));
  assert.equal(summary.status, "unhealthy");
  assert.equal(summary.automationSuccessRate, 75);
  assert.equal(summary.failedWorkflowExecutions, 1);
  assert.equal(summary.lastSuccessfulActivityAt, "2026-10-15T10:00:00+00:00");
  assert.equal(summary.lastFailureAt, "2026-10-15T11:00:00+00:00");
  assert.deepEqual(
    [summary.activeIncidentCount, summary.criticalIncidentCount, summary.warningIncidentCount, summary.stuckExecutionCount, summary.smsDeliveryFailureCount, summary.humanEscalationCount],
    [2, 1, 1, 1, 1, 1],
  );
  assert.equal(summary.paymentStatus, "active");
  assert.equal(summary.automationPaused, false);
  assert.equal(summary.staleScheduledAutomationCount, 1);
});

test("a failed read (error, or no data) fails closed exactly like all six old reads failing: payment_blocked, zero counts, nothing stale", async () => {
  const failed = withoutClock(await getOrganizationHealth(fakeClient({ data: null, error: { message: "boom" } }).client, ORG));
  const empty = withoutClock(await getOrganizationHealth(fakeClient({ data: null, error: null }).client, ORG));
  assert.deepEqual(failed, empty);
  assert.equal(failed.status, "payment_blocked");
  assert.equal(failed.paymentStatus, "payment_required");
  assert.equal(failed.automationSuccessRate, null);
  assert.equal(failed.activeIncidentCount, 0);
  assert.equal(failed.staleScheduledAutomationCount, 0);
  assert.equal(failed.lastSuccessfulActivityAt, null);
});
