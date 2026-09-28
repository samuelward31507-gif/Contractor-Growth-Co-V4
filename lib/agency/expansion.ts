import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgencyOrganizations, type AgencyAuthFailure, type AgencyOrganization } from "./queries";
import { getOpenOpportunitiesResult, type Opportunity, type OpportunityType } from "@/lib/opportunities/queries";
import { computeOnboardingReadiness, type OnboardingReadiness } from "@/lib/onboarding/readiness";

/**
 * Trackpr Phase 5A - Agency Expansion Intelligence.
 *
 * This is a thin, read-only aggregation layer over two systems that already
 * exist and are the sole sources of truth: the Opportunity Engine
 * (lib/opportunities/detect.ts + queries.ts) and the onboarding readiness
 * computation (lib/onboarding/readiness.ts). Nothing here detects anything,
 * scores anything, or invents a dollar figure - it only (1) resolves which
 * organizations the calling agency admin may see, via the exact same
 * resolveAgencyOrganizations chokepoint every other lib/agency/* function
 * uses, and (2) calls the existing per-organization read for each resolved
 * organization, attaching the organization's name and a static, deterministic
 * "which service would address this" label. Mirrors the fan-out shape
 * lib/agency/queries.ts's own getAgencyOrganizationSnapshots already uses
 * (resolve once, then Promise.all one read per organization) - not a new
 * aggregation architecture.
 */

export type ExpansionConfidence = "high" | "medium" | "informational";

/**
 * Every one of the Opportunity Engine's 12 types maps to exactly one of
 * these 7 service labels. Deliberately a `Record<OpportunityType, string>`
 * (not a plain object typed `Record<string, string>`) - TypeScript enforces
 * that this mapping stays exhaustive. If lib/opportunities/detect.ts/queries.ts
 * ever adds another OpportunityType, this file fails to compile until a
 * conscious mapping decision is made here - the mapping can never silently
 * fall back to an invented or default service label for a type nobody has
 * actually decided how to sell yet.
 *
 * Explicitly excluded, per Phase 5A's own scope: missed_call_recovery,
 * ai_receptionist, marketing_expansion, website_conversion - none of the 10
 * existing detector types correspond to any of these, and no call-tracking
 * or integration data exists to justify inventing one.
 */
export const OPPORTUNITY_TYPE_TO_SERVICE: Record<OpportunityType, string> = {
  stale_estimate: "Estimate Recovery",
  accepted_estimate_no_job: "Estimate Recovery",
  qualified_lead_unbooked: "Lead Response / Booking Assist",
  uncontacted_lead: "Lead Response / Booking Assist",
  dormant_customer: "Customer Reactivation",
  completed_job_no_review_request: "Review Growth",
  completed_job_no_referral_request: "Referral Program",
  no_show: "Scheduling Optimization",
  cancelled_appointment_no_rebooking: "Scheduling Optimization",
  completed_appointment_no_estimate: "Estimate Follow-Through",
  // Canonical Opportunity Intelligence Layer: these 2 types replace the
  // Attention Engine's own non-persisted hot_lead/high_value_lead/
  // pending_estimate conditions with real, persisted opportunities (see
  // lib/opportunities/detect.ts) - mapped to the same service line as their
  // closest sibling type.
  active_lead_signal: "Lead Response / Booking Assist",
  pending_estimate: "Estimate Recovery",
};

/**
 * These 3 types are the ones where `estimatedValue`, when non-null, is NOT a
 * quoted/pipeline dollar figure at risk - it is either structurally always
 * null (completed_appointment_no_estimate - no estimate has ever existed to
 * price) or, for completed_job_no_review_request specifically, the
 * ALREADY-COMPLETED job's own contracted amount (see that detector's own
 * comment in detect.ts: "unlike the referral opportunity above... this one
 * DOES surface the completed job's own known value... as honest context for
 * the size of the job"). completed_job_no_referral_request's estimatedValue
 * is always null by the same reasoning, kept in this set for the identical
 * treatment as its sibling review-request type.
 *
 * Per the task's own value-semantics rule ("the completed job's amount may
 * be useful context, but DO NOT treat already-earned job revenue as revenue
 * at risk"), any value on one of these 3 types is surfaced on the individual
 * AgencyExpansionOpportunity (isContextualValue: true) but is EXCLUDED from
 * AgencyExpansionSummary.knownOpportunityValue and from
 * unknownValueOpportunityCount - counted instead in its own
 * contextualOpportunityCount, so it is never silently folded into either
 * bucket. This is a deliberate divergence introduced at this aggregation
 * layer only - detect.ts's own stored estimated_value is never modified.
 */
export const CONTEXTUAL_VALUE_TYPES: ReadonlySet<OpportunityType> = new Set([
  "completed_appointment_no_estimate",
  "completed_job_no_referral_request",
  "completed_job_no_review_request",
]);

/**
 * Deterministic classification only - no scoring model, no weighting, no
 * machine learning. Three real, distinct cases:
 *
 * - "high": a specific, individually-actionable record (a real estimate, a
 *   real qualified lead, a real customer) with a known, non-null monetary
 *   value attached.
 * - "medium": a specific, individually-actionable record whose monetary
 *   value is genuinely unknown - still a real, named record worth
 *   investigating, just with no reliable dollar figure to quote yet.
 * - "informational": the type is in CONTEXTUAL_VALUE_TYPES - the signal
 *   itself is a process/relationship gap (no estimate was ever created; a
 *   completed job never got a review/referral ask), not a quoted dollar
 *   amount at risk, even on the rare row where a job's own contracted amount
 *   happens to be attached as size-of-job context.
 */
export function classifyExpansionConfidence(type: OpportunityType, estimatedValue: number | null): ExpansionConfidence {
  if (CONTEXTUAL_VALUE_TYPES.has(type)) return "informational";
  return estimatedValue != null ? "high" : "medium";
}

export type AgencyExpansionOpportunity = {
  opportunityId: string;
  organizationId: string;
  organizationName: string;
  type: OpportunityType;
  title: string;
  /** Faithfully preserves Opportunity.description's real nullability (see lib/opportunities/queries.ts) - every current detector always sets a real string, but this type never claims a stronger guarantee than the source type actually makes. */
  description: string | null;
  /** Real, nullable, exactly as stored by the Opportunity Engine - never coerced to 0. See CONTEXTUAL_VALUE_TYPES for the one case where a non-null value here is context, not opportunity value. */
  estimatedValue: number | null;
  valueBasis: string | null;
  /**
   * Always 1. The Opportunity Engine already detects one row per individual
   * affected record (one estimate, one lead, one customer, one appointment) -
   * a single AgencyExpansionOpportunity represents exactly one such record, so
   * there is nothing this layer could count beyond 1 without inventing a
   * second, divergent counting rule. A per-client, per-service GROUP count
   * (e.g. "3 Estimate Recovery opportunities for ABC Roofing") is a
   * presentation-layer sum over items sharing the same organizationId +
   * recommendedService, computed by the page UI - mirroring exactly how
   * app/agency/_components/needs-attention.tsx groups NeedsAttentionItem by
   * category in the component, not in the data-fetching function.
   */
  affectedCount: 1;
  recommendedService: string;
  confidence: ExpansionConfidence;
  /** True for any type in CONTEXTUAL_VALUE_TYPES - see that constant's own comment. The UI must never add this item's estimatedValue into a "known opportunity value" total. */
  isContextualValue: boolean;
  createdAt: string;
  updatedAt: string;
  actionHref: string | null;
  actionLabel: string | null;
};

export type AgencyExpansionSummary = {
  organizationsWithOpportunities: number;
  openOpportunityCount: number;
  /**
   * SUM(estimatedValue) over open opportunities that are NOT a contextual-
   * value type and whose estimatedValue is non-null. Quoted/pipeline value
   * only, matching this codebase's "no revenue terminology" rule everywhere
   * else (see lib/agency/queries.ts's own header comment) - never collected
   * or earned revenue, and never a completed job's own already-earned
   * amount (see CONTEXTUAL_VALUE_TYPES).
   */
  knownOpportunityValue: number;
  /** Count of open, non-contextual-type opportunities with a null estimatedValue - real and actionable, but with no reliable dollar figure. Never summed into knownOpportunityValue, never displayed as $0. */
  unknownValueOpportunityCount: number;
  /** Count of open opportunities whose type is in CONTEXTUAL_VALUE_TYPES - kept fully separate from both figures above; these represent a process/relationship gap, not a quoted dollar amount at risk. */
  contextualOpportunityCount: number;
};

export type AgencyExpansionResult =
  | {
      ok: true;
      opportunities: AgencyExpansionOpportunity[];
      summary: AgencyExpansionSummary;
      /** True only when at least one organization's opportunities read returned a real Postgrest error (getOpenOpportunitiesResult's own `failed` contract) - never set by a genuine "this client has zero open opportunities." Mirrors lib/agency/health.ts's identical stuckFailed/calendarFailed/paymentFailed convention exactly. A caller must disclose this, never silently render the page as if every client were clean. */
      partialData: boolean;
      generatedAt: string;
    }
  | AgencyAuthFailure;

function toAgencyExpansionOpportunity(opportunity: Opportunity, org: AgencyOrganization): AgencyExpansionOpportunity {
  const isContextualValue = CONTEXTUAL_VALUE_TYPES.has(opportunity.type);

  return {
    opportunityId: opportunity.id,
    organizationId: org.organizationId,
    organizationName: org.organizationName,
    type: opportunity.type,
    title: opportunity.title,
    description: opportunity.description,
    estimatedValue: opportunity.estimatedValue,
    valueBasis: opportunity.valueBasis,
    affectedCount: 1,
    recommendedService: OPPORTUNITY_TYPE_TO_SERVICE[opportunity.type],
    confidence: classifyExpansionConfidence(opportunity.type, opportunity.estimatedValue),
    isContextualValue,
    createdAt: opportunity.createdAt,
    updatedAt: opportunity.updatedAt,
    // The one existing per-client drill-down every other agency surface
    // (NeedsAttentionItem, StuckExecution) already links to - not a new
    // route, not a new opportunity-detail page.
    actionHref: `/agency/organizations/${org.organizationId}`,
    actionLabel: "View client",
  };
}

/** Pure, no I/O - directly unit-testable, matching lib/opportunities/queries.ts's own summarizeOpportunities convention exactly. */
export function summarizeAgencyExpansion(opportunities: AgencyExpansionOpportunity[]): AgencyExpansionSummary {
  const organizationIds = new Set<string>();
  let knownOpportunityValue = 0;
  let unknownValueOpportunityCount = 0;
  let contextualOpportunityCount = 0;

  for (const opportunity of opportunities) {
    organizationIds.add(opportunity.organizationId);

    if (opportunity.isContextualValue) {
      contextualOpportunityCount += 1;
      continue;
    }

    if (opportunity.estimatedValue != null) {
      knownOpportunityValue += opportunity.estimatedValue;
    } else {
      unknownValueOpportunityCount += 1;
    }
  }

  return {
    organizationsWithOpportunities: organizationIds.size,
    openOpportunityCount: opportunities.length,
    knownOpportunityValue,
    unknownValueOpportunityCount,
    contextualOpportunityCount,
  };
}

/**
 * The primary Phase 5A read. Never performs an unscoped service-role query -
 * every opportunities read below is for exactly one organization id drawn
 * from resolveAgencyOrganizations's own already-authorized list, the same
 * discipline every existing lib/agency/* function follows.
 */
export async function getAgencyExpansionOpportunities(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
): Promise<AgencyExpansionResult> {
  const resolved = await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);
  if (!resolved.ok) return resolved;

  // getOpenOpportunitiesResult (not the failure-swallowing getOpenOpportunities
  // wrapper) is used deliberately here - its {data, failed} shape is exactly
  // what's needed to distinguish "this client genuinely has zero open
  // opportunities" from "the read itself failed," the same distinction
  // app/(app)/opportunities/page.tsx already relies on it for.
  const perOrganization = await Promise.all(
    resolved.organizations.map(async (org) => ({
      org,
      ...(await getOpenOpportunitiesResult(serviceSupabase, org.organizationId)),
    })),
  );

  const partialData = perOrganization.some((entry) => entry.failed);

  const opportunities = perOrganization.flatMap(({ org, data }) => data.map((opportunity) => toAgencyExpansionOpportunity(opportunity, org)));

  return {
    ok: true,
    opportunities,
    summary: summarizeAgencyExpansion(opportunities),
    partialData,
    generatedAt: new Date().toISOString(),
  };
}

export type AgencyClientReadiness = {
  organizationId: string;
  organizationName: string;
  readiness: OnboardingReadiness;
};

export type AgencyExpansionReadinessResult = { ok: true; clients: AgencyClientReadiness[] } | AgencyAuthFailure;

/**
 * Client Readiness section's data source - computeOnboardingReadiness is
 * called completely unmodified, once per authorized organization, exactly
 * as app/agency/organizations/[id]/page.tsx already calls it (there via
 * computeSetupChecklist's own wrapping) for a single client. No new
 * readiness logic, no new states beyond "ready"/"not_ready"/
 * "disabled_by_intent" (see lib/onboarding/readiness.ts's own
 * ReadinessState) - Meta/Google/review-platform connections are never
 * claimed "Connected" here because computeOnboardingReadiness itself has no
 * such item; only the 7 real items it already computes are ever surfaced.
 */
export async function getAgencyExpansionReadiness(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
): Promise<AgencyExpansionReadinessResult> {
  const resolved = await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);
  if (!resolved.ok) return resolved;

  const clients = await Promise.all(
    resolved.organizations.map(async (org) => ({
      organizationId: org.organizationId,
      organizationName: org.organizationName,
      readiness: await computeOnboardingReadiness(serviceSupabase, org.organizationId),
    })),
  );

  return { ok: true, clients };
}
