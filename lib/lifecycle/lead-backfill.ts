/**
 * Phase 2B: the one-off lead-link backfill plan - pure, so every rule is
 * unit-tested (lead-backfill.test.ts) and the runner
 * (scripts/lifecycle-lead-backfill.ts) only reads rows, prints this plan,
 * and (TEST only, on explicit request) applies it.
 *
 * Rules - deterministic only, never a guess, never an overwrite:
 *   Estimates (lead_id blank): link the contact's lead only when the
 *     contact has EXACTLY ONE lead and it was created before the estimate.
 *   Jobs (lead_id blank): use the job's estimate's lead when it has one
 *     (including a link this same plan gives the estimate - a second run
 *     would produce it anyway); otherwise the contact's lead only when
 *     EXACTLY ONE of the contact's leads was created before the job.
 * Rows already linked are never touched, so applying a plan and planning
 * again yields no further changes (idempotent).
 */

export type BackfillLead = { id: string; contact_id: string | null; created_at: string };
export type BackfillEstimate = { id: string; contact_id: string | null; lead_id: string | null; created_at: string };
export type BackfillJob = { id: string; contact_id: string | null; lead_id: string | null; estimate_id: string | null; created_at: string };

export type LeadBackfillPlan = {
  estimateUpdates: { id: string; lead_id: string }[];
  jobUpdates: { id: string; lead_id: string; via: "estimate" | "single_lead" }[];
  counts: {
    estimatesAlreadyLinked: number;
    estimatesEligible: number;
    estimatesAmbiguous: number;
    estimatesSkipped: number;
    jobsAlreadyLinked: number;
    jobsInheritingFromEstimate: number;
    jobsEligibleFromSingleLead: number;
    jobsAmbiguous: number;
    jobsSkipped: number;
    totalRowsToChange: number;
  };
};

export function planLeadBackfill(input: { leads: BackfillLead[]; estimates: BackfillEstimate[]; jobs: BackfillJob[] }): LeadBackfillPlan {
  const leadsByContact = new Map<string, BackfillLead[]>();
  for (const lead of input.leads) {
    if (!lead.contact_id) continue;
    const list = leadsByContact.get(lead.contact_id);
    if (list) list.push(lead);
    else leadsByContact.set(lead.contact_id, [lead]);
  }
  const before = (lead: BackfillLead, iso: string) => new Date(lead.created_at).getTime() < new Date(iso).getTime();

  const counts = {
    estimatesAlreadyLinked: 0,
    estimatesEligible: 0,
    estimatesAmbiguous: 0,
    estimatesSkipped: 0,
    jobsAlreadyLinked: 0,
    jobsInheritingFromEstimate: 0,
    jobsEligibleFromSingleLead: 0,
    jobsAmbiguous: 0,
    jobsSkipped: 0,
    totalRowsToChange: 0,
  };

  const estimateUpdates: LeadBackfillPlan["estimateUpdates"] = [];
  const estimateLead = new Map<string, string | null>();
  for (const estimate of input.estimates) {
    if (estimate.lead_id) {
      counts.estimatesAlreadyLinked += 1;
      estimateLead.set(estimate.id, estimate.lead_id);
      continue;
    }
    const contactLeads = estimate.contact_id ? (leadsByContact.get(estimate.contact_id) ?? []) : [];
    if (contactLeads.length > 1) counts.estimatesAmbiguous += 1;
    else if (contactLeads.length === 1 && before(contactLeads[0], estimate.created_at)) {
      counts.estimatesEligible += 1;
      estimateUpdates.push({ id: estimate.id, lead_id: contactLeads[0].id });
      estimateLead.set(estimate.id, contactLeads[0].id);
      continue;
    } else counts.estimatesSkipped += 1;
    estimateLead.set(estimate.id, null);
  }

  const jobUpdates: LeadBackfillPlan["jobUpdates"] = [];
  for (const job of input.jobs) {
    if (job.lead_id) {
      counts.jobsAlreadyLinked += 1;
      continue;
    }
    const fromEstimate = job.estimate_id ? (estimateLead.get(job.estimate_id) ?? null) : null;
    if (fromEstimate) {
      counts.jobsInheritingFromEstimate += 1;
      jobUpdates.push({ id: job.id, lead_id: fromEstimate, via: "estimate" });
      continue;
    }
    const earlier = job.contact_id ? (leadsByContact.get(job.contact_id) ?? []).filter((lead) => before(lead, job.created_at)) : [];
    if (earlier.length === 1) {
      counts.jobsEligibleFromSingleLead += 1;
      jobUpdates.push({ id: job.id, lead_id: earlier[0].id, via: "single_lead" });
    } else if (earlier.length > 1) counts.jobsAmbiguous += 1;
    else counts.jobsSkipped += 1;
  }

  counts.totalRowsToChange = estimateUpdates.length + jobUpdates.length;
  return { estimateUpdates, jobUpdates, counts };
}
