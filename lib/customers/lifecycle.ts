import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Pass 3 (Revenue Intelligence Foundation), Part 5: reusable, deterministic
 * customer lifecycle intelligence, built directly on the existing
 * contacts/jobs relationship (jobs.contact_id) - never a new denormalized
 * customer column, per this pass's own "prefer derivation over
 * denormalization" instruction.
 *
 * All-time/current-state by design, matching the reasoning already
 * established for lib/bi/metrics.ts's revenueOpportunity fix: "has this
 * customer come back" and "what have they completed with us, ever" are not
 * date-range questions, so these queries deliberately ignore any reporting
 * window and are never merged into BusinessMetricsSnapshot's period-scoped
 * groups.
 *
 * Terminology: per this pass's explicit rule, jobs.amount is never called
 * "revenue" - there is no payment ledger in this schema, so a completed
 * job's contracted amount is only ever "known completed job value," and a
 * NULL amount is excluded from every sum/average here, never coerced to 0.
 */

const MAX_ROWS = 10_000;

export type CustomerLifecycle = {
  contactId: string;
  totalCompletedJobs: number;
  firstCompletedJobAt: string | null;
  lastCompletedJobAt: string | null;
  daysSinceLastCompletedJob: number | null;
  /** totalCompletedJobs >= 2 - the single definition of "repeat customer" this codebase uses; the Attention Engine's repeat-service opportunity and the dashboard's repeat-customer rate both read it from here rather than recomputing it. */
  isRepeatCustomer: boolean;
  /** SUM(jobs.amount) over this customer's completed jobs with a non-null amount. */
  knownCompletedJobValue: number;
  /** Count of this customer's completed jobs that have a non-null amount - the real denominator for averageKnownCompletedJobValue, not necessarily equal to totalCompletedJobs. */
  knownCompletedJobValueCount: number;
  averageKnownCompletedJobValue: number | null;
};

type JobRow = { contact_id: string | null; amount: number | null; completed_at: string | null };

function summarizeCompletedJobs(jobs: JobRow[], now: Date): Omit<CustomerLifecycle, "contactId"> {
  const totalCompletedJobs = jobs.length;
  const completedAts = jobs
    .map((job) => job.completed_at)
    .filter((value): value is string => value != null)
    .sort();
  const firstCompletedJobAt = completedAts[0] ?? null;
  const lastCompletedJobAt = completedAts[completedAts.length - 1] ?? null;
  const daysSinceLastCompletedJob = lastCompletedJobAt == null ? null : Math.floor((now.getTime() - new Date(lastCompletedJobAt).getTime()) / (24 * 60 * 60 * 1000));

  let knownCompletedJobValue = 0;
  let knownCompletedJobValueCount = 0;
  for (const job of jobs) {
    if (job.amount != null) {
      knownCompletedJobValue += job.amount;
      knownCompletedJobValueCount += 1;
    }
  }

  return {
    totalCompletedJobs,
    firstCompletedJobAt,
    lastCompletedJobAt,
    daysSinceLastCompletedJob,
    isRepeatCustomer: totalCompletedJobs >= 2,
    knownCompletedJobValue,
    knownCompletedJobValueCount,
    averageKnownCompletedJobValue: knownCompletedJobValueCount === 0 ? null : knownCompletedJobValue / knownCompletedJobValueCount,
  };
}

/**
 * Trackpr 2.0, Phase 4C (P2 #1): `failed` is true only on a real Postgrest
 * error, never on genuine emptiness ("no completed jobs yet" for a new
 * customer) - mirrors the getLeadAndPipelineMetrics discipline established
 * in lib/bi/queries.ts. Added for API completeness across this file's read
 * layer; getCustomerLifecycle's own single-customer consumer (Contact
 * Detail) is lower-stakes than the org-wide aggregates below and is left
 * unwired for now, per this phase's own "update consumers only where
 * necessary" scope.
 */
export async function getCustomerLifecycleResult(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  now: Date = new Date(),
): Promise<CustomerLifecycle & { failed: boolean }> {
  const { data, error } = await supabase.from("jobs").select("contact_id, amount, completed_at").eq("organization_id", organizationId).eq("contact_id", contactId).eq("status", "completed").limit(1000);

  return { contactId, ...summarizeCompletedJobs((data ?? []) as JobRow[], now), failed: error != null };
}

/**
 * Single-customer lifecycle - this one contact's own completed jobs,
 * all-time. Returns a real zeroed shape (never throws, never null) when the
 * contact has no completed jobs at all - "no history yet" is a normal,
 * expected state for a new customer, not an error.
 */
export async function getCustomerLifecycle(supabase: SupabaseClient, organizationId: string, contactId: string, now: Date = new Date()): Promise<CustomerLifecycle> {
  return getCustomerLifecycleResult(supabase, organizationId, contactId, now);
}

export type RepeatCustomerSummary = {
  /** Distinct customers with at least one completed job. */
  customersWithCompletedJob: number;
  /** Distinct customers with 2+ completed jobs. */
  repeatCustomerCount: number;
  /** repeatCustomerCount / customersWithCompletedJob, as a percentage. `null` when the denominator is 0. */
  repeatCustomerRate: number | null;
  completedJobCount: number;
  /** SUM(jobs.amount) over ALL completed jobs org-wide with a non-null amount, all-time. */
  knownCompletedJobValue: number;
  averageKnownCompletedJobValue: number | null;
  /**
   * Pass 4 P1-C: count of completed jobs BEYOND each repeat customer's
   * first (max(jobCount - 1, 0) per repeat customer, summed) - "how much
   * repeat work actually happened," never counting a customer's first job
   * as itself a sign of repeat business.
   */
  additionalCompletedJobCount: number;
  /** SUM(jobs.amount) over only the "additional" jobs above, non-null amounts only - never the customer's first job's value, never a null coerced to 0. */
  additionalCompletedJobKnownValue: number;
};

/**
 * Org-wide repeat-customer + completed-job-value rollup - Part 9's
 * analytics reconnection reads this directly rather than deriving the same
 * fact a second, different way. Groups jobs by contact_id in application
 * code from a single bounded fetch, matching lib/bi/metrics.ts's own
 * established "one fetch + in-memory aggregation" shape (e.g.
 * getLeadBookingCrossReference) rather than a query-per-customer.
 *
 * Trackpr 2.0, Phase 4C (P2 #1): `failed` is true only on a real Postgrest
 * error, never on genuine emptiness. Wired into both Dashboard and Analytics
 * (their own partialData banners now also cover this read) since a failure
 * here would otherwise render as a false "0 repeat customers" on both
 * business-health surfaces.
 */
export async function getRepeatCustomerSummaryResult(supabase: SupabaseClient, organizationId: string): Promise<RepeatCustomerSummary & { failed: boolean }> {
  const { data, error } = await supabase.from("jobs").select("contact_id, amount, completed_at").eq("organization_id", organizationId).eq("status", "completed").not("contact_id", "is", null).limit(MAX_ROWS);

  const jobs = (data ?? []) as JobRow[];
  const byContact = new Map<string, JobRow[]>();
  for (const job of jobs) {
    const contactId = job.contact_id as string;
    const list = byContact.get(contactId);
    if (list) list.push(job);
    else byContact.set(contactId, [job]);
  }

  const customersWithCompletedJob = byContact.size;
  let repeatCustomerCount = 0;
  let knownCompletedJobValue = 0;
  let knownCompletedJobValueCount = 0;
  let additionalCompletedJobCount = 0;
  let additionalCompletedJobKnownValue = 0;
  for (const list of byContact.values()) {
    if (list.length >= 2) {
      repeatCustomerCount += 1;
      // Earliest job first (unknown completed_at sorts last - a job with no
      // recorded completion date is never treated as definitively "first").
      const ordered = [...list].sort((a, b) => (a.completed_at ?? "9999") < (b.completed_at ?? "9999") ? -1 : 1);
      const additionalJobs = ordered.slice(1);
      additionalCompletedJobCount += additionalJobs.length;
      for (const job of additionalJobs) {
        if (job.amount != null) additionalCompletedJobKnownValue += job.amount;
      }
    }
    for (const job of list) {
      if (job.amount != null) {
        knownCompletedJobValue += job.amount;
        knownCompletedJobValueCount += 1;
      }
    }
  }

  return {
    customersWithCompletedJob,
    repeatCustomerCount,
    repeatCustomerRate: customersWithCompletedJob === 0 ? null : (repeatCustomerCount / customersWithCompletedJob) * 100,
    completedJobCount: jobs.length,
    knownCompletedJobValue,
    averageKnownCompletedJobValue: knownCompletedJobValueCount === 0 ? null : knownCompletedJobValue / knownCompletedJobValueCount,
    additionalCompletedJobCount,
    additionalCompletedJobKnownValue,
    failed: error != null,
  };
}

/** Org-wide repeat-customer + completed-job-value rollup - see getRepeatCustomerSummaryResult's own comment above. Unchanged for all existing callers. */
export async function getRepeatCustomerSummary(supabase: SupabaseClient, organizationId: string): Promise<RepeatCustomerSummary> {
  return getRepeatCustomerSummaryResult(supabase, organizationId);
}

export type DormantCustomersValueSummary = {
  /** SUM(jobs.amount) across all completed jobs for the given dormant contacts, non-null amounts only. */
  knownValue: number;
  /** Count of the given dormant contacts whose completed-job history has NO known amount at all (every job's amount is null) - shown distinctly by the UI, never folded into knownValue as $0. */
  unknownValueCount: number;
};

/**
 * Pass 4 P1-B/E: the "known historical value represented by dormant
 * customers" figure for the dashboard's customer-opportunities section.
 * Takes an already-known set of dormant contact ids (the dashboard already
 * has these from its own getOpenOpportunities read, filtered to
 * type: "dormant_customer" - never re-detected here) and does one bounded
 * jobs fetch scoped to exactly those contacts, matching this file's own
 * "one fetch + in-memory aggregation, never a query per customer" principle
 * and avoiding any join fanout (a single, ungrouped select against jobs
 * alone, exactly like every other function in this file).
 */
/** Trackpr 2.0, Phase 4C (P2 #1): `failed` is true only on a real Postgrest error, never on genuine emptiness. Wired into Dashboard (whose own partialData banner now also covers this read) since a failure here would otherwise render as a false $0 dormant-customer value. */
export async function getDormantCustomersValueSummaryResult(supabase: SupabaseClient, organizationId: string, dormantContactIds: string[]): Promise<DormantCustomersValueSummary & { failed: boolean }> {
  if (dormantContactIds.length === 0) return { knownValue: 0, unknownValueCount: 0, failed: false };

  const { data, error } = await supabase.from("jobs").select("contact_id, amount").eq("organization_id", organizationId).eq("status", "completed").in("contact_id", dormantContactIds).limit(MAX_ROWS);

  const jobs = (data ?? []) as { contact_id: string | null; amount: number | null }[];
  const hasKnownValueByContact = new Map<string, boolean>(dormantContactIds.map((id) => [id, false]));
  let knownValue = 0;
  for (const job of jobs) {
    if (job.contact_id == null || job.amount == null) continue;
    knownValue += job.amount;
    hasKnownValueByContact.set(job.contact_id, true);
  }

  const unknownValueCount = [...hasKnownValueByContact.values()].filter((hasKnown) => !hasKnown).length;
  return { knownValue, unknownValueCount, failed: error != null };
}

/** Dormant-customer known value summary - see getDormantCustomersValueSummaryResult's own comment above. Unchanged for all existing callers. */
export async function getDormantCustomersValueSummary(supabase: SupabaseClient, organizationId: string, dormantContactIds: string[]): Promise<DormantCustomersValueSummary> {
  return getDormantCustomersValueSummaryResult(supabase, organizationId, dormantContactIds);
}
