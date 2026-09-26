import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "@/lib/contacts/queries";

export type LeadStatus = "new" | "contacted" | "qualified" | "appointment" | "estimate" | "won" | "lost";
export type LeadTemperature = "cold" | "warm" | "hot";

export const LEAD_STATUSES: { value: LeadStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "qualified", label: "Qualified" },
  { value: "appointment", label: "Appointment" },
  { value: "estimate", label: "Estimate" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

export const LEAD_TEMPERATURES: { value: LeadTemperature; label: string }[] = [
  { value: "cold", label: "Cold" },
  { value: "warm", label: "Warm" },
  { value: "hot", label: "Hot" },
];

/**
 * Statuses that represent an active, still-open opportunity. Won/lost are
 * closed outcomes and excluded. This is the single source of truth for
 * "open opportunity" logic - used by the summary metrics here - rather than
 * scattering status checks through the UI.
 */
export const OPEN_LEAD_STATUSES = new Set<LeadStatus>([
  "new",
  "contacted",
  "qualified",
  "appointment",
  "estimate",
]);

export type LeadContact = Pick<Contact, "id" | "first_name" | "last_name" | "company_name" | "phone" | "email">;

export type Lead = {
  id: string;
  contact_id: string | null;
  source: string | null;
  service: string | null;
  status: LeadStatus;
  temperature: LeadTemperature;
  estimated_value: number | null;
  ai_score: number | null;
  ai_summary: string | null;
  created_at: string;
  updated_at: string;
  contact: LeadContact | null;
};

const LEAD_COLUMNS =
  "id, contact_id, source, service, status, temperature, estimated_value, ai_score, ai_summary, created_at, updated_at, contact:contacts(id, first_name, last_name, company_name, phone, email)";

type RawLeadRow = Omit<Lead, "contact"> & { contact: LeadContact | LeadContact[] | null };

function normalizeLead(row: RawLeadRow): Lead {
  const contact = Array.isArray(row.contact) ? (row.contact[0] ?? null) : row.contact;
  return { ...row, contact };
}

/**
 * Loads every lead for the org (capped, matching the Contacts/dashboard
 * pattern), with its associated contact embedded via the existing
 * `leads.contact_id -> contacts.id` foreign key (a single PostgREST query,
 * not a denormalized name column on leads). RLS already scopes rows to the
 * caller's organization; the explicit filter keeps the query efficient and
 * its intent obvious.
 */
export type LeadsResult = { data: Lead[]; failed: boolean };

/** Trackpr 2.0, Phase 4C (P2 #1): `failed` is true only on a real Postgrest error, never on a genuine empty org. Wired into the canonical Leads (Customers) list page, whose own "no leads yet" empty state would otherwise be indistinguishable from a failed read. */
export async function getLeadsResult(supabase: SupabaseClient, organizationId: string): Promise<LeadsResult> {
  const { data, error } = await supabase
    .from("leads")
    .select(LEAD_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1000);

  return { data: ((data ?? []) as RawLeadRow[]).map(normalizeLead), failed: error != null };
}

export async function getLeads(supabase: SupabaseClient, organizationId: string): Promise<Lead[]> {
  return (await getLeadsResult(supabase, organizationId)).data;
}

export type LeadFilters = {
  query?: string;
  status?: LeadStatus | "all";
  temperature?: LeadTemperature | "all";
};

/**
 * Filters an already-fetched, org-scoped lead list in memory. A plain
 * ilike/or() query can't match a combined contact full name against
 * separately-stored first/last columns, so search happens here over real
 * data rather than a fragile multi-column OR query.
 */
export function filterLeads(leads: Lead[], filters: LeadFilters): Lead[] {
  const term = filters.query?.trim().toLowerCase() ?? "";

  return leads.filter((lead) => {
    if (filters.status && filters.status !== "all" && lead.status !== filters.status) return false;
    if (filters.temperature && filters.temperature !== "all" && lead.temperature !== filters.temperature) {
      return false;
    }

    if (!term) return true;

    const contact = lead.contact;
    const fullName = contact
      ? [contact.first_name, contact.last_name].filter(Boolean).join(" ").toLowerCase()
      : "";
    const haystacks = [
      fullName,
      contact?.first_name?.toLowerCase(),
      contact?.last_name?.toLowerCase(),
      contact?.phone?.toLowerCase(),
      contact?.email?.toLowerCase(),
      contact?.company_name?.toLowerCase(),
      lead.service?.toLowerCase(),
      lead.source?.toLowerCase(),
    ];
    return haystacks.some((value) => value?.includes(term));
  });
}

export type LeadSummary = {
  total: number;
  newCount: number;
  hotCount: number;
  openValue: number;
};

export function summarizeLeads(leads: Lead[]): LeadSummary {
  return {
    total: leads.length,
    newCount: leads.filter((lead) => lead.status === "new").length,
    hotCount: leads.filter((lead) => lead.temperature === "hot").length,
    openValue: leads
      .filter((lead) => OPEN_LEAD_STATUSES.has(lead.status))
      .reduce((sum, lead) => sum + (lead.estimated_value ?? 0), 0),
  };
}

/**
 * Loads a single lead scoped to the org. Any error - including an invalid
 * UUID in `id`, a nonexistent lead, or a lead belonging to a different
 * organization - resolves to `null` rather than throwing, so callers can
 * render a clean "not found" state instead of a crash.
 */
export async function getLead(supabase: SupabaseClient, organizationId: string, id: string): Promise<Lead | null> {
  const { data, error } = await supabase
    .from("leads")
    .select(LEAD_COLUMNS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return normalizeLead(data as RawLeadRow);
}
