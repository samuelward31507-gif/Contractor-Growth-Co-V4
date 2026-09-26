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
  /** Pass 5B: authoritative confirmation timestamp - see the migration's own comment for why status='confirmed' alone isn't enough. Null whenever the appointment has never been confirmed, or a reschedule since invalidated a prior confirmation. */
  confirmed_at: string | null;
  /** Pass 5B: set only when a confirmation-asking reminder actually reached the customer (lib/automation/appointment-reminders.ts) - null means no request has gone out yet, or a reschedule since invalidated it. */
  confirmation_requested_at: string | null;
  contact: AppointmentContact | null;
  lead: AppointmentLead | null;
};

// A single string literal (not `+` concatenation) - Supabase's type-level
// select parser needs the literal type to infer typed columns; concatenated
// strings widen to `string` and fall back to an untyped result.
const APPOINTMENT_COLUMNS =
  "id, contact_id, lead_id, title, start_at, end_at, status, notes, created_at, updated_at, confirmed_at, confirmation_requested_at, contact:contacts(id, first_name, last_name, company_name, phone, email), lead:leads(id, service, source, status, temperature, estimated_value)";

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
export type AppointmentsResult = { data: Appointment[]; failed: boolean };

/** Trackpr 2.0, Phase 4C (P2 #1): `failed` is true only on a real Postgrest error, never on a genuine empty org. Wired into the canonical Appointments list page, whose own "no appointments yet" empty state would otherwise be indistinguishable from a failed read. */
export async function getAppointmentsResult(supabase: SupabaseClient, organizationId: string): Promise<AppointmentsResult> {
  const { data, error } = await supabase
    .from("appointments")
    .select(APPOINTMENT_COLUMNS)
    .eq("organization_id", organizationId)
    .order("start_at", { ascending: true })
    .limit(1000);

  return { data: ((data ?? []) as RawAppointmentRow[]).map(normalizeAppointment), failed: error != null };
}

export async function getAppointments(supabase: SupabaseClient, organizationId: string): Promise<Appointment[]> {
  return (await getAppointmentsResult(supabase, organizationId)).data;
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

/**
 * Pass 2 (Native Calendar System): a date-range-scoped fetch for the
 * calendar's day/week/month views, which navigate freely across time and
 * must never silently miss an appointment outside getAppointments()'s own
 * 1000-row cap. Uses the exact overlap predicate every other range read in
 * this codebase already uses (start_at < rangeEnd AND end_at > rangeStart -
 * see lib/scheduling/availability.ts's getAvailableSlots and
 * lib/appointments/overlap.ts's checkAppointmentOverlap), so an appointment
 * that merely spans into the requested range (rather than starting inside
 * it) is still returned. Cancelled/no-show appointments are intentionally
 * NOT filtered out here - the calendar surfaces every status (Phase 6 needs
 * to display and act on all of them); only the availability engine filters
 * by occupying status.
 */
export type AppointmentsInRangeResult = { data: Appointment[]; failed: boolean };

/** Trackpr 2.0, Phase 4C (P2 #1): `failed` is true only on a real Postgrest error, never on a genuine empty range. Wired into the Calendar grid view, whose own empty grid would otherwise be indistinguishable from a failed read. */
export async function getAppointmentsInRangeResult(
  supabase: SupabaseClient,
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<AppointmentsInRangeResult> {
  const { data, error } = await supabase
    .from("appointments")
    .select(APPOINTMENT_COLUMNS)
    .eq("organization_id", organizationId)
    .lt("start_at", rangeEnd.toISOString())
    .gt("end_at", rangeStart.toISOString())
    .order("start_at", { ascending: true })
    .limit(1000);

  return { data: ((data ?? []) as RawAppointmentRow[]).map(normalizeAppointment), failed: error != null };
}

export async function getAppointmentsInRange(
  supabase: SupabaseClient,
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Appointment[]> {
  return (await getAppointmentsInRangeResult(supabase, organizationId, rangeStart, rangeEnd)).data;
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
