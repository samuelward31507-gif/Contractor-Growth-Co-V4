import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadStatus } from "@/lib/leads/queries";
import { readAllPages } from "./revenue-attribution";
import type { ResolvedDateRange, LeadStageTransitionMetrics, LeadStageTimingMetrics, ResponseTimeBucket, LeadResponseTimeMetrics } from "./types";

/**
 * Pass 5C, Batch 3A - Funnel Truth + Response Intelligence. Two genuinely
 * new BI capabilities, kept in their own file rather than added to the
 * "frozen" lib/bi/queries.ts (Phase 5.1) or "additive-only" lib/bi/metrics.ts
 * (Phase 5.2) - mirrors how lib/bi/insights.ts (Phase 5.3) was already kept
 * separate from those two. Both functions here are independently callable;
 * neither is currently wired into BusinessMetricsSnapshot's own shape (see
 * that type's own Batch 3A header comment in lib/bi/types.ts) - only
 * BiDataQuality.stageHistoryUnavailable, computed via
 * hasAnyLeadStageHistory below, is threaded into the existing snapshot.
 *
 * Part C (historical lead-stage funnel): built entirely on
 * lib/automation/lead-stage-history.ts's existing, already-tested
 * lead.stage_changed events (real automation_events rows, one per real
 * status transition, with a real previous_status/new_status/changed_at).
 * No new table. Every timing figure here is computed ONLY from an actual
 * recorded transition - never from leads.updated_at, never inferred from a
 * lead's current status, and never inferred merely because a related
 * appointment/estimate exists. A lead with no recorded transition
 * contributes to the population count but never to a timing average - see
 * LeadStageTimingMetrics's own doc comment in lib/bi/types.ts.
 *
 * Part D (lead response-time intelligence): built on the exact evidence
 * hierarchy Pass 5C Batch 2's uncontacted_lead opportunity detector already
 * established and proved correct - leads.contact_id ->
 * conversations.contact_id -> messages.conversation_id, counting only
 * messages.direction='outbound' AND status IN ('sent','delivered') as real
 * contact. See LeadResponseTimeMetrics's own doc comment in lib/bi/types.ts
 * for the full population/limitation documentation.
 *
 * Query strategy: every function below issues a small, fixed number of
 * bounded, org-scoped queries and reduces in memory - the same discipline
 * lib/bi/queries.ts and lib/opportunities/detect.ts already established.
 * No query here is issued inside a loop; no per-lead query exists.
 *
 * Pass 5C, Batch 3B: getLeadStageTimingMetrics and getLeadResponseTimeMetrics
 * both independently re-fetched the exact same range-scoped `leads` rows
 * (with slightly different column subsets) as each other, and as
 * lib/bi/queries.ts's own getLeadAndPipelineMetrics - three separate reads
 * of the same population. getLeadsForRange below is the one shared fetch;
 * getLeadStageTimingMetrics/getLeadResponseTimeMetrics now accept its
 * result directly instead of querying `leads` themselves. This changes
 * nothing about WHAT either function reads or how it reduces it - same
 * columns needed, same date-range semantics, same in-memory logic - only
 * WHERE the query is issued moves, from inside each function to their
 * shared caller (lib/bi/metrics.ts). lib/bi/queries.ts's own
 * getLeadAndPipelineMetrics (Phase 5.1, frozen) is deliberately NOT
 * touched or merged into this shared fetch - out of this pass's scope.
 * getLeadStageTransitionMetrics and hasAnyLeadStageHistory never read
 * `leads` at all (both query only automation_events) and are unaffected.
 *
 * Phase 2F: every row read here goes through readAllPages (Phase 2C) -
 * paged by 1000, failing rather than returning a partial result. The API
 * caps a response at 1000 rows, so the old single reads silently dropped
 * everything past it (oldest-first message reads dropped the newest
 * replies). No read sends an ID list any more: an ID list fails outright
 * at roughly 400 ids (the request URL grows too long). Stage events and
 * outbound messages are read for the organization from the earliest lead's
 * creation onward - nothing earlier can count for any lead in the
 * population - and matched to the leads in memory. A failed read returns
 * `failed` with empty figures, which the snapshot reports as unavailable,
 * never as zero.
 */

/** The exact union of lead columns getLeadStageTimingMetrics and getLeadResponseTimeMetrics each need - no more. */
export type SharedLeadRow = {
  id: string;
  contact_id: string | null;
  created_at: string;
};

/**
 * The one shared, range-scoped `leads` fetch reused by
 * getLeadStageTimingMetrics and getLeadResponseTimeMetrics - see this
 * file's own Batch 3B header comment. Identical org-scoping and
 * [from, to) date-range semantics to what each function's own internal
 * fetch previously used - narrowed to exactly the columns either function
 * actually reads (id, contact_id, created_at), never leads.status (this
 * remains true for both callers: neither infers a historical stage from
 * current status).
 */
export type SharedLeadsResult = { leads: SharedLeadRow[]; failed: boolean };

/** Trackpr 2.0, Phase 4C (P2 #1): `failed` is true only on a real Postgrest error, never on genuine emptiness - see lib/bi/queries.ts's getLeadAndPipelineMetrics for the full discipline this mirrors. */
export async function getLeadsForRangeResult(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<SharedLeadsResult> {
  const read = await readAllPages<SharedLeadRow>(() => {
    let query = supabase.from("leads").select("id, contact_id, created_at").eq("organization_id", organizationId);
    if (range.from) query = query.gte("created_at", range.from);
    if (range.to) query = query.lt("created_at", range.to);
    return query.order("id");
  });
  return read.failed ? { leads: [], failed: true } : { leads: read.rows, failed: false };
}

/** The earliest lead's creation instant - no stage event or outbound message before it can count for any lead in `leads`. Leads is non-empty. */
function earliestCreatedAt(leads: SharedLeadRow[]): string {
  return new Date(Math.min(...leads.map((lead) => Date.parse(lead.created_at)))).toISOString();
}

export async function getLeadsForRange(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<SharedLeadRow[]> {
  return (await getLeadsForRangeResult(supabase, organizationId, range)).leads;
}

// ---------------------------------------------------------------------------
// Part C: historical lead-stage funnel
// ---------------------------------------------------------------------------

type StageChangedEventRow = {
  entity_id: string | null;
  payload: { previous_status?: LeadStatus | null; new_status?: LeadStatus } | null;
  created_at: string;
};

/**
 * Definition: counts real lead.stage_changed events, scoped by the
 * transition's OWN created_at (when it happened), never by when the lead
 * itself was created. Reliability: directly reliable - every row here is a
 * real automation_events row written by lib/automation/lead-stage-history.ts,
 * the same infrastructure the Lead Detail timeline already reads from
 * (getLeadStageHistory) and that already has its own passing integration
 * test suite (lib/automation/lead-stage-history.integration.test.ts).
 */
export async function getLeadStageTransitionMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<LeadStageTransitionMetrics & { failed: boolean }> {
  const read = await readAllPages<StageChangedEventRow>(() => {
    let query = supabase.from("automation_events").select("entity_id, payload, created_at").eq("organization_id", organizationId).eq("event_type", "lead.stage_changed");
    if (range.from) query = query.gte("created_at", range.from);
    if (range.to) query = query.lt("created_at", range.to);
    return query.order("id");
  });
  if (read.failed) return { totalTransitions: 0, leadsTransitionedToQualified: 0, leadsTransitionedToWon: 0, transitionCounts: {}, failed: true };
  const rows = read.rows;

  const transitionCounts: Record<string, number> = {};
  const leadsToQualified = new Set<string>();
  const leadsToWon = new Set<string>();

  for (const row of rows) {
    const previousStatus = row.payload?.previous_status ?? null;
    const newStatus = row.payload?.new_status;
    if (!newStatus) continue;

    const key = `${previousStatus ?? "null"}->${newStatus}`;
    transitionCounts[key] = (transitionCounts[key] ?? 0) + 1;

    if (row.entity_id) {
      if (newStatus === "qualified") leadsToQualified.add(row.entity_id);
      if (newStatus === "won") leadsToWon.add(row.entity_id);
    }
  }

  return {
    totalTransitions: rows.length,
    leadsTransitionedToQualified: leadsToQualified.size,
    leadsTransitionedToWon: leadsToWon.size,
    transitionCounts,
    failed: false,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Definition: leads created within the range `leads` was fetched for
 * (see getLeadsForRange), cross-referenced against their OWN real
 * lead.stage_changed events (fetched without a date bound on the
 * transition side - a transition happening any time after a lead's creation
 * is a valid, real duration regardless of which reporting window it lands
 * in) to find, per lead, the first recorded transition into 'qualified' and
 * into 'won'. Reliability: directly reliable for leads that genuinely have a
 * recorded transition; leads without one are correctly excluded from the
 * timing averages (see leadsWithRecordedHistory) rather than assigned a
 * fabricated duration.
 *
 * Pass 5C, Batch 3B: `leads` is now the caller's own shared, pre-fetched
 * range-scoped dataset (getLeadsForRange) rather than a query this function
 * issues itself - see this file's own header comment. One paged,
 * org-scoped read of its own remains (the stage events from the earliest
 * lead's creation onward, Phase 2F) - never N+1 per lead, never an id list.
 */
export async function getLeadStageTimingMetrics(supabase: SupabaseClient, organizationId: string, leads: SharedLeadRow[]): Promise<LeadStageTimingMetrics & { failed: boolean }> {
  const empty = { leadsInRange: leads.length, leadsWithRecordedHistory: 0, leadsWithQualifiedTiming: 0, averageTimeToQualifiedMs: null, medianTimeToQualifiedMs: null, leadsWithWonTiming: 0, averageTimeToWonMs: null, medianTimeToWonMs: null };
  if (leads.length === 0) return { ...empty, failed: false };

  // Phase 2F: the organization's stage events from the earliest lead's
  // creation onward, matched to these leads in memory - never an id list.
  const read = await readAllPages<StageChangedEventRow>(() =>
    supabase
      .from("automation_events")
      .select("entity_id, payload, created_at")
      .eq("organization_id", organizationId)
      .eq("event_type", "lead.stage_changed")
      .gte("created_at", earliestCreatedAt(leads))
      .order("id"),
  );
  if (read.failed) return { ...empty, failed: true };

  // First (earliest) recorded transition into each stage, per lead - the
  // pages arrive in id order, so the earliest is chosen by time here.
  const leadIds = new Set(leads.map((lead) => lead.id));
  const firstQualifiedAt = new Map<string, number>();
  const firstWonAt = new Map<string, number>();
  const leadsWithAnyHistory = new Set<string>();
  const keepEarliest = (map: Map<string, number>, leadId: string, at: number) => {
    const existing = map.get(leadId);
    if (existing === undefined || at < existing) map.set(leadId, at);
  };

  for (const event of read.rows) {
    if (!event.entity_id || !leadIds.has(event.entity_id)) continue;
    leadsWithAnyHistory.add(event.entity_id);
    const newStatus = event.payload?.new_status;
    const at = Date.parse(event.created_at);
    if (newStatus === "qualified") keepEarliest(firstQualifiedAt, event.entity_id, at);
    if (newStatus === "won") keepEarliest(firstWonAt, event.entity_id, at);
  }

  const qualifiedDurations: number[] = [];
  const wonDurations: number[] = [];

  for (const lead of leads) {
    const leadCreatedMs = new Date(lead.created_at).getTime();
    const qualifiedAt = firstQualifiedAt.get(lead.id);
    if (qualifiedAt !== undefined) qualifiedDurations.push(qualifiedAt - leadCreatedMs);
    const wonAt = firstWonAt.get(lead.id);
    if (wonAt !== undefined) wonDurations.push(wonAt - leadCreatedMs);
  }

  return {
    leadsInRange: leads.length,
    leadsWithRecordedHistory: leadsWithAnyHistory.size,
    leadsWithQualifiedTiming: qualifiedDurations.length,
    averageTimeToQualifiedMs: average(qualifiedDurations),
    medianTimeToQualifiedMs: median(qualifiedDurations),
    leadsWithWonTiming: wonDurations.length,
    averageTimeToWonMs: average(wonDurations),
    medianTimeToWonMs: median(wonDurations),
    failed: false,
  };
}

/**
 * Cheap existence check - does this organization have ANY recorded
 * lead.stage_changed event within `range`? A real SQL COUNT with
 * head:true (no rows transferred), matching lib/bi/metrics.ts's own
 * getNonNullAmountCount/getAiUsageTotals established pattern for exactly
 * this "is there any data at all" question. Feeds
 * BiDataQuality.stageHistoryUnavailable - see that field's own comment.
 */
export async function hasAnyLeadStageHistoryResult(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<{ exists: boolean; failed: boolean }> {
  let query = supabase.from("automation_events").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("event_type", "lead.stage_changed");
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  // Phase 2F: a failed count is reported as failed, never as "no history".
  const { count, error } = await query;
  return { exists: (count ?? 0) > 0, failed: error != null };
}

export async function hasAnyLeadStageHistory(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<boolean> {
  return (await hasAnyLeadStageHistoryResult(supabase, organizationId, range)).exists;
}

// ---------------------------------------------------------------------------
// Part D: lead response-time intelligence
// ---------------------------------------------------------------------------

/** Matches Pass 5C Batch 2's uncontacted_lead detector exactly - 'queued'/'failed'/'undelivered' are attempts, never contact. */
const SUCCESSFUL_OUTBOUND_STATUSES = new Set(["sent", "delivered"]);

const ONE_MINUTE_MS = 60 * 1000;
const FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS;
const FIFTEEN_MINUTES_MS = 15 * ONE_MINUTE_MS;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

function emptyBucketCounts(): Record<ResponseTimeBucket, number> {
  return { under_1_min: 0, "1_to_5_min": 0, "5_to_15_min": 0, "15_to_60_min": 0, "1_to_24_hours": 0, over_24_hours: 0 };
}

function bucketFor(ms: number): ResponseTimeBucket {
  if (ms < ONE_MINUTE_MS) return "under_1_min";
  if (ms < FIVE_MINUTES_MS) return "1_to_5_min";
  if (ms < FIFTEEN_MINUTES_MS) return "5_to_15_min";
  if (ms < ONE_HOUR_MS) return "15_to_60_min";
  if (ms < ONE_DAY_MS) return "1_to_24_hours";
  return "over_24_hours";
}

/** 0-100 percentage, matching lib/bi/metrics.ts's own Rate convention - null on a zero denominator, never a fabricated 0%/divide-by-zero. */
function percentageRate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return (numerator / denominator) * 100;
}

/**
 * See LeadResponseTimeMetrics's own full documentation in lib/bi/types.ts
 * for the exact evidence hierarchy, population, and known delivery-timing
 * limitation. `leads` is the caller's own shared, pre-fetched range-scoped
 * dataset (getLeadsForRange) - see this file's own Batch 3B header comment.
 * Phase 2F: one paged, org-scoped read of its own (successful outbound
 * messages from the earliest lead's creation onward, joined to their
 * conversation's contact) regardless of population size - never N+1, never
 * a per-lead query, never an id list.
 */
export async function getLeadResponseTimeMetrics(supabase: SupabaseClient, organizationId: string, leads: SharedLeadRow[]): Promise<LeadResponseTimeMetrics & { failed: boolean }> {
  const totalLeadsInPopulation = leads.length;
  const empty = { totalLeadsInPopulation, leadsContacted: 0, leadsNeverContacted: totalLeadsInPopulation, contactRate: null, averageResponseTimeMs: null, medianResponseTimeMs: null, bucketCounts: emptyBucketCounts() };
  if (totalLeadsInPopulation === 0) return { ...empty, failed: false };

  const contactIds = new Set(leads.map((lead) => lead.contact_id).filter((id): id is string => id !== null));
  // No lead has a contact: nobody can have been contacted (0%, as before - a real population, not "no data").
  if (contactIds.size === 0) return { ...empty, contactRate: percentageRate(0, totalLeadsInPopulation), failed: false };

  // Phase 2F: one paged read of the organization's successful outbound
  // messages from the earliest lead's creation onward, each with its
  // conversation's contact (an inner join on the conversation, scoped to
  // the same organization) - never a contact or conversation id list, and
  // never cut off at the oldest 1000 rows.
  const read = await readAllPages<{ created_at: string; conversation: { contact_id: string | null } | { contact_id: string | null }[] | null }>(() =>
    supabase
      .from("messages")
      .select("created_at, conversation:conversations!messages_conversation_id_fkey!inner(contact_id)")
      .eq("organization_id", organizationId)
      .eq("conversation.organization_id", organizationId)
      .eq("direction", "outbound")
      .in("status", [...SUCCESSFUL_OUTBOUND_STATUSES])
      .gte("created_at", earliestCreatedAt(leads))
      .order("id"),
  );
  if (read.failed) return { ...empty, leadsNeverContacted: 0, failed: true };

  // Ascending successful-outbound instants per contact (sorted here - pages arrive in id order).
  const successfulOutboundByContact = new Map<string, number[]>();
  for (const message of read.rows) {
    const conversation = Array.isArray(message.conversation) ? message.conversation[0] : message.conversation;
    const contactId = conversation?.contact_id;
    if (!contactId || !contactIds.has(contactId)) continue;
    const existing = successfulOutboundByContact.get(contactId) ?? [];
    existing.push(Date.parse(message.created_at));
    successfulOutboundByContact.set(contactId, existing);
  }
  for (const instants of successfulOutboundByContact.values()) instants.sort((a, b) => a - b);

  const responseTimesMs: number[] = [];
  const bucketCounts = emptyBucketCounts();

  for (const lead of leads) {
    if (!lead.contact_id) continue;
    const timestamps = successfulOutboundByContact.get(lead.contact_id);
    if (!timestamps) continue;

    const leadCreatedMs = new Date(lead.created_at).getTime();
    // The first successful outbound message AT OR AFTER this specific
    // lead's own creation - never an earlier message that answered a
    // different, prior inquiry from the same contact.
    const firstQualifying = timestamps.find((timestamp) => timestamp >= leadCreatedMs);
    if (firstQualifying === undefined) continue;

    const responseTimeMs = firstQualifying - leadCreatedMs;
    responseTimesMs.push(responseTimeMs);
    bucketCounts[bucketFor(responseTimeMs)] += 1;
  }

  const leadsContacted = responseTimesMs.length;

  return {
    totalLeadsInPopulation,
    leadsContacted,
    leadsNeverContacted: totalLeadsInPopulation - leadsContacted,
    contactRate: percentageRate(leadsContacted, totalLeadsInPopulation),
    averageResponseTimeMs: average(responseTimesMs),
    medianResponseTimeMs: median(responseTimesMs),
    bucketCounts,
    failed: false,
  };
}
