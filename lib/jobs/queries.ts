import type { SupabaseClient } from "@supabase/supabase-js";

export type JobStatus = "scheduled" | "in_progress" | "completed" | "cancelled";

export const JOB_STATUSES: { value: JobStatus; label: string }[] = [
  { value: "scheduled", label: "Scheduled" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

export type Job = {
  id: string;
  organization_id: string;
  contact_id: string | null;
  lead_id: string | null;
  estimate_id: string | null;
  title: string;
  amount: number | null;
  status: JobStatus;
  started_at: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

const JOB_COLUMNS =
  "id, organization_id, contact_id, lead_id, estimate_id, title, amount, status, started_at, completed_at, notes, created_at, updated_at";

/**
 * Loads a single job scoped to the org. Mirrors getEstimate/getAppointment's
 * contract exactly: any error (invalid id, not found, wrong org) resolves
 * to null rather than throwing.
 */
export async function getJob(supabase: SupabaseClient, organizationId: string, id: string): Promise<Job | null> {
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return data as Job;
}

/**
 * Looks up the job created from a given estimate, if any - the actual
 * lookup emitJobCreatedFromEstimate uses to make "estimate accepted ->
 * exactly one job" idempotent (see lib/automation/jobs.ts). Scoped to the
 * org for the same defense-in-depth reason every other lookup here is.
 */
export async function getJobByEstimateId(
  supabase: SupabaseClient,
  organizationId: string,
  estimateId: string,
): Promise<Job | null> {
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("estimate_id", estimateId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return data as Job;
}
