import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Trackpr Phase 5D-2 - rate_cards read layer. Global, provider-level pricing
 * only - this file never accepts or queries by an organization id, matching
 * the migration's own "NOT organization-specific" design (see
 * 20260927000000_ai_cost_intelligence.sql). Historical pricing accuracy is
 * mandatory: a rate lookup is always anchored to the interaction's own
 * occurred_at, never "now" - applying today's rate to historical usage is
 * exactly the mistake this module exists to prevent.
 */

export type RateCardUnit = "input_token" | "output_token";

export type RateCard = {
  id: string;
  provider: string;
  service: string;
  model: string | null;
  unit: string;
  unitPrice: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type RateCardLookup = {
  provider: string;
  service: string;
  model: string | null;
  unit: RateCardUnit;
  /** The interaction's own timestamp - never "now". */
  occurredAt: string;
};

type RateCardRow = {
  id: string;
  provider: string;
  service: string;
  model: string | null;
  unit: string;
  unit_price: number;
  currency: string;
  effective_from: string;
  effective_to: string | null;
};

function mapRow(row: RateCardRow): RateCard {
  return {
    id: row.id,
    provider: row.provider,
    service: row.service,
    model: row.model,
    unit: row.unit,
    unitPrice: row.unit_price,
    currency: row.currency,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

/**
 * Pure, no I/O - directly unit-testable. Boundary semantics are explicit and
 * match the task's own spec exactly: effective_from <= occurredAt AND
 * (effective_to IS NULL OR occurredAt < effective_to) - inclusive start,
 * exclusive end, identical to lib/bi/queries.ts's own ResolvedDateRange
 * convention elsewhere in this codebase. If more than one active candidate
 * somehow matches (the database's own exclusion constraint on rate_cards
 * should make this impossible for active rows - see the migration), the
 * most recently started one is preferred; this is a defensive tie-break,
 * never an average or a guess between candidates.
 */
export function selectApplicableRateCard(candidates: RateCard[], occurredAt: string): RateCard | null {
  const occurredMs = new Date(occurredAt).getTime();

  const matching = candidates.filter((card) => {
    const fromMs = new Date(card.effectiveFrom).getTime();
    if (occurredMs < fromMs) return false;
    if (card.effectiveTo !== null && occurredMs >= new Date(card.effectiveTo).getTime()) return false;
    return true;
  });

  if (matching.length === 0) return null;

  matching.sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime());
  return matching[0];
}

/**
 * The one query this module issues per lookup - scoped to exactly the
 * provider/service/model/unit requested, active rows only. Returns
 * `failed: true` only on a real Postgrest error, never on genuine emptiness
 * (which correctly means "no rate card exists for this yet" - unpriced, not
 * a failure).
 */
export async function loadRateCardCandidates(
  supabase: SupabaseClient,
  params: { provider: string; service: string; model: string | null; unit: RateCardUnit },
): Promise<{ rows: RateCard[]; failed: boolean }> {
  let query = supabase
    .from("rate_cards")
    .select("id, provider, service, model, unit, unit_price, currency, effective_from, effective_to")
    .eq("provider", params.provider)
    .eq("service", params.service)
    .eq("unit", params.unit)
    .eq("active", true);

  query = params.model === null ? query.is("model", null) : query.eq("model", params.model);

  const { data, error } = await query;
  if (error) return { rows: [], failed: true };

  return { rows: (data ?? []).map(mapRow), failed: false };
}

/**
 * Combines the query and the pure selection - the one function callers
 * (lib/costs/ai-cost-events.ts) actually use. Returns null on either a real
 * query failure or a genuine "no matching rate card" - the caller cannot
 * distinguish the two from this return value alone by design, because both
 * resolve to the exact same honest outcome for cost purposes: this
 * interaction cannot be priced right now. (A distinct failed-vs-empty signal
 * is available via loadRateCardCandidates directly, for a caller that needs
 * to tell "unpriced" apart from "the rate_cards query itself errored," which
 * lib/agency/costs.ts's own reporting does separately at the aggregate
 * level.)
 */
export async function findApplicableRateCard(supabase: SupabaseClient, lookup: RateCardLookup): Promise<RateCard | null> {
  const { rows, failed } = await loadRateCardCandidates(supabase, lookup);
  if (failed) return null;
  return selectApplicableRateCard(rows, lookup.occurredAt);
}
