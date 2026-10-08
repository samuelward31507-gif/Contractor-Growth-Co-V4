import type { ActorOwner } from "@/lib/decisions/owner";
import type { Appointment } from "./queries";
import { getDayGroupLabel, isSameCalendarDay } from "./format";

/**
 * Batch 3 (core daily loop): Schedule's agenda - what is happening today
 * and next, grouped by the organization's calendar day. Pure, over the
 * appointments the page already loaded; nothing is scheduled, confirmed or
 * changed here.
 *
 * Every line is backed by a stored fact: a confirmation (confirmed_at or
 * status "confirmed"), a reminder that reached the customer
 * (confirmation_requested_at - set only when the confirmation-asking
 * reminder was actually delivered), or the appointment's own status. The
 * owner follows the actor model: showing up is always the contractor's; a
 * sent, unanswered confirmation request is the customer's move; a past
 * visit nobody closed out is the contractor's, and the only one urgent.
 */
export type AgendaRow = {
  id: string;
  startAt: string;
  endAt: string;
  title: string;
  contactName: string | null;
  owner: ActorOwner | null;
  line: string;
  needsYou: boolean;
};

export type AgendaGroup = { label: string; rows: AgendaRow[] };

export type Agenda = {
  /** Past visits still marked scheduled/confirmed - "mark how it went" (the overdue-appointment signal). */
  needsClosing: AgendaRow[];
  today: AgendaRow[];
  /** After today, within the horizon, active only - one group per day. */
  upcoming: AgendaGroup[];
};

const ACTIVE = new Set(["scheduled", "confirmed"]);
export const AGENDA_HORIZON_DAYS = 14;
/** How far back an un-closed visit still shows on the agenda. */
export const AGENDA_CLOSE_OUT_DAYS = 14;

type AgendaInput = Pick<Appointment, "id" | "title" | "start_at" | "end_at" | "status" | "confirmed_at" | "confirmation_requested_at"> & {
  contact?: { first_name: string | null; last_name: string | null } | null;
};

function contactName(appointment: AgendaInput): string | null {
  const name = [appointment.contact?.first_name, appointment.contact?.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

export function describeAppointment(appointment: AgendaInput, now: number): Pick<AgendaRow, "owner" | "line" | "needsYou"> {
  const startMs = new Date(appointment.start_at).getTime();
  const endMs = new Date(appointment.end_at).getTime();
  const active = ACTIVE.has(appointment.status);
  if (appointment.status === "completed") return { owner: null, line: "Completed", needsYou: false };
  if (appointment.status === "no_show") return { owner: null, line: "No-show", needsYou: false };
  if (appointment.status === "cancelled") return { owner: null, line: "Cancelled", needsYou: false };
  if (active && (Number.isFinite(endMs) ? endMs : startMs) < now) return { owner: "you", line: "Visit time has passed · mark how it went", needsYou: true };
  const confirmed = appointment.status === "confirmed" || appointment.confirmed_at !== null;
  const reminded = appointment.confirmation_requested_at !== null;
  if (confirmed) return { owner: "you", line: reminded ? "Confirmed after Trackpr's reminder · you're meeting them" : "Confirmed · you're meeting them", needsYou: false };
  if (reminded) return { owner: "customer", line: "Trackpr sent a reminder · waiting for them to confirm", needsYou: false };
  return { owner: "you", line: "Not confirmed yet · you're meeting them", needsYou: false };
}

export function buildAgenda(appointments: AgendaInput[], now: Date, timeZone: string | undefined): Agenda {
  const nowMs = now.getTime();
  const horizonMs = nowMs + AGENDA_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const closeOutFromMs = nowMs - AGENDA_CLOSE_OUT_DAYS * 24 * 60 * 60 * 1000;
  const byStart = [...appointments].sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
  const toRow = (appointment: AgendaInput): AgendaRow => ({
    id: appointment.id,
    startAt: appointment.start_at,
    endAt: appointment.end_at,
    title: appointment.title,
    contactName: contactName(appointment),
    ...describeAppointment(appointment, nowMs),
  });

  const today: AgendaRow[] = [];
  const needsClosing: AgendaRow[] = [];
  const upcomingByLabel = new Map<string, AgendaRow[]>();

  for (const appointment of byStart) {
    const startMs = new Date(appointment.start_at).getTime();
    if (!Number.isFinite(startMs)) continue;
    const isToday = isSameCalendarDay(new Date(startMs), now, timeZone);
    if (isToday) {
      if (appointment.status !== "cancelled") today.push(toRow(appointment));
      continue;
    }
    if (startMs < nowMs) {
      if (ACTIVE.has(appointment.status) && startMs >= closeOutFromMs) needsClosing.push(toRow(appointment));
      continue;
    }
    if (startMs <= horizonMs && ACTIVE.has(appointment.status)) {
      const label = getDayGroupLabel(appointment.start_at, now, timeZone);
      upcomingByLabel.set(label, [...(upcomingByLabel.get(label) ?? []), toRow(appointment)]);
    }
  }

  return { needsClosing, today, upcoming: [...upcomingByLabel].map(([label, rows]) => ({ label, rows })) };
}
