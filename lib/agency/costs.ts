import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgencyOrganizations, type AgencyAuthFailure } from "./queries";
import { extractAiTokenUsage } from "./cost-readiness";
import { resolveTrustedAiProvider } from "@/lib/costs/ai-cost-events";
import { resolveDateRange } from "@/lib/bi/queries";
import type { DateRangeInput, ResolvedDateRange } from "@/lib/bi/types";

/**
 * Trackpr Phase 5D-2 - AI Cost Intelligence read layer. This is the ONLY
 * place agency AI cost is ever aggregated. It reads exclusively from
 * ai_cost_events (populated by lib/costs/ai-cost-events.ts, called from
 * lib/bi/insights.ts's business_insights path) plus ai_interactions (to
 * classify what's still unresolved) - never recomputes cost itself, never
 * calls a provider live.
 *
 * Calls resolveAgencyOrganizations() directly, exactly once, and never
 * trusts a caller-supplied organization id - mirrors lib/agency/revenue.ts
 * and lib/agency/cost-readiness.ts exactly.
 *
 * Multi-currency safety: every total is a CostCurrencyAmount[], one entry
 * per currency actually observed - never summed across currencies. Today
 * only USD will ever appear (no rate card in any other currency has been
 * seeded), but nothing here assumes that.
 *
 * Phase 5D-4 adds a second, independent read (getAgencySmsCosts, further
 * below) for Twilio SMS cost - structurally sibling to the AI read above,
 * never sharing state with it, and never changing anything about the
 * existing AI cost behavior.
 */

const MAX_AI_COST_EVENT_ROWS = 50_000;
const MAX_AI_INTERACTION_ROWS = 10_000;

export type CostCurrencyAmount = { currency: string; amount: number };

export type AiCostDataQuality = "known" | "unknown" | "partial";

export type AgencyAiCostTotals = {
  /** Sum of ai_cost_events.total_cost, per currency - the only real dollar figure this module ever produces. */
  knownCost: CostCurrencyAmount[];
  /** Count of ai_interactions that produced a known ai_cost_events row. */
  knownInteractionCount: number;
  /** Count of trusted-identity interactions with valid usage but no matching rate card for their period. */
  unpricedInteractionCount: number;
  /** Count of interactions whose identity is not trustworthy (all n8n-driven types) or whose usage is missing/malformed. */
  unknownInteractionCount: number;
};

export type ClientAiCostSummary = {
  organizationId: string;
  organizationName: string;
  knownCost: CostCurrencyAmount[];
  knownInteractionCount: number;
  unpricedInteractionCount: number;
  unknownInteractionCount: number;
  /** "known" also covers a genuine zero-interaction organization - a confirmed absence of AI usage is not the same as an unresolved cost, exactly like lib/agency/revenue.ts's own empty-vs-unresolved distinction. */
  dataQuality: AiCostDataQuality;
};

export type AgencyAiCostResult =
  | {
      ok: true;
      range: ResolvedDateRange;
      totals: AgencyAiCostTotals;
      clients: ClientAiCostSummary[];
      partialData: boolean;
      generatedAt: string;
    }
  | AgencyAuthFailure;

/**
 * Pure, no I/O - directly unit-testable. An interaction whose identity isn't
 * trustworthy (every n8n-driven interaction_type - see
 * lib/costs/ai-cost-events.ts's own trust map, reused here as the single
 * source of truth rather than duplicated) is always "unknown", regardless of
 * whether it happens to carry usage data. Only a trusted-identity
 * interaction with genuinely missing/malformed usage is "unknown" for that
 * reason instead; a trusted interaction WITH valid usage that reaches this
 * function at all (i.e. has no ai_cost_events row) means pricing was
 * attempted and no matching rate card covered its period - "unpriced".
 */
export function classifyUnresolvedAiInteraction(row: { interactionType: string; output: unknown }): "unpriced" | "unknown" {
  if (!resolveTrustedAiProvider(row.interactionType)) return "unknown";
  const usage = extractAiTokenUsage(row.output);
  return usage.inputTokens !== null && usage.outputTokens !== null ? "unpriced" : "unknown";
}

function addAmount(map: Map<string, number>, currency: string, amount: number): void {
  map.set(currency, (map.get(currency) ?? 0) + amount);
}

function toCurrencyAmounts(map: Map<string, number>): CostCurrencyAmount[] {
  return Array.from(map.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function dataQualityFor(known: number, unresolved: number): AiCostDataQuality {
  if (unresolved === 0) return "known";
  if (known === 0) return "unknown";
  return "partial";
}

type AiCostEventRow = { organization_id: string; currency: string; total_cost: number };
type AiInteractionRow = { id: string; organization_id: string; interaction_type: string; output: unknown };

/**
 * Two batched queries, each scoped to the full authorized organization id
 * list in one call (never one query per organization) - mirrors
 * lib/agency/cost-readiness.ts's loadAiTokenBreakdown and
 * lib/agency/revenue.ts's loadRevenueEvents exactly. `failed` is true only
 * on a real Postgrest error - genuine emptiness (no cost events / no
 * interactions yet) is a valid, non-failed result.
 */
export async function loadCostEvents(
  serviceSupabase: SupabaseClient,
  organizationIds: string[],
  range: ResolvedDateRange,
): Promise<{ rows: AiCostEventRow[]; failed: boolean }> {
  if (organizationIds.length === 0) return { rows: [], failed: false };

  let query = serviceSupabase
    .from("ai_cost_events")
    .select("organization_id, currency, total_cost")
    .in("organization_id", organizationIds)
    .limit(MAX_AI_COST_EVENT_ROWS);
  if (range.from) query = query.gte("occurred_at", range.from);
  if (range.to) query = query.lt("occurred_at", range.to);

  const { data, error } = await query;
  if (error) return { rows: [], failed: true };
  return { rows: (data ?? []) as AiCostEventRow[], failed: false };
}

export async function loadInteractions(
  serviceSupabase: SupabaseClient,
  organizationIds: string[],
  range: ResolvedDateRange,
): Promise<{ rows: AiInteractionRow[]; failed: boolean }> {
  if (organizationIds.length === 0) return { rows: [], failed: false };

  let query = serviceSupabase
    .from("ai_interactions")
    .select("id, organization_id, interaction_type, output")
    .in("organization_id", organizationIds)
    .limit(MAX_AI_INTERACTION_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data, error } = await query;
  if (error) return { rows: [], failed: true };
  return { rows: (data ?? []) as AiInteractionRow[], failed: false };
}

/**
 * The primary Phase 5D-2 read. Defaults to lifetime ("allTime") for the same
 * reason lib/agency/revenue.ts does - this is a financial/economics figure,
 * not a usage-activity view.
 */
export async function getAgencyAiCosts(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
  rangeInput: DateRangeInput = "allTime",
): Promise<AgencyAiCostResult> {
  const resolved = await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);
  if (!resolved.ok) return resolved;

  const range = resolveDateRange(rangeInput);
  const organizationIds = resolved.organizations.map((org) => org.organizationId);

  const [costEvents, interactions] = await Promise.all([
    loadCostEvents(serviceSupabase, organizationIds, range),
    loadInteractions(serviceSupabase, organizationIds, range),
  ]);

  const knownCostByOrg = new Map<string, Map<string, number>>();
  const knownCountByOrg = new Map<string, number>();
  const agencyKnownCost = new Map<string, number>();

  for (const org of resolved.organizations) {
    knownCostByOrg.set(org.organizationId, new Map());
    knownCountByOrg.set(org.organizationId, 0);
  }

  for (const row of costEvents.rows) {
    const orgMap = knownCostByOrg.get(row.organization_id);
    if (orgMap) {
      addAmount(orgMap, row.currency, row.total_cost);
      knownCountByOrg.set(row.organization_id, (knownCountByOrg.get(row.organization_id) ?? 0) + 1);
    }
    addAmount(agencyKnownCost, row.currency, row.total_cost);
  }

  const unpricedCountByOrg = new Map<string, number>();
  const unknownCountByOrg = new Map<string, number>();
  let agencyUnpriced = 0;
  let agencyUnknown = 0;

  // The set of interaction ids already represented by a known cost event -
  // an interaction is either known (in ai_cost_events) OR unresolved
  // (unpriced/unknown), never both, so this membership check is the entire
  // classification boundary. ai_cost_events guarantees at most one row per
  // source_interaction_id (unique constraint), so membership alone is
  // sufficient - no need to also compare amounts.
  const knownInteractionIds = new Set<string>();

  for (const org of resolved.organizations) {
    unpricedCountByOrg.set(org.organizationId, 0);
    unknownCountByOrg.set(org.organizationId, 0);
  }

  // A second, minimal query: which interaction ids in this exact set already
  // have a known cost event - needed to avoid double-counting an interaction
  // as both "known" (via the aggregate query above) and "unresolved" (via
  // classification below), without having to select total_cost per-row
  // twice. Scoped to exactly the interaction ids already loaded, never a
  // second full-table scan.
  const interactionIds = interactions.rows.map((row) => row.id);
  if (interactionIds.length > 0 && !interactions.failed) {
    const { data: knownRows, error: knownError } = await serviceSupabase
      .from("ai_cost_events")
      .select("source_interaction_id")
      .in("source_interaction_id", interactionIds);
    if (!knownError) {
      for (const row of (knownRows ?? []) as { source_interaction_id: string }[]) {
        knownInteractionIds.add(row.source_interaction_id);
      }
    }
  }

  for (const row of interactions.rows) {
    if (knownInteractionIds.has(row.id)) continue;

    const classification = classifyUnresolvedAiInteraction({ interactionType: row.interaction_type, output: row.output });
    if (classification === "unpriced") {
      unpricedCountByOrg.set(row.organization_id, (unpricedCountByOrg.get(row.organization_id) ?? 0) + 1);
      agencyUnpriced += 1;
    } else {
      unknownCountByOrg.set(row.organization_id, (unknownCountByOrg.get(row.organization_id) ?? 0) + 1);
      agencyUnknown += 1;
    }
  }

  const clients: ClientAiCostSummary[] = resolved.organizations.map((org) => {
    const known = knownCountByOrg.get(org.organizationId) ?? 0;
    const unpriced = unpricedCountByOrg.get(org.organizationId) ?? 0;
    const unknown = unknownCountByOrg.get(org.organizationId) ?? 0;
    return {
      organizationId: org.organizationId,
      organizationName: org.organizationName,
      knownCost: toCurrencyAmounts(knownCostByOrg.get(org.organizationId) ?? new Map()),
      knownInteractionCount: known,
      unpricedInteractionCount: unpriced,
      unknownInteractionCount: unknown,
      dataQuality: dataQualityFor(known, unpriced + unknown),
    };
  });

  const totalKnown = Array.from(knownCountByOrg.values()).reduce((sum, n) => sum + n, 0);

  return {
    ok: true,
    range,
    totals: {
      knownCost: toCurrencyAmounts(agencyKnownCost),
      knownInteractionCount: totalKnown,
      unpricedInteractionCount: agencyUnpriced,
      unknownInteractionCount: agencyUnknown,
    },
    clients,
    partialData: costEvents.failed || interactions.failed,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Trackpr Phase 5D-4 - SMS Cost Intelligence read layer. Reads exclusively
// from sms_cost_events (populated by lib/costs/sms-cost-events.ts, called
// best-effort from both SMS webhooks - see app/api/webhooks/sms/status and
// .../inbound) plus messages (to count what's still unresolved). There is
// NO "unpriced" state for SMS - Twilio's own fetched price is the
// authoritative cost directly, with no rate_cards lookup involved at all -
// so every message not represented by a known sms_cost_events row is simply
// "unknown" (whether because it had no provider SID, the fetch failed, or
// Twilio's price wasn't yet finalized at the one best-effort attempt this
// phase makes - automatic reconciliation is explicitly deferred).
// ---------------------------------------------------------------------------

const MAX_SMS_COST_EVENT_ROWS = 50_000;
const MAX_MESSAGE_ROWS = 50_000;

export type AgencySmsCostTotals = {
  /** Sum of sms_cost_events.price, per currency. */
  knownCost: CostCurrencyAmount[];
  /** Count of messages (either direction) that produced a known sms_cost_events row. */
  knownMessageCount: number;
  /** Count of messages with no known cost event - no provider SID, a permanently failed fetch, or a price never finalized within this phase's one best-effort attempt. */
  unknownMessageCount: number;
};

export type ClientSmsCostSummary = {
  organizationId: string;
  organizationName: string;
  knownCost: CostCurrencyAmount[];
  knownMessageCount: number;
  unknownMessageCount: number;
  /** "known" also covers a genuine zero-message organization - a confirmed absence of SMS activity, not an unresolved cost. */
  dataQuality: AiCostDataQuality;
};

export type AgencySmsCostResult =
  | {
      ok: true;
      range: ResolvedDateRange;
      totals: AgencySmsCostTotals;
      clients: ClientSmsCostSummary[];
      partialData: boolean;
      generatedAt: string;
    }
  | AgencyAuthFailure;

type SmsCostEventRow = { organization_id: string; currency: string; price: number };
type MessageRow = { id: string; organization_id: string };

/** Mirrors loadCostEvents above exactly - one batched query across the full authorized organization id list, `failed` true only on a real Postgrest error. */
export async function loadSmsCostEvents(
  serviceSupabase: SupabaseClient,
  organizationIds: string[],
  range: ResolvedDateRange,
): Promise<{ rows: SmsCostEventRow[]; failed: boolean }> {
  if (organizationIds.length === 0) return { rows: [], failed: false };

  let query = serviceSupabase
    .from("sms_cost_events")
    .select("organization_id, currency, price")
    .in("organization_id", organizationIds)
    .limit(MAX_SMS_COST_EVENT_ROWS);
  if (range.from) query = query.gte("occurred_at", range.from);
  if (range.to) query = query.lt("occurred_at", range.to);

  const { data, error } = await query;
  if (error) return { rows: [], failed: true };
  return { rows: (data ?? []) as SmsCostEventRow[], failed: false };
}

/** No interaction_type/output classification needed here (unlike loadInteractions for AI) - SMS has only two states, so membership in sms_cost_events alone determines known vs unknown. */
export async function loadMessagesForCost(
  serviceSupabase: SupabaseClient,
  organizationIds: string[],
  range: ResolvedDateRange,
): Promise<{ rows: MessageRow[]; failed: boolean }> {
  if (organizationIds.length === 0) return { rows: [], failed: false };

  let query = serviceSupabase
    .from("messages")
    .select("id, organization_id")
    .in("organization_id", organizationIds)
    .limit(MAX_MESSAGE_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data, error } = await query;
  if (error) return { rows: [], failed: true };
  return { rows: (data ?? []) as MessageRow[], failed: false };
}

/**
 * The primary Phase 5D-4 read. Calls resolveAgencyOrganizations() exactly
 * once, independently of getAgencyAiCosts() above - the two are separate
 * top-level reads, matching this codebase's own existing convention
 * (getAgencyRevenue/getAgencyAiCosts/getAgencyCostReadiness are each their
 * own entry point, never sharing one resolution across unrelated report
 * types). Defaults to lifetime for the same reason every other cost/revenue
 * read in this codebase does.
 */
export async function getAgencySmsCosts(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
  rangeInput: DateRangeInput = "allTime",
): Promise<AgencySmsCostResult> {
  const resolved = await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);
  if (!resolved.ok) return resolved;

  const range = resolveDateRange(rangeInput);
  const organizationIds = resolved.organizations.map((org) => org.organizationId);

  const [costEvents, messages] = await Promise.all([
    loadSmsCostEvents(serviceSupabase, organizationIds, range),
    loadMessagesForCost(serviceSupabase, organizationIds, range),
  ]);

  const knownCostByOrg = new Map<string, Map<string, number>>();
  const knownCountByOrg = new Map<string, number>();
  const agencyKnownCost = new Map<string, number>();

  for (const org of resolved.organizations) {
    knownCostByOrg.set(org.organizationId, new Map());
    knownCountByOrg.set(org.organizationId, 0);
  }

  for (const row of costEvents.rows) {
    const orgMap = knownCostByOrg.get(row.organization_id);
    if (orgMap) {
      addAmount(orgMap, row.currency, row.price);
      knownCountByOrg.set(row.organization_id, (knownCountByOrg.get(row.organization_id) ?? 0) + 1);
    }
    addAmount(agencyKnownCost, row.currency, row.price);
  }

  const unknownCountByOrg = new Map<string, number>();
  let agencyUnknown = 0;

  for (const org of resolved.organizations) {
    unknownCountByOrg.set(org.organizationId, 0);
  }

  // Which message ids in this exact set already have a known cost event -
  // needed to avoid double-counting a message as both known (via the
  // aggregate query above) and unresolved (via the count below). Scoped to
  // exactly the message ids already loaded, never a second full-table scan.
  const knownMessageIds = new Set<string>();
  const messageIds = messages.rows.map((row) => row.id);
  if (messageIds.length > 0 && !messages.failed) {
    const { data: knownRows, error: knownError } = await serviceSupabase
      .from("sms_cost_events")
      .select("source_message_id")
      .in("source_message_id", messageIds);
    if (!knownError) {
      for (const row of (knownRows ?? []) as { source_message_id: string }[]) {
        knownMessageIds.add(row.source_message_id);
      }
    }
  }

  for (const row of messages.rows) {
    if (knownMessageIds.has(row.id)) continue;
    unknownCountByOrg.set(row.organization_id, (unknownCountByOrg.get(row.organization_id) ?? 0) + 1);
    agencyUnknown += 1;
  }

  const clients: ClientSmsCostSummary[] = resolved.organizations.map((org) => {
    const known = knownCountByOrg.get(org.organizationId) ?? 0;
    const unknown = unknownCountByOrg.get(org.organizationId) ?? 0;
    return {
      organizationId: org.organizationId,
      organizationName: org.organizationName,
      knownCost: toCurrencyAmounts(knownCostByOrg.get(org.organizationId) ?? new Map()),
      knownMessageCount: known,
      unknownMessageCount: unknown,
      dataQuality: dataQualityFor(known, unknown),
    };
  });

  const totalKnown = Array.from(knownCountByOrg.values()).reduce((sum, n) => sum + n, 0);

  return {
    ok: true,
    range,
    totals: {
      knownCost: toCurrencyAmounts(agencyKnownCost),
      knownMessageCount: totalKnown,
      unknownMessageCount: agencyUnknown,
    },
    clients,
    partialData: costEvents.failed || messages.failed,
    generatedAt: new Date().toISOString(),
  };
}
