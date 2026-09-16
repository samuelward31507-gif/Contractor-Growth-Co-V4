import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "@/lib/contacts/queries";
import type { LeadStatus, LeadTemperature } from "@/lib/leads/queries";
import { isSameCalendarDay } from "./format";

export type AppointmentStatus = "scheduled" | "confirmed" | "completed" | "cancelled" | "no_show";

export const APPOINTMENT_STATUSES: { value: AppointmentStatus; label: string }[] = [
  { value: "scheduled", label: "Scheduled" },
  { value: "confirmed", label: "Confirmed" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show", label: "No-Show" },
];

export type AppointmentContact = Pick<
  Contact,
  "id" | "first_name" | "last_name" | "company_name" | "phone" | "email"
>;

export type AppointmentLead = {
  id: string;
  service: string | null;
  source: string | null;
  status: LeadStatus;
  temperature: LeadTemperature;
  estimated_value: number | null;
};

export type Appointment = {
  id: string;
  contact_id: string | null;
  lead_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  contact: AppointmentContact | null;
  lead: AppointmentLead | null;
};

// A single string literal (not `+` concatenation) - Supabase's type-level
// select parser needs the literal type to infer typed columns; concatenated
// strings widen to `string` and fall back to an untyped result.
const APPOINTMENT_COLUMNS =
  "id, contact_id, lead_id, title, start_at, end_at, status, notes, created_at, updated_at, contact:contacts(id, first_name, last_name, company_name, phone, email), lead:leads(id, service, source, status, temperature, estimated_value)";

type Embedded<T> = T | T[] | null;

function one<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

type RawAppointmentRow = Omit<Appointment, "contact" | "lead"> & {
  contact: Embedded<AppointmentContact>;
  lead: Embedded<AppointmentLead>;
};

function normalizeAppointment(row: RawAppointmentRow): Appointment {
  return { ...row, contact: one(row.contact), lead: one(row.lead) };
}

/**
 * Loads every appointment for the org (capped, matching the
 * Contacts/Leads/dashboard pattern), with its contact and lead embedded via
 * the existing foreign keys (a single PostgREST query, not denormalized
 * columns on appointments). RLS already scopes rows to the caller's
 * organization; the explicit filter keeps the query efficient and its
 * intent obvious.
 */
export async function getAppointments(supabase: SupabaseClient, organizationId: string): Promise<Appointment[]> {
  const { data } = await supabase
    .from("appointments")
    .select(APPOINTMENT_COLUMNS)
    .eq("organization_id", organizationId)
    .order("start_at", { ascending: true })
    .limit(1000);

  return ((data ?? []) as RawAppointmentRow[]).map(normalizeAppointment);
}

/**
 * Loads a single appointment scoped to the org. Any error - including an
 * invalid UUID in `id`, a nonexistent appointment, or one belonging to a
 * different organization - resolves to `null` rather than throwing, so
 * callers can render a clean "not found" state instead of a crash.
 */
export async function getAppointment(
  supabase: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<Appointment | null> {
  const { data, error } = await supabase
    .from("appointments")
    .select(APPOINTMENT_COLUMNS)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return normalizeAppointment(data as RawAppointmentRow);
}

export type AppointmentView = "upcoming" | "today" | "past";

/**
 * Purely time-based partition of the org's appointments into the three
 * views the list page supports. Independent of the status filter, which is
 * a separate, orthogonal control.
 */
export function filterAppointmentsByView(
  appointments: Appointment[],
  view: AppointmentView,
  now: Date = new Date(),
): Appointment[] {
  return appointments.filter((appointment) => {
    const start = new Date(appointment.start_at);
    if (view === "today") return isSameCalendarDay(start, now);
    if (view === "past") return start.getTime() < now.getTime();
    return start.getTime() >= now.getTime();
  });
}

export type AppointmentFilters = {
  query?: string;
  status?: AppointmentStatus | "all";
};

/**
 * Filters an already-fetched, org-scoped appointment list in memory. A
 * plain ilike/or() query can't match a combined contact full name against
 * separately-stored first/last columns, so search happens here over real
 * data rather than a fragile multi-column OR query.
 */
export function filterAppointments(appointments: Appointment[], filters: AppointmentFilters): Appointment[] {
  const term = filters.query?.trim().toLowerCase() ?? "";

  return appointments.filter((appointment) => {
    if (filters.status && filters.status !== "all" && appointment.status !== filters.status) {
      return false;
    }

    if (!term) return true;

    const contact = appointment.contact;
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
      appointment.title.toLowerCase(),
      appointment.lead?.service?.toLowerCase(),
    ];
    return haystacks.some((value) => value?.includes(term));
  });
}

export type AppointmentSummary = {
  upcoming: number;
  today: number;
  completed: number;
  noShows: number;
};

export function summarizeAppointments(appointments: Appointment[], now: Date = new Date()): AppointmentSummary {
  return {
    upcoming: appointments.filter(
      (appointment) => new Date(appointment.start_at).getTime() > now.getTime() && appointment.status !== "cancelled",
    ).length,
    today: appointments.filter((appointment) => isSameCalendarDay(new Date(appointment.start_at), now)).length,
    completed: appointments.filter((appointment) => appointment.status === "completed").length,
    noShows: appointments.filter((appointment) => appointment.status === "no_show").length,
  };
}
