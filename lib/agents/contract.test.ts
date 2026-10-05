/**
 * Agent Operating Layer: the agent contract and its approval model -
 * schema validation, malformed output, in-app links, approval requirements
 * and autonomy ceilings. Pure: no network, no database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agents/contract.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const contract: typeof import("./contract") = require(path.join(ROOT, "lib/agents/contract.ts"));
const permissions: typeof import("./permissions") = require(path.join(ROOT, "lib/agents/permissions.ts"));
const registry: typeof import("./registry") = require(path.join(ROOT, "lib/agents/registry.ts"));
const { validResult }: typeof import("./test-fixtures") = require(path.join(ROOT, "lib/agents/test-fixtures.ts"));

const finding = (overrides: Record<string, unknown> = {}) => ({ id: "f1", kind: "risk", basis: "fact", severity: "high", confidence: "high", category: "c", title: "Title", detail: "Detail.", ...overrides });
const recommendation = (overrides: Record<string, unknown> = {}) => ({ id: "r1", title: "Do it", detail: "Detail.", actionKind: "review", autonomy: "recommend", requiresApproval: false, priority: "high", confidence: "high", ...overrides });

test("all seven agents are registered with the contract's fields", () => {
  assert.deepEqual(Object.keys(registry.AGENT_REGISTRY).sort(), [...contract.AGENT_IDS].sort());
  for (const definition of Object.values(registry.AGENT_REGISTRY)) {
    assert.ok(definition.name && definition.description && definition.purpose);
    assert.ok(definition.allowedDataSources.length > 0, definition.id);
    assert.equal(definition.maxAutonomy, "recommend", `${definition.id} must not exceed recommend in Phase 1`);
  }
  assert.deepEqual([...registry.SPECIALIST_AGENT_IDS].sort(), contract.AGENT_IDS.filter((id) => id !== "chief_of_staff").sort());
});

test("platform agents (prospecting, market) read no organization data source", () => {
  const orgSources = new Set(["decisions", "business_metrics", "organization_health", "automation_incidents", "automation_mode"]);
  for (const id of ["prospecting", "market_intelligence"] as const) {
    assert.equal(registry.AGENT_REGISTRY[id].scope, "platform");
    assert.ok(registry.AGENT_REGISTRY[id].allowedDataSources.every((s) => !orgSources.has(s)), id);
  }
  assert.deepEqual(registry.AGENT_REGISTRY.chief_of_staff.allowedDataSources, ["agent_results"]);
});

test("a well-formed output parses and gets defaults", () => {
  const parsed = contract.AgentOutputSchema.parse({ summary: "All good.", findings: [finding()], recommendations: [recommendation()] });
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.findings[0].evidence, []);
  assert.deepEqual(parsed.metadata, {});
});

test("malformed outputs are rejected", () => {
  const cases: [string, unknown][] = [
    ["prose instead of structure", "Everything is fine, trust me."],
    ["missing summary", { findings: [] }],
    ["unknown severity", { summary: "s", findings: [finding({ severity: "urgent" })] }],
    ["unknown basis", { summary: "s", findings: [finding({ basis: "rumor" })] }],
    ["unknown confidence", { summary: "s", findings: [finding({ confidence: 0.9 })] }],
    ["extra field smuggled in", { summary: "s", findings: [finding({ sqlQuery: "select *" })] }],
    ["status the agent may not set", { summary: "s", status: "failed" }],
    ["unknown action kind", { summary: "s", recommendations: [recommendation({ actionKind: "wire_money" })] }],
    ["nested metadata", { summary: "s", metadata: { secret: { key: "x" } } }],
    ["external href on a finding", { summary: "s", findings: [finding({ href: "https://evil.example/phish" })] }],
    ["protocol-relative href", { summary: "s", findings: [finding({ href: "//evil.example" })] }],
    ["javascript href", { summary: "s", findings: [finding({ href: "javascript:alert(1)" })] }],
    ["http (not https) source", { summary: "s", findings: [finding({ sources: [{ title: "t", url: "http://example.com" }] })] }],
    ["empty title", { summary: "s", findings: [finding({ title: "  " })] }],
    ["too many findings", { summary: "s", findings: Array.from({ length: 51 }, (_, i) => finding({ id: `f${i}` })) }],
  ];
  for (const [label, value] of cases) assert.equal(contract.AgentOutputSchema.safeParse(value).success, false, label);
});

test("AgentResultSchema accepts a valid result and rejects broken ids and timestamps", () => {
  assert.equal(contract.AgentResultSchema.safeParse(validResult()).success, true);
  assert.equal(contract.AgentResultSchema.safeParse(validResult({ runId: "not-a-uuid" })).success, false);
  assert.equal(contract.AgentResultSchema.safeParse(validResult({ createdAt: "yesterday" })).success, false);
  assert.equal(contract.AgentResultSchema.safeParse({ ...validResult(), agent: "rogue" }).success, false);
});

test("severity and confidence helpers", () => {
  assert.equal(contract.highestSeverity([]), "info");
  assert.equal(contract.highestSeverity(["low", "critical", "medium"]), "critical");
  assert.equal(contract.lowestConfidence([], "high"), "high");
  assert.equal(contract.lowestConfidence(["high", "low", "medium"], "high"), "low");
  assert.equal(contract.lowerConfidence("high"), "medium");
  assert.equal(contract.lowerConfidence("low"), "low");
});

test("every sensitive action requires approval, whatever the agent claimed", () => {
  const sensitive = ["send_customer_message", "send_email", "contact_prospect", "change_production", "deploy_code", "modify_billing", "delete_data", "change_credentials", "change_integrations", "destructive_operation"] as const;
  for (const actionKind of sensitive) {
    for (const autonomy of contract.AUTONOMY_LEVELS) {
      const { recommendation: out } = permissions.enforceRecommendationPolicy(contract.RecommendationSchema.parse(recommendation({ actionKind, autonomy, requiresApproval: false })), "recommend");
      assert.equal(out.requiresApproval, true, `${actionKind}/${autonomy}`);
      assert.equal(out.autonomy, "requires_approval", `${actionKind}/${autonomy}`);
    }
  }
  assert.deepEqual([...permissions.SENSITIVE_ACTION_KINDS].sort(), [...sensitive].sort());
});

test("autonomous is never granted in Phase 1; claims above the ceiling are downgraded to requires-approval", () => {
  const autonomous = permissions.enforceRecommendationPolicy(contract.RecommendationSchema.parse(recommendation({ autonomy: "autonomous" })), "recommend");
  assert.equal(autonomous.recommendation.autonomy, "requires_approval");
  assert.equal(autonomous.recommendation.requiresApproval, true);
  assert.equal(autonomous.adjustment?.reason, "autonomy_not_permitted");

  const readOnlyAgent = permissions.enforceRecommendationPolicy(contract.RecommendationSchema.parse(recommendation({ autonomy: "recommend" })), "read_only");
  assert.equal(readOnlyAgent.recommendation.requiresApproval, true);
  assert.equal(readOnlyAgent.adjustment?.reason, "above_agent_ceiling");
});

test("harmless recommendations pass unchanged, and an agent's own approval request is never dropped", () => {
  const plain = permissions.enforceRecommendationPolicy(contract.RecommendationSchema.parse(recommendation()), "recommend");
  assert.equal(plain.adjustment, null);
  assert.equal(plain.recommendation.requiresApproval, false);

  const asked = permissions.enforceRecommendationPolicy(contract.RecommendationSchema.parse(recommendation({ requiresApproval: true })), "recommend");
  assert.equal(asked.recommendation.requiresApproval, true);
  assert.equal(asked.recommendation.autonomy, "requires_approval");

  const mismatched = permissions.enforceRecommendationPolicy(contract.RecommendationSchema.parse(recommendation({ autonomy: "requires_approval", requiresApproval: false })), "recommend");
  assert.equal(mismatched.recommendation.requiresApproval, true);
});
