import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadStatus } from "@/lib/leads/queries";
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
 */

const MAX_ROWS = 10_000;

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
export async function getLeadStageTransitionMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<LeadStageTransitionMetrics> {
  let query = supabase
    .from("automation_events")
    .select("entity_id, payload, created_at")
    .eq("organization_id", organizationId)
    .eq("event_type", "lead.stage_changed")
    .limit(MAX_ROWS);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { data } = await query;
  const rows = (data ?? []) as StageChangedEventRow[];

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
 * Definition: leads created within `range`, cross-referenced against their
 * OWN real lead.stage_changed events (fetched without a date bound on the
 * transition side - a transition happening any time after a lead's creation
 * is a valid, real duration regardless of which reporting window it lands
 * in) to find, per lead, the first recorded transition into 'qualified' and
 * into 'won'. Reliability: directly reliable for leads that genuinely have a
 * recorded transition; leads without one are correctly excluded from the
 * timing averages (see leadsWithRecordedHistory) rather than assigned a
 * fabricated duration.
 *
 * Two bounded, org-scoped queries (leads, then their events by entity_id)
 * regardless of population size - never N+1 per lead.
 */
export async function getLeadStageTimingMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<LeadStageTimingMetrics> {
  let leadQuery = supabase.from("leads").select("id, created_at").eq("organization_id", organizationId).limit(MAX_ROWS);
  if (range.from) leadQuery = leadQuery.gte("created_at", range.from);
  if (range.to) leadQuery = leadQuery.lt("created_at", range.to);

  const { data: leadRows } = await leadQuery;
  const leads = (leadRows ?? []) as { id: string; created_at: string }[];

  if (leads.length === 0) {
    return { leadsInRange: 0, leadsWithRecordedHistory: 0, leadsWithQualifiedTiming: 0, averageTimeToQualifiedMs: null, medianTimeToQualifiedMs: null, leadsWithWonTiming: 0, averageTimeToWonMs: null, medianTimeToWonMs: null };
  }

  const leadIds = leads.map((lead) => lead.id);
  const { data: eventRows } = await supabase
    .from("automation_events")
    .select("entity_id, payload, created_at")
    .eq("organization_id", organizationId)
    .eq("event_type", "lead.stage_changed")
    .in("entity_id", leadIds)
    .order("created_at", { ascending: true })
    .limit(MAX_ROWS);

  const events = (eventRows ?? []) as StageChangedEventRow[];

  // First (earliest - events were fetched ascending) recorded transition
  // into each stage, per lead. A Map, not a second query per lead.
  const firstQualifiedAt = new Map<string, string>();
  const firstWonAt = new Map<string, string>();
  const leadsWithAnyHistory = new Set<string>();

  for (const event of events) {
    if (!event.entity_id) continue;
    leadsWithAnyHistory.add(event.entity_id);
    const newStatus = event.payload?.new_status;
    if (newStatus === "qualified" && !firstQualifiedAt.has(event.entity_id)) firstQualifiedAt.set(event.entity_id, event.created_at);
    if (newStatus === "won" && !firstWonAt.has(event.entity_id)) firstWonAt.set(event.entity_id, event.created_at);
  }

  const qualifiedDurations: number[] = [];
  const wonDurations: number[] = [];

  for (const lead of leads) {
    const leadCreatedMs = new Date(lead.created_at).getTime();
    const qualifiedAt = firstQualifiedAt.get(lead.id);
    if (qualifiedAt) qualifiedDurations.push(new Date(qualifiedAt).getTime() - leadCreatedMs);
    const wonAt = firstWonAt.get(lead.id);
    if (wonAt) wonDurations.push(new Date(wonAt).getTime() - leadCreatedMs);
  }

  return {
    leadsInRange: leads.length,
    leadsWithRecordedHistory: leadIds.filter((id) => leadsWithAnyHistory.has(id)).length,
    leadsWithQualifiedTiming: qualifiedDurations.length,
    averageTimeToQualifiedMs: average(qualifiedDurations),
    medianTimeToQualifiedMs: median(qualifiedDurations),
    leadsWithWonTiming: wonDurations.length,
    averageTimeToWonMs: average(wonDurations),
    medianTimeToWonMs: median(wonDurations),
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
export async function hasAnyLeadStageHistory(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<boolean> {
  let query = supabase.from("automation_events").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("event_type", "lead.stage_changed");
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lt("created_at", range.to);

  const { count } = await query;
  return (count ?? 0) > 0;
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
 * limitation. Three bounded, org-scoped queries (leads, then their
 * contacts' conversations, then those conversations' messages) regardless
 * of population size - never N+1, never a per-lead query. Reuses the real
 * idx_messages_conversation index (conversation_id, created_at) already
 * present on the messages table.
 */
export async function getLeadResponseTimeMetrics(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<LeadResponseTimeMetrics> {
  let leadQuery = supabase.from("leads").select("id, contact_id, created_at").eq("organization_id", organizationId).limit(MAX_ROWS);
  if (range.from) leadQuery = leadQuery.gte("created_at", range.from);
  if (range.to) leadQuery = leadQuery.lt("created_at", range.to);

  const { data: leadRows } = await leadQuery;
  const leads = (leadRows ?? []) as { id: string; contact_id: string | null; created_at: string }[];

  const totalLeadsInPopulation = leads.length;
  if (totalLeadsInPopulation === 0) {
    return { totalLeadsInPopulation: 0, leadsContacted: 0, leadsNeverContacted: 0, contactRate: null, averageResponseTimeMs: null, medianResponseTimeMs: null, bucketCounts: emptyBucketCounts() };
  }

  const contactIds = [...new Set(leads.map((lead) => lead.contact_id).filter((id): id is string => id !== null))];

  const conversations =
    contactIds.length > 0
      ? (((await supabase.from("conversations").select("id, contact_id").eq("organization_id", organizationId).in("contact_id", contactIds).limit(MAX_ROWS)).data ?? []) as {
          id: string;
          contact_id: string | null;
        }[])
      : [];

  const conversationIdToContactId = new Map(conversations.map((conversation) => [conversation.id, conversation.contact_id]));
  const conversationIds = conversations.map((conversation) => conversation.id);

  const messages =
    conversationIds.length > 0
      ? (((await supabase
          .from("messages")
          .select("conversation_id, direction, status, created_at")
          .eq("organization_id", organizationId)
          .in("conversation_id", conversationIds)
          .order("created_at", { ascending: true })
          .limit(MAX_ROWS)).data ?? []) as { conversation_id: string; direction: string; status: string; created_at: string }[])
      : [];

  // Ascending-ordered successful-outbound timestamps per contact - the fetch
  // above is already ordered by created_at, so each per-contact list built
  // by pushing in that same order is itself ascending, with no in-memory
  // sort needed.
  const successfulOutboundByContact = new Map<string, string[]>();
  for (const message of messages) {
    if (message.direction !== "outbound" || !SUCCESSFUL_OUTBOUND_STATUSES.has(message.status)) continue;
    const contactId = conversationIdToContactId.get(message.conversation_id);
    if (!contactId) continue;
    const existing = successfulOutboundByContact.get(contactId) ?? [];
    existing.push(message.created_at);
    successfulOutboundByContact.set(contactId, existing);
  }

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
    const firstQualifying = timestamps.find((timestamp) => new Date(timestamp).getTime() >= leadCreatedMs);
    if (!firstQualifying) continue;

    const responseTimeMs = new Date(firstQualifying).getTime() - leadCreatedMs;
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
  };
}
