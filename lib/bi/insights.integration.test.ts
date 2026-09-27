/**
 * Integration test for lib/bi/insights.ts's Phase 5D-2 telemetry-persistence
 * fix (persistInsightsInteraction) - real database. Verifies the exact
 * regression-sensitive claims: usage is persisted onto the existing
 * ai_interactions row in the same shape n8n-driven interactions already use,
 * the pre-existing report content is completely unchanged, and an
 * ai_cost_events row is opportunistically created only when a matching rate
 * card exists.
 *
 * Uses a distinct model string ("claude-sonnet-5-insights-test") for its
 * rate_cards fixture - rate_cards is global, so this avoids any
 * overlap-constraint collision with other integration suites' own fixtures.
 *
 * REQUIRES supabase/migrations/20260927000000_ai_cost_intelligence.sql to
 * already be applied.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/bi/insights.integration.test.ts
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
const { persistInsightsInteraction }: typeof import("./insights") = require(path.join(REPO_ROOT, "lib/bi/insights.ts"));

const service = createServiceRoleClient();

const FAKE_INPUT = { period: { label: "test", from: null, to: null } } as never;
const FAKE_REPORT = { summary: "Test summary.", insights: [], dataLimitations: [] } as never;

let organizationId: string;
const rateCardIds: string[] = [];
const interactionIds: string[] = [];

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "Insights Telemetry Test Org" }).select("id").single();
  organizationId = org!.id;

  const { data: rates } = await service
    .from("rate_cards")
    .insert([
      { provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5-insights-test", unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2020-01-01T00:00:00Z" },
      { provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5-insights-test", unit: "output_token", unit_price: 0.000015, currency: "usd", effective_from: "2020-01-01T00:00:00Z" },
    ])
    .select("id");
  for (const row of rates ?? []) rateCardIds.push(row.id);
});

after(async () => {
  await service.from("ai_cost_events").delete().eq("organization_id", organizationId);
  for (const id of interactionIds) {
    await service.from("ai_interactions").delete().eq("id", id);
  }
  await service.from("organizations").delete().eq("id", organizationId);
  for (const id of rateCardIds) {
    await service.from("rate_cards").delete().eq("id", id);
  }
});

test("1. real usage is persisted onto ai_interactions.output.usage and tokens_used, without changing the report content", async () => {
  const interactionId = await persistInsightsInteraction(service, organizationId, FAKE_INPUT, FAKE_REPORT, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  assert.ok(interactionId);
  interactionIds.push(interactionId!);

  const { data } = await service.from("ai_interactions").select("output, tokens_used, model").eq("id", interactionId!).single();
  assert.equal(data?.tokens_used, 150);
  assert.equal(data?.model, "claude-sonnet-5");
  assert.equal(data?.output.summary, "Test summary.", "the original report content must be completely unchanged");
  assert.deepEqual(data?.output.insights, []);
  assert.deepEqual(data?.output.usage, { input_tokens: 100, output_tokens: 50, total_tokens: 150 });
});

test("2. null usage (e.g. a test-injected callClaudeFn with no real API response) persists tokens_used=null and no usage key at all - never a fabricated 0", async () => {
  const interactionId = await persistInsightsInteraction(service, organizationId, FAKE_INPUT, FAKE_REPORT, null);
  assert.ok(interactionId);
  interactionIds.push(interactionId!);

  const { data } = await service.from("ai_interactions").select("output, tokens_used").eq("id", interactionId!).single();
  assert.equal(data?.tokens_used, null);
  assert.equal(data?.output.usage, undefined, "output must be the exact original report shape, with no usage key added, when there is no real usage to report");
});

test("3. real usage + a matching rate card opportunistically creates exactly one known ai_cost_events row", async () => {
  // This interaction is persisted with model claude-sonnet-5 (hardcoded by
  // persistInsightsInteraction) but the seeded rate card above is for
  // "claude-sonnet-5-insights-test" - so this specific test instead inserts
  // its OWN interaction row directly with the matching test model, to
  // exercise recordAiCostEventForInteraction's real rate lookup without
  // needing a rate card for the literal production model string (avoiding
  // any risk of accidentally seeding a real Anthropic price into a shared
  // database from a test).
  const { data: interaction } = await service
    .from("ai_interactions")
    .insert({ organization_id: organizationId, interaction_type: "business_insights", input: FAKE_INPUT, output: FAKE_REPORT, model: "claude-sonnet-5-insights-test" })
    .select("id")
    .single();
  interactionIds.push(interaction!.id);

  const { recordAiCostEventForInteraction }: typeof import("@/lib/costs/ai-cost-events") = require(path.join(REPO_ROOT, "lib/costs/ai-cost-events.ts"));
  const result = await recordAiCostEventForInteraction(service, {
    organizationId,
    sourceInteractionId: interaction!.id,
    provider: "anthropic",
    model: "claude-sonnet-5-insights-test",
    usage: { inputTokens: 1000, outputTokens: 500 },
    occurredAt: new Date().toISOString(),
  });
  assert.equal(result.outcome, "known");

  const { data: costEvent } = await service.from("ai_cost_events").select("*").eq("source_interaction_id", interaction!.id).single();
  assert.ok(costEvent);
  assert.ok(Math.abs((costEvent!.total_cost as number) - 0.0105) < 1e-9);
});
