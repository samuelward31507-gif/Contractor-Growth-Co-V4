import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "@/lib/contacts/queries";
import type { LeadStatus, LeadTemperature } from "@/lib/leads/queries";

export type EstimateStatus = "draft" | "sent" | "accepted" | "declined" | "cancelled" | "expired";

export const ESTIMATE_STATUSES: { value: EstimateStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

export type EstimateContact = Pick<Contact, "id" | "first_name" | "last_name" | "company_name" | "phone" | "email">;

export type EstimateLead = {
  id: string;
  service: string | null;
  status: LeadStatus;
  temperature: LeadTemperature;
};

export type Estimate = {
  id: string;
  organization_id: string;
  contact_id: string | null;
  lead_id: string | null;
  title: string;
  amount: number | null;
  status: EstimateStatus;
  notes: string | null;
  sent_at: string | null;
  responded_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  contact: EstimateContact | null;
  lead: EstimateLead | null;
};

// A single string literal (not `+` concatenation) - matches
// lib/appointments/queries.ts's APPOINTMENT_COLUMNS convention: Supabase's
// type-level select parser needs the literal type to infer typed columns.
const ESTIMATE_COLUMNS =
  "id, organization_id, contact_id, lead_id, title, amount, status, notes, sent_at, responded_at, expires_at, created_at, updated_at, contact:contacts(id, first_name, last_name, company_name, phone, email), lead:leads(id, service, status, temperature)";

type Embedded<T> = T | T[] | null;

function one<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

type RawEstimateRow = Omit<Estimate, "contact" | "lead"> & {
  contact: Embedded<EstimateContact>;
  lead: Embedded<EstimateLead>;
};

function normalizeEstimate(row: RawEstimateRow): Estimate {
  return { ...row, contact: one(row.contact), lead: one(row.lead) };
}

/**
 * Loads every estimate for the org (capped, matching the Leads/Appointments
 * pattern), with its contact and lead embedded via the existing foreign
 * keys. RLS already scopes rows to the caller's organization; the explicit
 * filter keeps the query efficient and its intent obvious.
 */
export type EstimatesResult = { data: Estimate[]; failed: boolean };

/** Trackpr 2.0, Phase 4C (P2 #1): `failed` is true only on a real Postgrest error, never on a genuine empty org. Wired into the canonical Estimates list page, whose own "no estimates yet" empty state would otherwise be indistinguishable from a failed read. */
export async function getEstimatesResult(supabase: SupabaseClient, organizationId: string): Promise<EstimatesResult> {
  const { data, error } = await supabase
    .from("estimates")
    .select(ESTIMATE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1000);

  return { data: ((data ?? []) as RawEstimateRow[]).map(normalizeEstimate), failed: error != null };
}

export async function getEstimates(supabase: SupabaseClient, organizationId: string): Promise<Estimate[]> {
  return (await getEstimatesResult(supabase, organizationId)).data;
}

/**
 * Loads a single estimate scoped to the org. Mirrors getAppointment's
 * contract exactly: any error (invalid id, not found, wrong org) resolves
 * to null rather than throwing.
 */
export async function getEstimate(
  supabase: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<Estimate | null> {
  const { data, error } = await supabase
    .from("estimates")
    .select(ESTIMATE_COLUMNS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return normalizeEstimate(data as RawEstimateRow);
}

export type EstimateFilters = {
  query?: string;
  status?: EstimateStatus | "all";
};

/**
 * Filters an already-fetched, org-scoped estimate list in memory, the same
 * approach filterLeads/filterAppointmentsByView use - a plain ilike/or()
 * query can't match a combined contact full name against separately-stored
 * first/last columns.
 */
export function filterEstimates(estimates: Estimate[], filters: EstimateFilters): Estimate[] {
  const term = filters.query?.trim().toLowerCase() ?? "";

  return estimates.filter((estimate) => {
    if (filters.status && filters.status !== "all" && estimate.status !== filters.status) return false;

    if (!term) return true;

    const contact = estimate.contact;
    const fullName = contact
      ? [contact.first_name, contact.last_name].filter(Boolean).join(" ").toLowerCase()
      : "";
    const haystacks = [
      estimate.title.toLowerCase(),
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

export type EstimateSummary = {
  total: number;
  draftCount: number;
  sentCount: number;
  openValue: number;
  acceptedValue: number;
};

/** Estimates still awaiting a customer decision - not yet accepted, declined, cancelled, or expired. */
const OPEN_ESTIMATE_STATUSES = new Set<EstimateStatus>(["draft", "sent"]);

/**
 * Mirrors summarizeLeads' shape: total, one "needs your attention" count
 * (open, unsent drafts), one in-flight count, an open pipeline value total
 * (the same OPEN_LEAD_STATUSES-style derivation lib/leads/queries.ts's
 * summarizeLeads already uses for openValue, applied to estimates' own
 * draft/sent statuses), and one closed-won value total - the same
 * restrained set of numbers Leads surfaces, not every status count.
 */
export function summarizeEstimates(estimates: Estimate[]): EstimateSummary {
  return {
    total: estimates.length,
    draftCount: estimates.filter((estimate) => estimate.status === "draft").length,
    sentCount: estimates.filter((estimate) => estimate.status === "sent").length,
    openValue: estimates
      .filter((estimate) => OPEN_ESTIMATE_STATUSES.has(estimate.status))
      .reduce((sum, estimate) => sum + (estimate.amount ?? 0), 0),
    acceptedValue: estimates
      .filter((estimate) => estimate.status === "accepted")
      .reduce((sum, estimate) => sum + (estimate.amount ?? 0), 0),
  };
}
