import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Pass 3 (Revenue Intelligence Foundation): the read layer for
 * `opportunities` (see supabase/migrations/20260925020000_opportunities.sql
 * for the schema and its own rationale). Mirrors this codebase's established
 * queries-vs-detection split (e.g. lib/scheduling/blocked-time.ts for reads
 * vs. the calendar's own actions.ts for writes) - detection/sync writes live
 * in lib/opportunities/detect.ts, the dismiss action lives in
 * app/(app)/dashboard/actions.ts, this file only ever reads.
 */

export type OpportunityType =
  | "qualified_lead_unbooked"
  | "stale_estimate"
  | "completed_appointment_no_estimate"
  | "dormant_customer"
  | "no_show"
  | "completed_job_no_referral_request"
  | "completed_job_no_review_request"
  | "cancelled_appointment_no_rebooking"
  | "uncontacted_lead"
  | "accepted_estimate_no_job";

export type OpportunityStatus = "open" | "resolved" | "dismissed";

export type Opportunity = {
  id: string;
  type: OpportunityType;
  status: OpportunityStatus;
  sourceEntityType: "lead" | "estimate" | "appointment" | "contact" | "job";
  sourceEntityId: string;
  contactId: string | null;
  title: string;
  description: string | null;
  /** Real, nullable. NULL means "no reliable dollar figure for this opportunity" - never coerced to 0, never fabricated. See valueBasis for provenance when non-null. */
  estimatedValue: number | null;
  /** Plain-English source of estimatedValue (e.g. "leads.estimated_value") - null whenever estimatedValue is null. */
  valueBasis: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  metadata: Record<string, unknown>;
};

type OpportunityRow = {
  id: string;
  type: OpportunityType;
  status: OpportunityStatus;
  source_entity_type: "lead" | "estimate" | "appointment" | "contact" | "job";
  source_entity_id: string;
  contact_id: string | null;
  title: string;
  description: string | null;
  estimated_value: number | null;
  value_basis: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  metadata: Record<string, unknown> | null;
};

function normalizeOpportunity(row: OpportunityRow): Opportunity {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    sourceEntityType: row.source_entity_type,
    sourceEntityId: row.source_entity_id,
    contactId: row.contact_id,
    title: row.title,
    description: row.description,
    estimatedValue: row.estimated_value,
    valueBasis: row.value_basis,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    metadata: row.metadata ?? {},
  };
}

const OPPORTUNITY_COLUMNS = "id, type, status, source_entity_type, source_entity_id, contact_id, title, description, estimated_value, value_basis, created_at, updated_at, resolved_at, metadata";

export type OpenOpportunitiesResult = { data: Opportunity[]; failed: boolean };

/**
 * Trackpr 2.0, Phase 4B (P1 #5): same read as getOpenOpportunities below,
 * but distinguishes "genuinely zero open opportunities" from "the read
 * itself failed" - `failed` is true only on a real Postgrest error, never
 * on a genuine `{ data: [], error: null }` response. Added for
 * app/(app)/opportunities/page.tsx specifically, which must never render
 * "You're all caught up." when the query actually failed. Dismissal,
 * resolution, and organization scoping are completely unchanged - this is
 * the exact same query, just with its error observed instead of discarded.
 * Every other, lower-stakes caller (Dashboard, Contact Detail) keeps using
 * getOpenOpportunities below unchanged.
 */
export async function getOpenOpportunitiesResult(supabase: SupabaseClient, organizationId: string): Promise<OpenOpportunitiesResult> {
  const { data, error } = await supabase
    .from("opportunities")
    .select(OPPORTUNITY_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(500);

  return { data: ((data ?? []) as OpportunityRow[]).map(normalizeOpportunity), failed: error != null };
}

/** Every currently-open opportunity for the org, newest first - the primary read for both the dashboard summary and the Attention Engine. */
export async function getOpenOpportunities(supabase: SupabaseClient, organizationId: string): Promise<Opportunity[]> {
  return (await getOpenOpportunitiesResult(supabase, organizationId)).data;
}

export type OpportunitySummary = {
  count: number;
  /** SUM(estimated_value) over open opportunities with a non-null value - real dollars only, never a fabricated figure standing in for the unknown-value ones. */
  knownEstimatedValue: number;
  /** Count of open opportunities whose estimated_value is NULL - the UI must show this distinctly from knownEstimatedValue, never silently drop it or imply it's worth $0. */
  unknownValueCount: number;
  byType: Record<OpportunityType, number>;
};

const EMPTY_BY_TYPE: Record<OpportunityType, number> = {
  qualified_lead_unbooked: 0,
  stale_estimate: 0,
  completed_appointment_no_estimate: 0,
  dormant_customer: 0,
  no_show: 0,
  completed_job_no_referral_request: 0,
  completed_job_no_review_request: 0,
  cancelled_appointment_no_rebooking: 0,
  uncontacted_lead: 0,
  accepted_estimate_no_job: 0,
};

/** Summarizes an already-fetched open-opportunity list - kept as a pure function (no I/O) so it's directly unit-testable with controlled input, matching this codebase's established pure/impure split. */
export function summarizeOpportunities(opportunities: Opportunity[]): OpportunitySummary {
  let knownEstimatedValue = 0;
  let unknownValueCount = 0;
  const byType: Record<OpportunityType, number> = { ...EMPTY_BY_TYPE };

  for (const opportunity of opportunities) {
    byType[opportunity.type] += 1;
    if (opportunity.estimatedValue != null) {
      knownEstimatedValue += opportunity.estimatedValue;
    } else {
      unknownValueCount += 1;
    }
  }

  return { count: opportunities.length, knownEstimatedValue, unknownValueCount, byType };
}

/** Scoped to the org, matching every other single-row lookup in this codebase - any error (invalid id, wrong org) resolves to null rather than throwing. */
export async function getOpportunityById(supabase: SupabaseClient, organizationId: string, id: string): Promise<Opportunity | null> {
  const { data, error } = await supabase.from("opportunities").select(OPPORTUNITY_COLUMNS).eq("id", id).eq("organization_id", organizationId).maybeSingle();
  if (error || !data) return null;
  return normalizeOpportunity(data as OpportunityRow);
}
