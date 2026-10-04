import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "@/lib/bi/revenue-attribution";

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
  | "accepted_estimate_no_job"
  // Canonical Opportunity Intelligence Layer: replaces the Attention
  // Engine's own non-persisted hot_lead/high_value_lead conditions
  // (lib/dashboard/queries.ts) with a real, persisted opportunity - see
  // lib/opportunities/detect.ts's detectActiveLeadSignals for the exact
  // detection rule and its duplication-avoidance scope.
  | "active_lead_signal"
  // Canonical Opportunity Intelligence Layer: replaces the Attention
  // Engine's own non-persisted pending_estimate condition - see
  // detectPendingEstimates.
  | "pending_estimate"
  // Phase 1B-5 (Close the Money Loop): a job completed since invoicing went
  // live with no live invoice - see detectCompletedJobsNotInvoiced.
  | "completed_job_not_invoiced"
  // Phase 1B-5: an issued, unpaid invoice past its due date in the
  // organization's own calendar - see detectOverdueInvoices.
  | "invoice_overdue";

export type OpportunityStatus = "open" | "resolved" | "dismissed";

/**
 * Canonical Opportunity Intelligence Layer: only ever non-null once status
 * is 'resolved' or 'dismissed' (enforced by opportunities_resolution_reason_
 * requires_closed_check) - the minimum outcome/learning instrumentation the
 * approved design identified, without any event-sourcing architecture.
 * 'condition_no_longer_true' covers every ordinary detector-driven
 * auto-resolution (the lead got booked, the estimate is no longer expired,
 * etc.) except the one case worth distinguishing on its own: 'lost' (the
 * underlying lead's own status moved to 'lost'). 'dismissed' is the existing,
 * unchanged human "not now" action.
 */
export type OpportunityResolutionReason = "condition_no_longer_true" | "dismissed" | "lost";

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
  resolutionReason: OpportunityResolutionReason | null;
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
  resolution_reason: OpportunityResolutionReason | null;
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
    resolutionReason: row.resolution_reason ?? null,
    metadata: row.metadata ?? {},
  };
}

const OPPORTUNITY_COLUMNS =
  "id, type, status, source_entity_type, source_entity_id, contact_id, title, description, estimated_value, value_basis, created_at, updated_at, resolved_at, resolution_reason, metadata";

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
 *
 * Phase 2-4: request-memoized (React.cache, keyed on the request's Supabase
 * client) so Today's page, getPrioritizedOpportunities and the decision
 * context share one read instead of each paging through it. Outside a
 * server request it is a plain pass-through.
 */
export const getOpenOpportunitiesResult = cache(async (supabase: SupabaseClient, organizationId: string): Promise<OpenOpportunitiesResult> => {
  // Phase 3A-4: every open opportunity, paged (readAllPages) - the old single
  // read capped at 500 rows silently dropped the oldest open opportunities from the
  // summary totals and per-contact lists. Newest first with id as the
  // tie-break, so pages are stable and the order callers see is unchanged.
  // A failed page or the row limit is `failed` with no rows - never a
  // partial total.
  const read = await readAllPages<OpportunityRow>(() =>
    supabase.from("opportunities").select(OPPORTUNITY_COLUMNS).eq("organization_id", organizationId).eq("status", "open").order("created_at", { ascending: false }).order("id"),
  );

  return { data: read.failed ? [] : read.rows.map(normalizeOpportunity), failed: read.failed };
});

/** Every currently-open opportunity for the org, newest first - the primary read for both the dashboard summary and the Attention Engine. */
export async function getOpenOpportunities(supabase: SupabaseClient, organizationId: string): Promise<Opportunity[]> {
  return (await getOpenOpportunitiesResult(supabase, organizationId)).data;
}

/**
 * Phase 2-13 (§7, A12): the three value classes - never added together.
 *   committed     - money owed or contractually agreed: an overdue invoice's
 *                   balance, a completed job's amount, an accepted estimate.
 *   potential     - money that could be won: a sent or expired estimate's
 *                   amount, a lead's estimated value.
 *   non_monetary  - no honest dollar figure (reviews, referrals, no-shows,
 *                   cancellations, dormant customers, a visit with no
 *                   estimate) - never shown or counted as a missing value.
 */
export type OpportunityValueClass = "committed" | "potential" | "non_monetary";

export const OPPORTUNITY_VALUE_CLASS: Record<OpportunityType, OpportunityValueClass> = {
  invoice_overdue: "committed",
  completed_job_not_invoiced: "committed",
  accepted_estimate_no_job: "committed",
  pending_estimate: "potential",
  stale_estimate: "potential",
  uncontacted_lead: "potential",
  qualified_lead_unbooked: "potential",
  active_lead_signal: "potential",
  completed_job_no_review_request: "non_monetary",
  completed_job_no_referral_request: "non_monetary",
  no_show: "non_monetary",
  cancelled_appointment_no_rebooking: "non_monetary",
  dormant_customer: "non_monetary",
  completed_appointment_no_estimate: "non_monetary",
};

/**
 * §7 "no double counting", at the level of the DEAL - never the customer
 * (Phase 2-13 correction). Same deal: deduplicate. Same customer, different
 * deal: count separately. Contact identity is never a dedup key.
 *
 * Committed needs no rule here: the detectors make one deal's committed
 * records mutually exclusive (accepted_estimate_no_job only while the
 * estimate has no job; completed_job_not_invoiced only while the job has no
 * live invoice; invoice_overdue only with one), so every committed record is
 * its own revenue.
 *
 * Potential: a lead-level record (uncontacted / qualified / active lead) is
 * the same deal as a pending estimate for that same lead - linked explicitly
 * by the estimate's metadata.lead_id - and the estimate, the more advanced
 * record, supplies the value. The link is the deal's identity, so it holds
 * whether or not the estimate has an amount: with no amount the deal stays
 * unknown-valued (counted as unknown, never as $0) rather than falling back
 * to the lead's figure. (The detectors already suppress most of these pairs;
 * this keeps the totals right whatever is stored.) A stale (expired)
 * estimate carries no lead link, so it is never matched to a lead.
 */
const LEAD_LEVEL_TYPES = new Set<OpportunityType>(["uncontacted_lead", "qualified_lead_unbooked", "active_lead_signal"]);

/** Ids of the opportunities whose value is already counted through a more advanced record of the same deal. */
export function sameDealSupersededIds(opportunities: Opportunity[]): Set<string> {
  const leadIdsWithEstimate = new Set<string>();
  for (const opportunity of opportunities) {
    const leadId = opportunity.metadata.lead_id;
    if (opportunity.type === "pending_estimate" && typeof leadId === "string") leadIdsWithEstimate.add(leadId);
  }
  const superseded = new Set<string>();
  for (const opportunity of opportunities) {
    if (LEAD_LEVEL_TYPES.has(opportunity.type) && opportunity.sourceEntityType === "lead" && leadIdsWithEstimate.has(opportunity.sourceEntityId)) superseded.add(opportunity.id);
  }
  return superseded;
}

export type OpportunityClassTotal = {
  /** SUM(estimated_value) of the class's opportunities with a value, each deal counted once (sameDealSupersededIds) - real dollars, never a fabricated figure. */
  value: number;
  /** Open opportunities of this class. */
  count: number;
  /** Of those, how many have no value entered - shown distinctly, never treated as $0. */
  unknownValueCount: number;
};

export type OpportunitySummary = {
  count: number;
  /** Phase 2-13 (§7): one total per class, never one combined figure. */
  committed: OpportunityClassTotal;
  potential: OpportunityClassTotal;
  /** Non-monetary opportunities: no value dimension, never counted as missing a value. */
  nonMonetaryCount: number;
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
  active_lead_signal: 0,
  pending_estimate: 0,
  completed_job_not_invoiced: 0,
  invoice_overdue: 0,
};

/** Summarizes an already-fetched open-opportunity list - kept as a pure function (no I/O) so it's directly unit-testable with controlled input, matching this codebase's established pure/impure split. */
export function summarizeOpportunities(opportunities: Opportunity[]): OpportunitySummary {
  const byType: Record<OpportunityType, number> = { ...EMPTY_BY_TYPE };
  const committed: OpportunityClassTotal = { value: 0, count: 0, unknownValueCount: 0 };
  const potential: OpportunityClassTotal = { value: 0, count: 0, unknownValueCount: 0 };
  let nonMonetaryCount = 0;

  const superseded = sameDealSupersededIds(opportunities);

  for (const opportunity of opportunities) {
    byType[opportunity.type] += 1;
    const valueClass = OPPORTUNITY_VALUE_CLASS[opportunity.type];
    if (valueClass === "non_monetary") {
      nonMonetaryCount += 1;
      continue;
    }
    const total = valueClass === "committed" ? committed : potential;
    total.count += 1;
    if (opportunity.estimatedValue == null) {
      total.unknownValueCount += 1;
      continue;
    }
    if (!superseded.has(opportunity.id)) total.value += opportunity.estimatedValue;
  }

  return { count: opportunities.length, committed, potential, nonMonetaryCount, byType };
}

/** Scoped to the org, matching every other single-row lookup in this codebase - any error (invalid id, wrong org) resolves to null rather than throwing. */
export async function getOpportunityById(supabase: SupabaseClient, organizationId: string, id: string): Promise<Opportunity | null> {
  const { data, error } = await supabase.from("opportunities").select(OPPORTUNITY_COLUMNS).eq("id", id).eq("organization_id", organizationId).maybeSingle();
  if (error || !data) return null;
  return normalizeOpportunity(data as OpportunityRow);
}
