import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "@/lib/contacts/queries";
import type { LeadStatus, LeadTemperature } from "@/lib/leads/queries";
import type { EstimateStatus } from "@/lib/estimates/queries";

export type JobStatus = "scheduled" | "in_progress" | "completed" | "cancelled";

export const JOB_STATUSES: { value: JobStatus; label: string }[] = [
  { value: "scheduled", label: "Scheduled" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

export type JobContact = Pick<Contact, "id" | "first_name" | "last_name" | "company_name" | "phone" | "email">;

export type JobLead = {
  id: string;
  service: string | null;
  status: LeadStatus;
  temperature: LeadTemperature;
};

export type JobEstimate = {
  id: string;
  title: string;
  status: EstimateStatus;
  amount: number | null;
};

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
  contact: JobContact | null;
  lead: JobLead | null;
  estimate: JobEstimate | null;
};

// A single string literal (not `+` concatenation) - matches
// lib/estimates/queries.ts's ESTIMATE_COLUMNS convention: Supabase's
// type-level select parser needs the literal type to infer typed columns.
const JOB_COLUMNS =
  "id, organization_id, contact_id, lead_id, estimate_id, title, amount, status, started_at, completed_at, notes, created_at, updated_at, contact:contacts(id, first_name, last_name, company_name, phone, email), lead:leads(id, service, status, temperature), estimate:estimates(id, title, status, amount)";

type Embedded<T> = T | T[] | null;

function one<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

type RawJobRow = Omit<Job, "contact" | "lead" | "estimate"> & {
  contact: Embedded<JobContact>;
  lead: Embedded<JobLead>;
  estimate: Embedded<JobEstimate>;
};

function normalizeJob(row: RawJobRow): Job {
  return { ...row, contact: one(row.contact), lead: one(row.lead), estimate: one(row.estimate) };
}

/**
 * Loads every job for the org (capped, matching the Leads/Appointments/
 * Estimates pattern), with its contact, lead, and originating estimate
 * embedded via the existing foreign keys. RLS already scopes rows to the
 * caller's organization; the explicit filter keeps the query efficient and
 * its intent obvious.
 */
export async function getJobs(supabase: SupabaseClient, organizationId: string): Promise<Job[]> {
  const { data } = await supabase
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1000);

  return ((data ?? []) as RawJobRow[]).map(normalizeJob);
}

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
  return normalizeJob(data as RawJobRow);
}

/**
 * Looks up the job created from a given estimate, if any - the actual
 * lookup emitJobCreatedFromEstimate uses to make "estimate accepted ->
 * exactly one job" idempotent (see lib/automation/jobs.ts). Scoped to the
 * org for the same defense-in-depth reason every other lookup here is.
 * Unchanged in contract (still resolves to a single Job or null) - only the
 * embedded contact/lead/estimate fields are new, and the existing callers
 * in lib/automation/jobs.ts and lib/automation/post-job-followup.ts only
 * ever read the flat scalar fields that were already present.
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
  return normalizeJob(data as RawJobRow);
}

export type JobFilters = {
  query?: string;
  status?: JobStatus | "all";
};

/**
 * Filters an already-fetched, org-scoped job list in memory, the same
 * approach filterLeads/filterEstimates use - a plain ilike/or() query can't
 * match a combined contact full name against separately-stored first/last
 * columns.
 */
export function filterJobs(jobs: Job[], filters: JobFilters): Job[] {
  const term = filters.query?.trim().toLowerCase() ?? "";

  return jobs.filter((job) => {
    if (filters.status && filters.status !== "all" && job.status !== filters.status) return false;

    if (!term) return true;

    const contact = job.contact;
    const fullName = contact
      ? [contact.first_name, contact.last_name].filter(Boolean).join(" ").toLowerCase()
      : "";
    const haystacks = [
      job.title.toLowerCase(),
      fullName,
      contact?.first_name?.toLowerCase(),
      contact?.last_name?.toLowerCase(),
      contact?.company_name?.toLowerCase(),
      contact?.phone?.toLowerCase(),
      contact?.email?.toLowerCase(),
    ];
    return haystacks.some((value) => value?.includes(term));
  });
}

export type JobSummary = {
  total: number;
  scheduledCount: number;
  inProgressCount: number;
  completedValue: number;
};

/**
 * Mirrors summarizeEstimates' shape: total, the two "in flight" counts, and
 * one closed-won value total - the same restrained set of numbers, not
 * every status count.
 */
export function summarizeJobs(jobs: Job[]): JobSummary {
  return {
    total: jobs.length,
    scheduledCount: jobs.filter((job) => job.status === "scheduled").length,
    inProgressCount: jobs.filter((job) => job.status === "in_progress").length,
    completedValue: jobs
      .filter((job) => job.status === "completed")
      .reduce((sum, job) => sum + (job.amount ?? 0), 0),
  };
}
