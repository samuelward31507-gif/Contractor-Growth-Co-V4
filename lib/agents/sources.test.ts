/**
 * Agent Operating Layer: input projections and optional persistence.
 * The projections are fed from the real decision assembler over the
 * existing Today parity fixture, so the Sales agent reads exactly what
 * Today shows. Persistence is exercised against a fake client - it is off
 * unless explicitly enabled and never throws. Pure: no network, no database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agents/sources.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const load = <T>(p: string): T => require(path.join(ROOT, p));
const { assembleDecisions } = load<typeof import("../decisions/assemble")>("lib/decisions/assemble.ts");
const { buildParityFixture } = load<typeof import("../decisions/assemble.fixture")>("lib/decisions/assemble.fixture.ts");
const { projectSalesInput, projectIncidents, projectQaInput } = load<typeof import("./sources")>("lib/agents/sources.ts");
const { analyzeSales } = load<typeof import("./agents/sales")>("lib/agents/agents/sales.ts");
const { AgentOutputSchema } = load<typeof import("./contract")>("lib/agents/contract.ts");
const persistence = load<typeof import("./persistence")>("lib/agents/persistence.ts");
const fx = load<typeof import("./test-fixtures")>("lib/agents/test-fixtures.ts");

test("sales projection mirrors Today's decisions and carries no contact details", () => {
  const fixture = buildParityFixture(fx.NOW.getTime());
  const decisions = assembleDecisions({ ...fixture, context: undefined });
  const input = projectSalesInput(decisions, fixture.prioritizedOpportunities);

  assert.equal(input.exceptions.length, decisions.exceptions.length);
  assert.equal(input.attention.length, decisions.attention.length);
  assert.equal(input.opportunities.length, decisions.opportunities.length);
  assert.deepEqual(input.attention.map((i) => i.key), decisions.attention.map((i) => i.key));

  const serialized = JSON.stringify(input);
  for (const item of [...decisions.attention, ...decisions.opportunities]) {
    if (item.phone) assert.equal(serialized.includes(item.phone), false, "phone numbers never reach an agent");
  }
  assert.ok(Object.keys(input.attention[0]).every((k) => ["key", "reasonCode", "tier", "act", "actor", "missedFollowUp", "name", "actionHref", "value"].includes(k)));

  // A known opportunity value is carried as a number for the agent to rank by.
  const projectedItems = [...input.attention, ...input.opportunities];
  const valuedProjected = projectedItems.filter((i) => i.value != null);
  assert.ok(valuedProjected.length > 0, "the fixture has opportunities with a known value");
  for (const item of valuedProjected) {
    const source = fixture.prioritizedOpportunities.find((p) => item.key.endsWith(p.opportunity.id));
    assert.equal(item.value, source?.opportunity.estimatedValue);
  }

  // And the Sales agent produces a valid output over it.
  assert.equal(AgentOutputSchema.safeParse(analyzeSales(input)).success, true);
});

test("an action link that is not an in-app path is replaced by /today", () => {
  const fixture = buildParityFixture(fx.NOW.getTime());
  const decisions = assembleDecisions({ ...fixture, context: undefined });
  decisions.attention[0] = { ...decisions.attention[0], nextAction: { ...decisions.attention[0].nextAction, href: "https://evil.example" } };
  assert.equal(projectSalesInput(decisions, []).attention[0].actionHref, "/today");
});

test("incident projection keeps only active incidents and drops metadata", () => {
  const base = { organizationId: "o", automationId: null, workflowExecutionId: null, fingerprint: "fp", description: "secret detail", firstSeenAt: "", lastSeenAt: "2026-10-05T00:00:00Z", occurrenceCount: 2, resolvedAt: null, resolvedBy: null, acknowledgedAt: null, acknowledgedBy: null, metadata: { token: "abc" }, createdAt: "", updatedAt: "" };
  const projected = projectIncidents([
    { ...base, id: "a", category: "n8n_callback_failed", severity: "warning", status: "open", title: "A" },
    { ...base, id: "b", category: "workflow_failed", severity: "critical", status: "resolved", title: "B" },
  ]);
  assert.deepEqual(projected.map((i) => i.id), ["a"]);
  assert.equal(JSON.stringify(projected).includes("abc"), false);
  assert.equal(JSON.stringify(projected).includes("secret detail"), false);
});

test("qa projection detects a calendar disconnect from Today's exceptions", () => {
  const fixture = buildParityFixture(fx.NOW.getTime());
  const decisions = assembleDecisions({ ...fixture, context: undefined });
  const health = { organizationId: "o", status: "healthy", activeIncidentCount: 0, criticalIncidentCount: 0, warningIncidentCount: 0, infoIncidentCount: 0, stuckExecutionCount: 0, smsDeliveryFailureCount: 0, humanEscalationCount: 0, failedWorkflowExecutions: 0, automationSuccessRate: null, lastSuccessfulActivityAt: null, lastFailureAt: null, paymentStatus: "active", automationPaused: false, staleScheduledAutomationCount: 0, incidentsUnavailable: false, generatedAt: "" } as const;
  assert.equal(projectQaInput(health, [], "live", decisions).calendarDisconnected, decisions.exceptions.some((e) => e.reasonCode === "calendar_sync_failed"));
  assert.equal(projectQaInput(health, [], "live", null).calendarDisconnected, false);
});

test("persistence is off by default and only on for exactly TRACKPR_AGENT_RUN_PERSISTENCE=on", async () => {
  assert.equal(persistence.agentRunPersistenceEnabled({}), false);
  assert.equal(persistence.agentRunPersistenceEnabled({ TRACKPR_AGENT_RUN_PERSISTENCE: "true" }), false);
  assert.equal(persistence.agentRunPersistenceEnabled({ TRACKPR_AGENT_RUN_PERSISTENCE: "on" }), true);
  let touched = false;
  const client = { from: () => ((touched = true), { insert: async () => ({ error: null }) }) };
  const outcome = await persistence.persistAgentRuns(client as never, { organizationId: "o", userId: "u", results: [fx.validResult()] }, {});
  assert.deepEqual(outcome, { persisted: false, reason: "disabled" });
  assert.equal(touched, false, "disabled persistence never touches the database");
});

test("persistence writes one traceable row per agent to agent_runs only, and never throws", async () => {
  const calls: { table: string; rows: unknown[] }[] = [];
  const client = { from: (table: string) => ({ insert: async (rows: unknown[]) => (calls.push({ table, rows }), { error: null }) }) };
  const results = [fx.validResult(), fx.validResult({ agent: "qa_health", runId: "33333333-3333-4333-8333-333333333333" })];
  const ok = await persistence.persistAgentRuns(client as never, { organizationId: "org-1", userId: "user-1", results }, { TRACKPR_AGENT_RUN_PERSISTENCE: "on" });
  assert.deepEqual(ok, { persisted: true, rows: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, "agent_runs");
  const rows = calls[0].rows as import("./persistence").AgentRunRow[];
  assert.ok(rows.every((r) => r.trace_id === fx.TRACE_ID && r.organization_id === "org-1" && r.created_by === "user-1"));
  assert.deepEqual(rows.map((r) => r.agent_id), ["sales", "qa_health"]);

  const failing = { from: () => ({ insert: async () => ({ error: { message: "relation does not exist" } }) }) };
  assert.deepEqual(await persistence.persistAgentRuns(failing as never, { organizationId: "o", userId: "u", results }, { TRACKPR_AGENT_RUN_PERSISTENCE: "on" }), { persisted: false, reason: "insert_failed" });
  const throwing = { from: () => { throw new Error("network down"); } };
  assert.deepEqual(await persistence.persistAgentRuns(throwing as never, { organizationId: "o", userId: "u", results }, { TRACKPR_AGENT_RUN_PERSISTENCE: "on" }), { persisted: false, reason: "insert_failed" });
});
