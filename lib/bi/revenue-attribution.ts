import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResolvedDateRange } from "./types";

/**
 * Phase 2C (Analytics only): revenue attribution by lead source. Not part
 * of BusinessMetricsSnapshot, so Agency, Today and the AI observations
 * never see it.
 *
 * Source: leads.source - the only per-lead source field (free text, set by
 * the lead form and the capture/webhook paths; organizations.lead_sources
 * is onboarding context, not attribution). Grouped exactly like the
 * snapshot's sourceCounts: trimmed, case kept. A blank or missing source is
 * "Unknown source"; a job with no lead at all is "No lead linked". Nothing
 * is dropped - the buckets always add up to every job in scope.
 *
 * Value: jobs.amount - the contracted amount the snapshot already calls
 * "Completed job value", never collected payments. A job without an amount
 * is counted but adds nothing to value.
 *
 * Date basis (the organization-calendar range the page already resolves):
 *   - Leads: leads created in the period.
 *   - Jobs: jobs created in the period, cancelled excluded.
 *   - Completed / completed value: jobs completed in the period, by
 *     jobs.completed_at (stamped when a job is marked complete).
 *   - Lead → job conversion is a cohort: the leads created in the period,
 *     and the jobs those leads have produced so far, whenever they happened.
 *
 * Query strategy: PostgREST aggregates are disabled on this project, so
 * each read is a server-side join (jobs → leads on jobs.lead_id) returning
 * only the columns summed here, paged by 1000. No ID lists, no .in(), and no
 * silent cap: past MAX_ATTRIBUTION_ROWS a read stops and reports failed, so
 * the page discloses it rather than showing a partial figure as complete.
 */

export const UNKNOWN_SOURCE_LABEL = "Unknown source";
export const NO_LEAD_LABEL = "No lead linked";
const PAGE = 1000;
export const MAX_ATTRIBUTION_ROWS = 100_000;

type LeadEmbed<T> = T | T[] | null;
export type AttributionLeadRow = { source: string | null };
export type AttributionPeriodJobRow = { status: string; lead: LeadEmbed<{ source: string | null }> };
export type AttributionCompletedJobRow = { amount: number | string | null; lead: LeadEmbed<{ source: string | null }> };
export type AttributionCohortJobRow = { lead_id: string; status: string; amount: number | string | null };

export type RevenueSourceRow = {
  key: string;
  label: string;
  kind: "source" | "unknown" | "unlinked";
  /** null for "No lead linked" - there is no lead to count. */
  leads: number | null;
  jobs: number;
  completedJobs: number;
  completedValue: number;
};

export type RevenueAttribution = {
  rows: RevenueSourceRow[];
  totals: { leads: number; jobs: number; completedJobs: number; completedValue: number };
  conversion: {
    /** Leads created in the period. */
    leads: number;
    /** Of those, leads with at least one job that isn't cancelled. */
    leadsWithJob: number;
    /** leadsWithJob / leads as a percentage; null with no leads. */
    jobRate: number | null;
    /** Completed jobs from those leads, whenever completed. */
    completedJobs: number;
    completedValue: number;
  };
};

const one = <T>(embed: LeadEmbed<T>): T | null => (Array.isArray(embed) ? (embed[0] ?? null) : embed);
const sourceKey = (source: string | null | undefined): string | null => source?.trim() || null;
const amountOf = (amount: number | string | null): number => {
  const value = amount === null ? 0 : Number(amount);
  return Number.isFinite(value) ? value : 0;
};

/** Pure: the attribution table and conversion summary from the four reads. */
export function summarizeRevenueAttribution(input: {
  leads: AttributionLeadRow[];
  periodJobs: AttributionPeriodJobRow[];
  completedJobs: AttributionCompletedJobRow[];
  cohortJobs: AttributionCohortJobRow[];
}): RevenueAttribution {
  const buckets = new Map<string, RevenueSourceRow>();
  const bucket = (kind: RevenueSourceRow["kind"], source: string | null): RevenueSourceRow => {
    const key = kind === "source" ? `source:${source}` : kind;
    let row = buckets.get(key);
    if (!row) {
      row = { key, label: kind === "source" ? source! : kind === "unknown" ? UNKNOWN_SOURCE_LABEL : NO_LEAD_LABEL, kind, leads: kind === "unlinked" ? null : 0, jobs: 0, completedJobs: 0, completedValue: 0 };
      buckets.set(key, row);
    }
    return row;
  };
  const forJob = (lead: LeadEmbed<{ source: string | null }>) => {
    const linked = one(lead);
    if (!linked) return bucket("unlinked", null);
    const source = sourceKey(linked.source);
    return source ? bucket("source", source) : bucket("unknown", null);
  };

  for (const lead of input.leads) {
    const source = sourceKey(lead.source);
    const row = source ? bucket("source", source) : bucket("unknown", null);
    row.leads = (row.leads ?? 0) + 1;
  }
  for (const job of input.periodJobs) {
    if (job.status === "cancelled") continue;
    forJob(job.lead).jobs += 1;
  }
  for (const job of input.completedJobs) {
    const row = forJob(job.lead);
    row.completedJobs += 1;
    row.completedValue += amountOf(job.amount);
  }

  // Named sources alphabetically - a list, not a performance ranking - then
  // the unknown and unlinked buckets last.
  const order = { source: 0, unknown: 1, unlinked: 2 } as const;
  const rows = [...buckets.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));

  const totals = rows.reduce(
    (sum, row) => ({ leads: sum.leads + (row.leads ?? 0), jobs: sum.jobs + row.jobs, completedJobs: sum.completedJobs + row.completedJobs, completedValue: sum.completedValue + row.completedValue }),
    { leads: 0, jobs: 0, completedJobs: 0, completedValue: 0 },
  );

  const leadsWithJob = new Set<string>();
  let cohortCompleted = 0;
  let cohortValue = 0;
  for (const job of input.cohortJobs) {
    if (job.status === "cancelled") continue;
    leadsWithJob.add(job.lead_id);
    if (job.status === "completed") {
      cohortCompleted += 1;
      cohortValue += amountOf(job.amount);
    }
  }
  const leads = input.leads.length;

  return {
    rows,
    totals,
    conversion: { leads, leadsWithJob: leadsWithJob.size, jobRate: leads === 0 ? null : (leadsWithJob.size / leads) * 100, completedJobs: cohortCompleted, completedValue: cohortValue },
  };
}

type PagedQuery = { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }> };

/** Reads every page of a query (rebuilt per page), stopping at MAX_ATTRIBUTION_ROWS and reporting failed rather than a silent partial. */
export async function readAllPages<T>(build: () => PagedQuery, max = MAX_ATTRIBUTION_ROWS): Promise<{ rows: T[]; failed: boolean }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    if (rows.length >= max) return { rows, failed: true };
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) return { rows, failed: true };
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return { rows, failed: false };
  }
}

const LEAD = "lead:leads!jobs_lead_id_fkey";

export async function getRevenueAttribution(supabase: SupabaseClient, organizationId: string, range: ResolvedDateRange): Promise<RevenueAttribution & { failed: boolean }> {
  const [leads, periodJobs, completedJobs, cohortJobs] = await Promise.all([
    readAllPages<AttributionLeadRow>(() => {
      let query = supabase.from("leads").select("source").eq("organization_id", organizationId);
      if (range.from) query = query.gte("created_at", range.from);
      if (range.to) query = query.lt("created_at", range.to);
      return query.order("id");
    }),
    readAllPages<AttributionPeriodJobRow>(() => {
      let query = supabase.from("jobs").select(`status, ${LEAD}(source)`).eq("organization_id", organizationId).neq("status", "cancelled");
      if (range.from) query = query.gte("created_at", range.from);
      if (range.to) query = query.lt("created_at", range.to);
      return query.order("id");
    }),
    readAllPages<AttributionCompletedJobRow>(() => {
      let query = supabase.from("jobs").select(`amount, ${LEAD}(source)`).eq("organization_id", organizationId).eq("status", "completed");
      if (range.from) query = query.gte("completed_at", range.from);
      if (range.to) query = query.lt("completed_at", range.to);
      return query.order("id");
    }),
    readAllPages<AttributionCohortJobRow>(() => {
      let query = supabase.from("jobs").select(`lead_id, status, amount, ${LEAD}!inner(created_at)`).eq("organization_id", organizationId).not("lead_id", "is", null);
      if (range.from) query = query.gte("lead.created_at", range.from);
      if (range.to) query = query.lt("lead.created_at", range.to);
      return query.order("id");
    }),
  ]);

  return {
    ...summarizeRevenueAttribution({ leads: leads.rows, periodJobs: periodJobs.rows, completedJobs: completedJobs.rows, cohortJobs: cohortJobs.rows }),
    failed: leads.failed || periodJobs.failed || completedJobs.failed || cohortJobs.failed,
  };
}
