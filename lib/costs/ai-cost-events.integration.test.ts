/**
 * Integration tests for lib/costs/ai-cost-events.ts and the rate_cards
 * overlap-prevention constraint - real database, real
 * INSERT ... ON CONFLICT DO NOTHING idempotency, real GiST exclusion
 * constraint. No disposable-admin session needed here (this module never
 * checks agency-admin authorization itself - lib/agency/costs.ts does, and
 * is covered by its own integration test) - this suite uses the service-role
 * client directly, exactly like this function is actually called from
 * lib/bi/insights.ts's persistInsightsInteraction.
 *
 * REQUIRES supabase/migrations/20260927000000_ai_cost_intelligence.sql to
 * already be applied.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test lib/costs/ai-cost-events.integration.test.ts
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
const { recordAiCostEventForInteraction }: typeof import("./ai-cost-events") = require(path.join(REPO_ROOT, "lib/costs/ai-cost-events.ts"));

const service = createServiceRoleClient();

let organizationId: string;
let interactionId: string;
const rateCardIds: string[] = [];

before(async () => {
  const { data: org } = await service.from("organizations").insert({ name: "AI Cost Events Test Org" }).select("id").single();
  organizationId = org!.id;

  const { data: interaction } = await service
    .from("ai_interactions")
    .insert({ organization_id: organizationId, interaction_type: "business_insights", input: {}, output: {}, model: "claude-sonnet-5" })
    .select("id")
    .single();
  interactionId = interaction!.id;

  const { data: rates } = await service
    .from("rate_cards")
    .insert([
      { provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5", unit: "input_token", unit_price: 0.000003, currency: "usd", effective_from: "2026-01-01T00:00:00Z" },
      { provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5", unit: "output_token", unit_price: 0.000015, currency: "usd", effective_from: "2026-01-01T00:00:00Z" },
    ])
    .select("id");
  for (const row of rates ?? []) rateCardIds.push(row.id);
});

after(async () => {
  await service.from("ai_cost_events").delete().eq("organization_id", organizationId);
  await service.from("ai_interactions").delete().eq("id", interactionId);
  await service.from("organizations").delete().eq("id", organizationId);
  for (const id of rateCardIds) {
    await service.from("rate_cards").delete().eq("id", id);
  }
});

test("1. a normal insertion creates exactly one ai_cost_events row with the correct total_cost", async () => {
  const result = await recordAiCostEventForInteraction(service, {
    organizationId,
    sourceInteractionId: interactionId,
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: { inputTokens: 1000, outputTokens: 500 },
    occurredAt: "2026-06-01T00:00:00Z",
  });
  assert.equal(result.outcome, "known");

  const { data } = await service.from("ai_cost_events").select("*").eq("source_interaction_id", interactionId);
  assert.equal(data?.length, 1);
  assert.ok(Math.abs((data![0].total_cost as number) - 0.0105) < 1e-9);
});

test("2. repeated processing of the SAME interaction never creates a second row (idempotency)", async () => {
  const second = await recordAiCostEventForInteraction(service, {
    organizationId,
    sourceInteractionId: interactionId,
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: { inputTokens: 1000, outputTokens: 500 },
    occurredAt: "2026-06-01T00:00:00Z",
  });
  assert.equal(second.outcome, "known", "a replay must still report success, never an error, even though no new row is written");

  const { data, count } = await service.from("ai_cost_events").select("id", { count: "exact" }).eq("source_interaction_id", interactionId);
  assert.equal(count, 1, "exactly one cost event must exist per source interaction, regardless of replay count");
  assert.equal(data?.length, 1);
});

test("3. concurrent processing of the same interaction still resolves to exactly one row", async () => {
  const stamp = Date.now();
  const { data: org } = await service.from("organizations").insert({ name: `AI Cost Events Concurrency Test ${stamp}` }).select("id").single();
  const concurrentOrgId = org!.id;
  const { data: interaction } = await service
    .from("ai_interactions")
    .insert({ organization_id: concurrentOrgId, interaction_type: "business_insights", input: {}, output: {}, model: "claude-sonnet-5" })
    .select("id")
    .single();
  const concurrentInteractionId = interaction!.id;

  try {
    const input = {
      organizationId: concurrentOrgId,
      sourceInteractionId: concurrentInteractionId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: { inputTokens: 200, outputTokens: 100 },
      occurredAt: "2026-06-01T00:00:00Z",
    };
    const [a, b, c] = await Promise.all([
      recordAiCostEventForInteraction(service, input),
      recordAiCostEventForInteraction(service, input),
      recordAiCostEventForInteraction(service, input),
    ]);
    for (const result of [a, b, c]) assert.equal(result.outcome, "known");

    const { count } = await service.from("ai_cost_events").select("id", { count: "exact" }).eq("source_interaction_id", concurrentInteractionId);
    assert.equal(count, 1, "three genuinely concurrent calls for the same interaction must still resolve to exactly one row");
  } finally {
    await service.from("ai_cost_events").delete().eq("organization_id", concurrentOrgId);
    await service.from("ai_interactions").delete().eq("id", concurrentInteractionId);
    await service.from("organizations").delete().eq("id", concurrentOrgId);
  }
});

test("4. rate_cards rejects two overlapping ACTIVE periods for the same provider/service/model/unit/currency", async () => {
  const { error } = await service.from("rate_cards").insert({
    provider: "anthropic",
    service: "chat_completion",
    model: "claude-sonnet-5",
    unit: "input_token",
    unit_price: 0.000004,
    currency: "usd",
    effective_from: "2026-03-01T00:00:00Z", // overlaps the fixture's 2026-01-01-open-ended input_token rate
  });
  assert.ok(error, "an overlapping active rate period for the same key must be rejected at the database level");
});

test("5. rate_cards allows a non-overlapping successor period for the same key (a normal price change)", async () => {
  // Close out a fresh, disposable rate (never touching the shared fixture
  // rows other tests depend on) then insert its non-overlapping successor.
  const { data: closable } = await service
    .from("rate_cards")
    .insert({ provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5-price-change-test", unit: "input_token", unit_price: 0.000001, currency: "usd", effective_from: "2026-01-01T00:00:00Z" })
    .select("id")
    .single();

  await service.from("rate_cards").update({ effective_to: "2026-06-01T00:00:00Z" }).eq("id", closable!.id);

  const { error } = await service
    .from("rate_cards")
    .insert({ provider: "anthropic", service: "chat_completion", model: "claude-sonnet-5-price-change-test", unit: "input_token", unit_price: 0.000002, currency: "usd", effective_from: "2026-06-01T00:00:00Z" });

  assert.equal(error, null, "a successor rate period starting exactly where the prior one ends must be accepted, not treated as an overlap");

  await service.from("rate_cards").delete().eq("model", "claude-sonnet-5-price-change-test");
});
