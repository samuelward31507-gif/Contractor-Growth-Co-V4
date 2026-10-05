/**
 * Agent Operating Layer: the agent runtime - failure handling, malformed
 * output, timeouts, empty-data behavior, confidence and priority roll-up,
 * approval enforcement and trace stamping. Pure: no network, no database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agents/runtime.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { runAgent }: typeof import("./runtime") = require(path.join(ROOT, "lib/agents/runtime.ts"));
const { AGENT_REGISTRY }: typeof import("./registry") = require(path.join(ROOT, "lib/agents/registry.ts"));
const { AgentResultSchema }: typeof import("./contract") = require(path.join(ROOT, "lib/agents/contract.ts"));
const { NOW, TRACE_ID, sequentialIds }: typeof import("./test-fixtures") = require(path.join(ROOT, "lib/agents/test-fixtures.ts"));

const ctx = () => ({ traceId: TRACE_ID, now: NOW, newId: sequentialIds(), clock: () => NOW.getTime() });
const sales = AGENT_REGISTRY.sales;
const finding = (overrides: Partial<import("./contract").Finding> = {}): import("./contract").Finding => ({ id: "f1", kind: "risk", basis: "fact", severity: "high", confidence: "high", category: "c", title: "Title", detail: "Detail.", evidence: [], sources: [], ...overrides });

test("a failed data read produces a valid failed result - the analyzer never runs on missing data", async () => {
  let called = false;
  const result = await runAgent(sales, () => ((called = true), { summary: "x" }), { ok: false, reason: "decision data unavailable" }, ctx());
  assert.equal(called, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "decision data unavailable");
  assert.deepEqual(result.findings, []);
  assert.equal(result.confidence, "low");
  assert.equal(AgentResultSchema.safeParse(result).success, true);
});

test("an unsafe read reason (raw error text) is replaced by a generic label", async () => {
  const result = await runAgent(sales, () => ({ summary: "x" }), { ok: false, reason: 'relation "secret_table" does not exist; key=sk_live_123' }, ctx());
  assert.equal(result.error, "data source unavailable");
});

test("an analyzer that throws becomes a failed result without leaking the error", async () => {
  const result = await runAgent(sales, () => {
    throw new Error("TypeError at /srv/app/secret.ts:42 token=abc");
  }, { ok: true, data: null }, ctx());
  assert.equal(result.status, "failed");
  assert.equal(result.error, "analysis error");
  assert.doesNotMatch(JSON.stringify(result), /secret\.ts|token=abc/);
});

test("an async analyzer that rejects or hangs is caught and timed out", async () => {
  const rejected = await runAgent(sales, async () => Promise.reject(new Error("boom")), { ok: true, data: null }, ctx());
  assert.equal(rejected.error, "analysis error");
  const hung = await runAgent(sales, () => new Promise<never>(() => {}), { ok: true, data: null }, { ...ctx(), timeoutMs: 20 });
  assert.equal(hung.status, "failed");
  assert.equal(hung.error, "timed out");
});

test("malformed output never passes through", async () => {
  for (const bad of ["prose", null, { summary: "" }, { summary: "s", findings: [finding({ severity: "urgent" as never })] }]) {
    const result = await runAgent(sales, () => bad as never, { ok: true, data: null }, ctx());
    assert.equal(result.status, "failed", JSON.stringify(bad));
    assert.equal(result.error, "malformed output");
    assert.equal(typeof result.metadata.issueCount, "number");
  }
});

test("empty data: ok with nothing found becomes empty, high confidence, info priority", async () => {
  const result = await runAgent(sales, () => ({ summary: "Nothing to do." }), { ok: true, data: null }, ctx());
  assert.equal(result.status, "empty");
  assert.equal(result.priority, "info");
  assert.equal(result.confidence, "high");
  assert.equal(result.requiresApproval, false);
});

test("priority is the highest severity, confidence the lowest; dangling and duplicate ids are cleaned", async () => {
  const result = await runAgent(
    sales,
    () => ({
      summary: "s",
      findings: [finding({ id: "a", severity: "medium", confidence: "high" }), finding({ id: "b", severity: "critical", confidence: "low" }), finding({ id: "a", title: "duplicate" })],
      recommendations: [{ id: "r", title: "t", detail: "d", actionKind: "review", autonomy: "recommend", requiresApproval: false, priority: "low", confidence: "high", relatedFindingIds: ["a", "ghost"] }],
    }),
    { ok: true, data: null },
    ctx(),
  );
  assert.equal(result.priority, "critical");
  assert.equal(result.confidence, "low");
  assert.deepEqual(result.findings.map((f) => f.id), ["a", "b"]);
  assert.deepEqual(result.recommendations[0].relatedFindingIds, ["a"]);
});

test("the runtime enforces approval on a sensitive recommendation the agent marked safe", async () => {
  const result = await runAgent(
    sales,
    () => ({ summary: "s", recommendations: [{ id: "r", title: "Text everyone", detail: "d", actionKind: "send_customer_message", autonomy: "autonomous", requiresApproval: false, priority: "high", confidence: "high" }] }),
    { ok: true, data: null },
    ctx(),
  );
  assert.equal(result.recommendations[0].requiresApproval, true);
  assert.equal(result.recommendations[0].autonomy, "requires_approval");
  assert.equal(result.requiresApproval, true);
  assert.equal(result.metadata.policyAdjustments, 1);
});

test("results carry the run's trace id, a unique run id, the agent id and its declared data sources", async () => {
  const context = ctx();
  const [a, b] = await Promise.all([runAgent(sales, () => ({ summary: "s" }), { ok: true, data: null }, context), runAgent(AGENT_REGISTRY.qa_health, () => ({ summary: "s" }), { ok: true, data: null }, context)]);
  assert.equal(a.traceId, TRACE_ID);
  assert.equal(b.traceId, TRACE_ID);
  assert.notEqual(a.runId, b.runId);
  assert.equal(a.agent, "sales");
  assert.deepEqual(a.dataSources, [...AGENT_REGISTRY.sales.allowedDataSources]);
  assert.equal(a.createdAt, NOW.toISOString());
});
