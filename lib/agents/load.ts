import type { SupabaseClient } from "@supabase/supabase-js";
import { getDashboardSqlData } from "@/lib/dashboard/queries";
import { getPrioritizedOpportunities } from "@/lib/opportunities/intelligence";
import { assembleDecisions } from "@/lib/decisions/assemble";
import { getDecisionContext } from "@/lib/decisions/context";
import { getBusinessMetricsSnapshot } from "@/lib/bi/metrics";
import { getOrganizationHealth } from "@/lib/automation-health/health";
import { listIncidents } from "@/lib/automation-health/queries";
import { getAutomationMode } from "@/lib/settings/queries";
import type { SourceRead } from "./runtime";
import type { SpecialistInputs } from "./operating-layer";
import { projectIncidents, projectQaInput, projectSalesInput, projectTrackprIntelligenceInput } from "./sources";

/**
 * Agent Operating Layer, Phase 1: loads every specialist's input for ONE
 * organization, using only reads this codebase already has and only the
 * caller's request-scoped, RLS-bound Supabase client - never the service
 * role. The organization id must come from the caller's verified membership
 * (getRequestMembership), never from the request; and even if it did not,
 * RLS on every table read here (is_org_member) still returns nothing for an
 * organization the user does not belong to.
 *
 * Read-only by construction: nothing here inserts, updates, dispatches or
 * sends. A read that throws becomes a failed SourceRead for the agents that
 * depend on it; the other agents still run.
 */

async function read<T>(load: () => Promise<T>, reason: string): Promise<SourceRead<T>> {
  try {
    return { ok: true, data: await load() };
  } catch {
    return { ok: false, reason };
  }
}

function map<A, B>(source: SourceRead<A>, project: (data: A) => B): SourceRead<B> {
  return source.ok ? { ok: true, data: project(source.data) } : source;
}

export async function loadSpecialistInputs(supabase: SupabaseClient, organizationId: string, options: { now: Date; timeZone: string | null }): Promise<SpecialistInputs> {
  const dashboardRead = getDashboardSqlData(supabase, organizationId);
  const [decisions, snapshot, health, incidents, mode] = await Promise.all([
    read(async () => {
      const [dashboard, prioritized] = await Promise.all([dashboardRead, getPrioritizedOpportunities(supabase, organizationId, options.now)]);
      const context = await getDecisionContext(supabase, organizationId, { attentionItems: dashboard.attentionItems, timeZone: options.timeZone, now: options.now.getTime() });
      return { assembled: assembleDecisions({ attentionItems: dashboard.attentionItems, prioritizedOpportunities: prioritized, context }), prioritized };
    }, "decision data unavailable"),
    read(() => getBusinessMetricsSnapshot(supabase, organizationId, "last30Days", { timeZone: options.timeZone ?? "UTC", now: options.now }), "business metrics unavailable"),
    read(() => getOrganizationHealth(supabase, organizationId), "automation health unavailable"),
    read(() => listIncidents(supabase, organizationId, { status: ["open", "acknowledged"] }), "incidents unavailable"),
    read(() => getAutomationMode(supabase, organizationId), "automation mode unavailable"),
  ]);

  const qa: SpecialistInputs["qa_health"] =
    health.ok && incidents.ok
      ? { ok: true, data: projectQaInput(health.data, incidents.data, mode.ok ? mode.data : "test", decisions.ok ? decisions.data.assembled : null) }
      : { ok: false, reason: "automation health unavailable" };

  return {
    sales: map(decisions, (d) => projectSalesInput(d.assembled, d.prioritized)),
    trackpr_intelligence: map(snapshot, (s) => projectTrackprIntelligenceInput(s)),
    qa_health: qa,
    engineering: health.ok && incidents.ok ? { ok: true, data: { incidents: projectIncidents(incidents.data), incidentsUnavailable: health.data.incidentsUnavailable } } : { ok: false, reason: "incidents unavailable" },
    // No research or market source is connected in Phase 1: an empty, honest input - never fetched, never scraped.
    market_intelligence: { ok: true, data: [] },
    prospecting: { ok: true, data: [] },
  };
}
