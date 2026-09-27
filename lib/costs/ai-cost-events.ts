import type { SupabaseClient } from "@supabase/supabase-js";
import { findApplicableRateCard } from "./rate-cards";

/**
 * Trackpr Phase 5D-2 - the AI cost-event creation engine. Writes exactly one
 * append-only ai_cost_events row per successfully-priced ai_interactions
 * row, using the exact upsert-with-ignoreDuplicates idempotency pattern
 * already proven for ai_interactions (app/api/automation/n8n-callback/
 * route.ts) and revenue_events (app/api/webhooks/stripe/route.ts) - never a
 * SELECT-then-INSERT.
 *
 * TRUST BOUNDARY (the single most important rule in this file): an
 * ai_interactions row's `model` field is trustworthy ONLY when Trackpr's own
 * code set it directly from a real provider API response - never when it
 * was self-reported by an external n8n workflow. Per the Phase 5D-2 audit,
 * n8n's own AI step reports `model` as an arbitrary, unverified string
 * (app/api/automation/n8n-callback/route.ts's AiResult.model) - it must
 * never be assumed to be Anthropic (or any specific provider) merely because
 * the string resembles one. Today, exactly ONE interaction_type meets the
 * "Trackpr's own code set it" bar: "business_insights"
 * (lib/bi/insights.ts's defaultCallClaudeWithUsage, which calls the real
 * @anthropic-ai/sdk directly and hardcodes both provider and model itself).
 * Every other interaction_type - all n8n-driven - is intentionally absent
 * from this map and therefore always resolves to "not trustworthy," however
 * plausible its self-reported `model` string looks. This is not a bug or an
 * oversight; extending this map to another interaction_type requires the
 * same "Trackpr's own code independently sets the value" property, not
 * merely wanting to price more interactions.
 */
const TRUSTED_PROVIDER_BY_INTERACTION_TYPE: Record<string, string> = {
  business_insights: "anthropic",
};

export function resolveTrustedAiProvider(interactionType: string): string | null {
  return TRUSTED_PROVIDER_BY_INTERACTION_TYPE[interactionType] ?? null;
}

export const AI_COST_SERVICE = "chat_completion";

/**
 * Non-negative integer or reject - matches the exact validation discipline
 * already used for AI usage elsewhere in this codebase (see
 * app/api/automation/n8n-callback/route.ts's isNonNegativeIntOrNull). A
 * negative, fractional, or non-numeric value is never coerced to 0 or
 * dropped silently - the caller treats a false return as "usage cannot be
 * trusted," i.e. unknown.
 */
export function isValidTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export type AiUsageInput = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type RecordAiCostEventInput = {
  organizationId: string;
  sourceInteractionId: string;
  /** Must already be a trustworthy value resolved via resolveTrustedAiProvider - this function does not itself re-derive trust from an interaction_type. */
  provider: string;
  model: string;
  usage: AiUsageInput;
  /** The interaction's own timestamp (ai_interactions.created_at) - rate lookup and the stored occurred_at both use this, never "now". */
  occurredAt: string;
};

export type RecordAiCostEventResult =
  | { outcome: "known"; totalCost: number; currency: string }
  | { outcome: "unpriced"; reason: string }
  | { outcome: "unknown"; reason: string }
  | { outcome: "error"; error: string };

/**
 * The one place an ai_cost_events row is ever written. Never calculates a
 * cost when any required component is missing - the required-component list
 * mirrors the task's own spec exactly: valid input/output token counts, a
 * matching input rate, a matching output rate for the SAME period, and
 * matching currency between the two. total_tokens is never substituted for
 * a missing input/output split, and today's rate is never applied to
 * historical usage - occurredAt drives every rate lookup.
 */
export async function recordAiCostEventForInteraction(
  service: SupabaseClient,
  input: RecordAiCostEventInput,
): Promise<RecordAiCostEventResult> {
  const { inputTokens, outputTokens } = input.usage;

  if (!isValidTokenCount(inputTokens) || !isValidTokenCount(outputTokens)) {
    return { outcome: "unknown", reason: "missing_or_invalid_token_usage" };
  }

  const [inputRate, outputRate] = await Promise.all([
    findApplicableRateCard(service, { provider: input.provider, service: AI_COST_SERVICE, model: input.model, unit: "input_token", occurredAt: input.occurredAt }),
    findApplicableRateCard(service, { provider: input.provider, service: AI_COST_SERVICE, model: input.model, unit: "output_token", occurredAt: input.occurredAt }),
  ]);

  if (!inputRate || !outputRate) {
    return { outcome: "unpriced", reason: "no_matching_rate_card_for_period" };
  }

  if (inputRate.currency !== outputRate.currency) {
    // Never blend currencies into one total_cost - a provider/model's own
    // input and output rate should always share one currency, but this is
    // checked explicitly rather than assumed.
    return { outcome: "unpriced", reason: "currency_mismatch_between_input_and_output_rate" };
  }

  const inputCost = inputTokens * inputRate.unitPrice;
  const outputCost = outputTokens * outputRate.unitPrice;
  const totalCost = inputCost + outputCost;

  const { error } = await service.from("ai_cost_events").upsert(
    {
      organization_id: input.organizationId,
      provider: input.provider,
      service: AI_COST_SERVICE,
      model: input.model,
      source_interaction_id: input.sourceInteractionId,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      rate_card_input_id: inputRate.id,
      rate_card_output_id: outputRate.id,
      input_unit_price: inputRate.unitPrice,
      output_unit_price: outputRate.unitPrice,
      input_cost: inputCost,
      output_cost: outputCost,
      total_cost: totalCost,
      currency: inputRate.currency,
      occurred_at: input.occurredAt,
    },
    { onConflict: "source_interaction_id", ignoreDuplicates: true },
  );

  if (error) return { outcome: "error", error: error.message };

  return { outcome: "known", totalCost, currency: inputRate.currency };
}
