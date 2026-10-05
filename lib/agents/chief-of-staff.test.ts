/**
 * Agent Operating Layer: Chief of Staff aggregation and the full operating
 * layer run - priority ordering, confidence handling, approvals, empty
 * data, malformed agent results, failed agents, and the brief's worked
 * example. Pure: no network, no database.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/agents/chief-of-staff.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const load = <T>(p: string): T => require(path.join(ROOT, p));
const { buildBriefing, acceptResults, effectiveSeverityRank } = load<typeof import("./agents/chief-of-staff")>("lib/agents/agents/chief-of-staff.ts");
const { runOperatingLayer } = load<typeof import("./operating-layer")>("lib/agents/operating-layer.ts");
const { AgentResultSchema } = load<typeof import("./contract")>("lib/agents/contract.ts");
const fx = load<typeof import("./test-fixtures")>("lib/agents/test-fixtures.ts");

const run = (inputs: import("./operating-layer").SpecialistInputs) => runOperatingLayer(inputs, { traceId: fx.TRACE_ID, now: fx.NOW, newId: fx.sequentialIds(), clock: () => fx.NOW.getTime() });
const context = { traceId: fx.TRACE_ID, now: fx.NOW };
const f = (overrides: Partial<import("./contract").Finding>): import("./contract").Finding => ({ id: "f", kind: "risk", basis: "fact", severity: "medium", confidence: "high", category: "c", title: "Title", detail: "Detail.", evidence: [], sources: [], ...overrides });

test("the brief's example: callback failures first, then the 12 stale leads", async () => {
  const { briefing, results, chiefOfStaff, traceId } = await run(fx.exampleInputs());

  assert.equal(briefing.mostImportant?.agent, "qa_health");
  assert.equal(briefing.mostImportant?.title, "2 active n8n callback failures");
  assert.match(briefing.recommendation, /^Your biggest immediate issue is system reliability: 2 active n8n callback failures\./);
  assert.match(briefing.recommendation, /Sales also reports 12 missed follow-ups\./);
  assert.match(briefing.recommendation, /I recommend you investigate the n8n callback failures first, then work the missed follow-ups\./);
  assert.match(briefing.recommendation, /wait for your approval; nothing runs on its own\./);

  assert.deepEqual(briefing.needsAttention.map((i) => i.agent), ["qa_health", "sales"]);
  assert.equal(briefing.systemPriority?.agent, "qa_health");
  assert.equal(briefing.salesPriority?.title, "12 missed follow-ups");
  assert.equal(briefing.market[0].basis, "inference", "the market note is an inference, and says so");
  assert.ok(briefing.systemHealth.some((i) => i.agent === "engineering" && i.basis === "inference"));

  // Approvals: the retry and the engineering fix - never in next actions.
  assert.ok(briefing.approvals.length >= 2);
  assert.ok(briefing.approvals.every((a) => a.requiresApproval));
  assert.ok(briefing.nextActions.every((a) => !a.requiresApproval));

  // One trace across all seven runs; every result satisfies the contract.
  assert.equal(results.length, 6);
  for (const r of [...results, chiefOfStaff]) {
    assert.equal(r.traceId, traceId);
    assert.ok(AgentResultSchema.safeParse(r).success, r.agent);
  }
  assert.equal(chiefOfStaff.agent, "chief_of_staff");
  assert.equal(chiefOfStaff.status, "ok");
});

test("no invented information: every briefing item and action traces back to a specialist's output", async () => {
  const { briefing, results } = await run(fx.exampleInputs());
  const findingKeys = new Set(results.flatMap((r) => r.findings.map((x) => `${r.agent}:${x.id}`)));
  const actionKeys = new Set(results.flatMap((r) => r.recommendations.map((x) => `${r.agent}:${x.id}`)));
  for (const item of [...briefing.needsAttention, ...briefing.opportunities, ...briefing.systemHealth, ...briefing.sales, ...briefing.market]) assert.ok(findingKeys.has(item.key), item.key);
  for (const action of [...briefing.nextActions, ...briefing.approvals]) assert.ok(actionKeys.has(action.key), action.key);
});

test("quiet business: nothing needs you, sections are empty or status-only", async () => {
  const { briefing } = await run(fx.quietInputs());
  assert.equal(briefing.recommendation, "Nothing needs you right now. No risks or opportunities stand out in what the agents could read.");
  assert.equal(briefing.needsAttention.length, 0);
  assert.equal(briefing.opportunities.length, 0);
  assert.equal(briefing.mostImportant, null);
  assert.deepEqual(briefing.systemHealth.map((i) => i.title), ["Automation is running normally"]);
  assert.deepEqual(
    briefing.agents.map((a) => [a.agent, a.status]),
    [["qa_health", "ok"], ["sales", "empty"], ["trackpr_intelligence", "empty"], ["engineering", "empty"], ["market_intelligence", "not_configured"], ["prospecting", "not_configured"]],
  );
});

test("a failed agent is reported in system health, never silently dropped; other agents still brief", async () => {
  const inputs = fx.exampleInputs();
  inputs.sales = { ok: false, reason: "decision data unavailable" };
  const { briefing } = await run(inputs);
  assert.equal(briefing.agents.find((a) => a.agent === "sales")?.status, "failed");
  assert.ok([...briefing.needsAttention, ...briefing.systemHealth].some((i) => i.key === "sales:failed"));
  assert.equal(briefing.mostImportant?.agent, "qa_health");
});

test("every organization agent failing: the Chief of Staff says it cannot brief rather than guessing", async () => {
  const down = { ok: false as const, reason: "unavailable" };
  const { briefing } = await run({ ...fx.quietInputs(), sales: down, trackpr_intelligence: down, qa_health: down, engineering: down });
  assert.match(briefing.recommendation, /^I can't brief you yet/);
});

test("malformed agent results are set aside unread and counted", () => {
  const good = fx.validResult({ findings: [f({ id: "ok", title: "Real finding" })] });
  const { accepted, rejected } = acceptResults([good, { agent: "sales", summary: "prose only" }, "garbage", null, { ...good, agent: "chief_of_staff" }]);
  assert.equal(accepted.length, 1);
  assert.equal(rejected, 4);
  const briefing = buildBriefing([good, { totally: "wrong" }], context);
  assert.ok(briefing.needsAttention.some((i) => i.key === "chief_of_staff:rejected"));
  assert.ok(briefing.needsAttention.some((i) => i.title === "Real finding"));
});

test("priority ordering: severity first, then system before sales, then facts before inferences", () => {
  const briefing = buildBriefing(
    [
      fx.validResult({ agent: "sales", findings: [f({ id: "s-high", severity: "high", title: "Sales high" }), f({ id: "s-crit", severity: "critical", title: "Sales critical" })] }),
      fx.validResult({ agent: "qa_health", runId: "33333333-3333-4333-8333-333333333333", findings: [f({ id: "q-high", severity: "high", title: "QA high" })] }),
      fx.validResult({ agent: "trackpr_intelligence", runId: "44444444-4444-4444-8444-444444444444", findings: [f({ id: "t-high-inf", severity: "high", basis: "inference", title: "Intel high inference" }), f({ id: "t-high", severity: "high", title: "Intel high" })] }),
    ],
    context,
  );
  assert.deepEqual(briefing.needsAttention.map((i) => i.title), ["Sales critical", "QA high", "Sales high"]);
  const all = buildBriefing([fx.validResult({ agent: "trackpr_intelligence", findings: [f({ id: "a", severity: "high", basis: "inference", title: "Inference" }), f({ id: "b", severity: "high", title: "Fact" })] })], context);
  assert.deepEqual(all.needsAttention.map((i) => i.title), ["Fact", "Inference"]);
});

test("confidence handling: a low-confidence item ranks one level below its label", () => {
  assert.equal(effectiveSeverityRank("high", "low"), effectiveSeverityRank("medium", "high"));
  assert.equal(effectiveSeverityRank("info", "low"), 0);
  const briefing = buildBriefing(
    [fx.validResult({ agent: "qa_health", findings: [f({ id: "shaky", severity: "high", confidence: "low", title: "Shaky high" }), f({ id: "solid", severity: "high", confidence: "high", title: "Solid high" })] })],
    context,
  );
  assert.equal(briefing.mostImportant?.title, "Solid high");
  // A low-confidence medium drops below the needs-attention bar entirely.
  const weak = buildBriefing([fx.validResult({ findings: [f({ id: "w", severity: "medium", confidence: "low" })] })], context);
  assert.equal(weak.needsAttention.length, 0);
});

test("opportunity-only day: the recommendation leads with the opportunity", () => {
  const briefing = buildBriefing([fx.validResult({ findings: [f({ id: "o", kind: "opportunity", title: "Highest-value open item: Acme" })], recommendations: [{ id: "o:act", title: "Prioritize Acme", detail: "d", actionKind: "review", autonomy: "recommend", requiresApproval: false, priority: "medium", confidence: "high", relatedFindingIds: ["o"] }] })], context);
  assert.equal(briefing.recommendation, "Nothing is on fire. Your biggest opportunity: highest-value open item: Acme. I recommend you prioritize Acme first.");
});

test("section limits hold", async () => {
  const inputs = fx.exampleInputs();
  inputs.sales = {
    ok: true,
    data: {
      ...fx.emptySalesInput(),
      attention: ["customer_awaiting_reply", "invoice_overdue", "lead_not_contacted", "appointment_overdue", "estimate_expired"].map((reasonCode, i) => fx.salesItem({ key: `${i}`, reasonCode, tier: reasonCode === "invoice_overdue" ? "committed_revenue_at_risk" : "active_pursuit" })),
    },
  };
  const { briefing } = await run(inputs);
  assert.ok(briefing.needsAttention.length <= 3 && briefing.sales.length <= 3 && briefing.systemHealth.length <= 2 && briefing.market.length <= 2 && briefing.nextActions.length <= 3);
});
