import Link from "next/link";
import { cardClass } from "@/lib/ui/card";
import { contactDisplayName, contactInitials } from "@/lib/contacts/format";
import { formatAppointmentDate, formatAppointmentTimeRange, getDayGroupLabel } from "@/lib/appointments/format";
import type { Appointment, AppointmentView } from "@/lib/appointments/queries";
import { AppointmentStatusBadge } from "./status-badge";

function AppointmentRow({
  appointment,
  showDate,
  timeZone,
}: {
  appointment: Appointment;
  showDate: boolean;
  timeZone?: string;
}) {
  const name = appointment.contact ? contactDisplayName(appointment.contact) : "No contact";

  return (
    <li>
      <Link
        href={`/appointments/${appointment.id}`}
        className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-slate-50 sm:px-5"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
          {appointment.contact ? contactInitials(appointment.contact) : "?"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-slate-900">{name}</span>
            <AppointmentStatusBadge status={appointment.status} />
          </span>
          <span className="mt-0.5 block truncate text-xs text-slate-500">
            {showDate ? `${formatAppointmentDate(appointment.start_at, timeZone)} · ` : ""}
            {formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timeZone)} · {appointment.title}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function AppointmentsList({
  appointments,
  view,
  hasActiveFilters,
  timeZone,
}: {
  appointments: Appointment[];
  view: AppointmentView;
  hasActiveFilters: boolean;
  timeZone?: string;
}) {
  if (appointments.length === 0) {
    const emptyMessage =
      view === "today"
        ? "No appointments today."
        : view === "past"
          ? "No past appointments."
          : "No upcoming appointments.";

    return (
      <div className={`${cardClass} px-5 py-12 text-center`}>
        <p className="text-sm font-medium text-slate-900">{emptyMessage}</p>
        {hasActiveFilters ? (
          <p className="mt-1 text-sm text-slate-500">Try a different search term or clear your filters.</p>
        ) : null}
      </div>
    );
  }

  if (view !== "upcoming") {
    // "past" reads most-recent-first; the base list is ascending by start_at.
    const ordered = view === "past" ? [...appointments].reverse() : appointments;

    return (
      <div className={cardClass}>
        <ul className="divide-y divide-slate-100">
          {ordered.map((appointment) => (
            <AppointmentRow
              key={appointment.id}
              appointment={appointment}
              showDate={view === "past"}
              timeZone={timeZone}
            />
          ))}
        </ul>
      </div>
    );
  }

  const groups = new Map<string, Appointment[]>();
  for (const appointment of appointments) {
    const label = getDayGroupLabel(appointment.start_at, new Date(), timeZone);
    const existing = groups.get(label) ?? [];
    existing.push(appointment);
    groups.set(label, existing);
  }

  return (
    <div className="space-y-6">
      {[...groups.entries()].map(([label, items]) => (
        <div key={label}>
          <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</h3>
          <div className={cardClass}>
            <ul className="divide-y divide-slate-100">
              {items.map((appointment) => (
                <AppointmentRow key={appointment.id} appointment={appointment} showDate={false} timeZone={timeZone} />
              ))}
            </ul>
          </div>
        </div>
      ))}
    </div>
  );
}
