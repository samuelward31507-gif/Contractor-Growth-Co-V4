import type { SupabaseClient } from "@supabase/supabase-js";
import { getAgencyUsageSummary, type ClientUsageSummary, type AgencyUsageTotals } from "./usage";
import { resolveDateRange } from "@/lib/bi/queries";
import { DASHBOARD_DEFAULT_RANGE } from "@/lib/dashboard/business-metrics";
import type { ResolvedDateRange } from "@/lib/bi/types";
import type { AgencyAuthFailure } from "./queries";
import type { MessageStatus } from "@/lib/conversations/queries";

/**
 * Trackpr Phase 5C - Cost Readiness (usage -> cost readiness only, NOT
 * cost/margin/billing). Per the Phase 5C architecture audit: Trackpr can
 * reliably measure usage today (messaging, AI, automation, missed calls -
 * all already surfaced by lib/agency/usage.ts), but has zero authoritative
 * provider pricing (Twilio, Anthropic, n8n) and zero client revenue data
 * anywhere in this codebase. This module NEVER computes a dollar figure -
 * every cost/revenue/margin field is a literal, static readiness status
 * ("unpriced" / "unavailable"), never a number.
 *
 * Reuses getAgencyUsageSummary() entirely rather than re-authorizing or
 * re-fetching the agency snapshot fan-out a second time - this file adds
 * exactly ONE new query (the AI input/output token breakdown), scoped
 * identically to lib/agency/usage.ts's own loadMissedCallCounts convention
 * (one batched read across the already-authorized organization id list).
 *
 * Future Phase 5D may introduce: authoritative provider rate cards, SMS
 * billed-unit pricing, AI model input/output pricing, Stripe revenue data,
 * contribution margin, historical cost snapshots, and optional client
 * pricing/usage billing - none of that is implemented here. This file's own
 * "unpriced"/"unavailable" literals are the explicit placeholder for exactly
 * where that future work plugs in.
 */

export type CostPricingStatus = "unpriced";
export type CostAvailabilityStatus = "unavailable";

export type CostReadinessMessaging = {
  inboundMessages: number;
  outboundMessages: number;
  statusCounts: Record<MessageStatus, number>;
  pricingStatus: CostPricingStatus;
};

export type CostReadinessAi = {
  interactions: number;
  /** Recovered from ai_interactions.output->'usage'->'input_tokens' (see loadAiTokenBreakdown) - null whenever no interaction in range reported it. Never inferred from totalTokens. */
  inputTokens: number | null;
  /** Same source, ->'output_tokens'. Independent of inputTokens - one can be known while the other isn't, since n8n's own AI call reports each field independently. */
  outputTokens: number | null;
  /** Reused verbatim from ClientUsageSummary.ai.tokens (the existing, already-reliable tokens_used column sum) - never recomputed from the JSONB, since that would risk a second, potentially-divergent total for the same figure. */
  totalTokens: number | null;
  pricingStatus: CostPricingStatus;
};

export type CostReadinessVoice = {
  /** Reused verbatim from ClientUsageSummary.voice.missedCalls - null means the missed-call query itself failed, never a real zero. */
  missedCalls: number | null;
  pricingStatus: CostPricingStatus;
};

export type CostReadinessAutomation = {
  executions: number;
  pricingStatus: CostPricingStatus;
};

export type CostReadinessSummary = {
  organizationId: string;
  organizationName: string;
  messaging: CostReadinessMessaging;
  ai: CostReadinessAi;
  voice: CostReadinessVoice;
  automation: CostReadinessAutomation;
  /** Client revenue is not captured anywhere in Trackpr's own database (no Stripe customer/subscription id, no invoice data - see lib/billing/checkout.ts and app/api/webhooks/stripe/route.ts, neither modified here). Always "unavailable" - never $0, never inferred. */
  revenue: { status: CostAvailabilityStatus };
  /** No authoritative provider rate exists for any usage category yet (see each category's own pricingStatus above) - so no variable cost figure can be computed, not even a partial one. */
  variableCost: { status: CostAvailabilityStatus };
  /** Requires both revenue and variable cost, neither of which exists - never shown as $0, -$0, or 0%. */
  contributionMargin: { status: CostAvailabilityStatus };
  dataQuality: { partialData: boolean; notes: string[] };
};

export type AgencyCostReadinessResult =
  | {
      ok: true;
      /** Pass-through of getAgencyUsageSummary's own result, unchanged - the existing /agency/usage summary/table rendering keeps reading from here exactly as before this phase. */
      usage: { clients: ClientUsageSummary[]; totals: AgencyUsageTotals };
      costReadiness: { clients: CostReadinessSummary[] };
      partialData: boolean;
      generatedAt: string;
    }
  | AgencyAuthFailure;

type ExtractedAiUsage = { inputTokens: number | null; outputTokens: number | null };

/**
 * Pure, no I/O - directly unit-testable. Reads exactly the shape the n8n
 * callback route validates and stores verbatim (app/api/automation/
 * n8n-callback/route.ts: `output: aiResult`, where `aiResult.usage` carries
 * `input_tokens`/`output_tokens`/`total_tokens`, each independently a
 * non-negative integer or null). Never throws on an absent or malformed
 * `output` - every non-numeric shape (missing entirely, `usage` missing,
 * `usage` not an object, a non-numeric field) resolves to null for that
 * field, never 0, never inferred from a sibling field.
 */
export function extractAiTokenUsage(output: unknown): ExtractedAiUsage {
  if (typeof output !== "object" || output === null) return { inputTokens: null, outputTokens: null };

  const usage = (output as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return { inputTokens: null, outputTokens: null };

  const record = usage as Record<string, unknown>;
  return {
    inputTokens: typeof record.input_tokens === "number" ? record.input_tokens : null,
    outputTokens: typeof record.output_tokens === "number" ? record.output_tokens : null,
  };
}

const MAX_AI_TOKEN_ROWS = 10_000;

type AiOutputRow = { organization_id: string; output: unknown };

/**
 * The one genuinely new query in this module. Mirrors lib/agency/usage.ts's
 * loadMissedCallCounts convention exactly: one query batched across the
 * already-authorized organization id list (never per-organization, never
 * unscoped), and `failed` is true only on a real Postgrest error - never on
 * genuine emptiness (which correctly leaves every organization's
 * input/output totals at null - "no interaction in range reported this
 * field," not "the query failed").
 */
export async function loadAiTokenBreakdown(
  serviceSupabase: SupabaseClient,
  organizationIds: string[],
  range: ResolvedDateRange,
): Promise<{ byOrganization: Map<string, ExtractedAiUsage>; failed: boolean }> {
  if (organizationIds.length === 0) return { byOrganization: new Map(), failed: false };

  let query = serviceSupabase
    .from("ai_interactions")
    .select("organization_id, output")
    .in("organization_id", organizationIds)
    .limit(MAX_AI_TOKEN_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data, error } = await query;
  if (error) return { byOrganization: new Map(), failed: true };

  const inputSums = new Map<string, number>();
  const inputSeen = new Set<string>();
  const outputSums = new Map<string, number>();
  const outputSeen = new Set<string>();

  for (const row of (data ?? []) as AiOutputRow[]) {
    const { inputTokens, outputTokens } = extractAiTokenUsage(row.output);
    if (inputTokens !== null) {
      inputSeen.add(row.organization_id);
      inputSums.set(row.organization_id, (inputSums.get(row.organization_id) ?? 0) + inputTokens);
    }
    if (outputTokens !== null) {
      outputSeen.add(row.organization_id);
      outputSums.set(row.organization_id, (outputSums.get(row.organization_id) ?? 0) + outputTokens);
    }
  }

  const byOrganization = new Map<string, ExtractedAiUsage>();
  for (const organizationId of organizationIds) {
    byOrganization.set(organizationId, {
      inputTokens: inputSeen.has(organizationId) ? (inputSums.get(organizationId) ?? null) : null,
      outputTokens: outputSeen.has(organizationId) ? (outputSums.get(organizationId) ?? null) : null,
    });
  }

  return { byOrganization, failed: false };
}

/**
 * The primary Phase 5C read. Calls getAgencyUsageSummary exactly once (which
 * itself resolves and scopes authorization) - never a second, independent
 * fan-out or authorization check. Every pricingStatus/revenue/variableCost/
 * contributionMargin field is a hardcoded literal, never a computed number -
 * this function contains no arithmetic that could ever produce a dollar
 * figure.
 */
export async function getAgencyCostReadiness(sessionSupabase: SupabaseClient, serviceSupabase: SupabaseClient): Promise<AgencyCostReadinessResult> {
  const usageResult = await getAgencyUsageSummary(sessionSupabase, serviceSupabase);
  if (!usageResult.ok) return usageResult;

  const range = resolveDateRange(DASHBOARD_DEFAULT_RANGE);
  const { byOrganization: tokenBreakdownByOrganization, failed: tokenBreakdownFailed } = await loadAiTokenBreakdown(
    serviceSupabase,
    usageResult.clients.map((client) => client.organizationId),
    range,
  );

  const costReadinessClients: CostReadinessSummary[] = usageResult.clients.map((client) => {
    const breakdown = tokenBreakdownByOrganization.get(client.organizationId) ?? { inputTokens: null, outputTokens: null };
    const notes = [...client.dataQuality.notes];
    if (tokenBreakdownFailed) notes.push("AI input/output token breakdown temporarily unavailable.");

    return {
      organizationId: client.organizationId,
      organizationName: client.organizationName,
      messaging: {
        inboundMessages: client.messaging.inbound,
        outboundMessages: client.messaging.outbound,
        statusCounts: client.messaging.byStatus,
        pricingStatus: "unpriced",
      },
      ai: {
        interactions: client.ai.interactions,
        inputTokens: breakdown.inputTokens,
        outputTokens: breakdown.outputTokens,
        totalTokens: client.ai.tokens,
        pricingStatus: "unpriced",
      },
      voice: {
        missedCalls: client.voice.missedCalls,
        pricingStatus: "unpriced",
      },
      automation: {
        executions: client.automation.executions,
        pricingStatus: "unpriced",
      },
      revenue: { status: "unavailable" },
      variableCost: { status: "unavailable" },
      contributionMargin: { status: "unavailable" },
      dataQuality: {
        partialData: client.dataQuality.partialData || tokenBreakdownFailed,
        notes,
      },
    };
  });

  return {
    ok: true,
    usage: { clients: usageResult.clients, totals: usageResult.totals },
    costReadiness: { clients: costReadinessClients },
    partialData: usageResult.partialData || tokenBreakdownFailed,
    generatedAt: new Date().toISOString(),
  };
}
