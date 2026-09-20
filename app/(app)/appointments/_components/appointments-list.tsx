import Link from "next/link";
import { CalendarCheck2, CalendarClock, ChevronRight, History, SearchX } from "lucide-react";
import { sectionLabelClass } from "@/lib/ui/typography";
import { Badge } from "@/lib/ui/badge";
import { EmptyState } from "@/lib/ui/empty-state";
import { contactDisplayName, contactInitials } from "@/lib/contacts/format";
import {
  formatAppointmentDate,
  formatAppointmentTime,
  formatAppointmentTimeRange,
  getDayGroupLabel,
  STATUS_LABELS,
} from "@/lib/appointments/format";
import type { Appointment, AppointmentView } from "@/lib/appointments/queries";
import { APPOINTMENT_STATUS_TONE, APPOINTMENT_STATUS_ICON } from "./status";

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
        className="group flex items-center gap-3 rounded-md px-2 py-3.5 transition-colors hover:bg-slate-50"
      >
        {/* Leading time column - this list reads as "the contractor's day"
            first and foremost, so the answer to "when" is the first thing
            scanned in each row, not buried in the subtext line below. */}
        <span className="w-14 shrink-0 text-sm font-semibold tabular-nums text-slate-900">
          {formatAppointmentTime(appointment.start_at, timeZone)}
        </span>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
          {appointment.contact ? contactInitials(appointment.contact) : "?"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-slate-900">{name}</span>
            <Badge tone={APPOINTMENT_STATUS_TONE[appointment.status]} icon={APPOINTMENT_STATUS_ICON[appointment.status]}>
              {STATUS_LABELS[appointment.status]}
            </Badge>
          </span>
          <span className="mt-0.5 block truncate text-xs text-slate-500">
            {showDate ? `${formatAppointmentDate(appointment.start_at, timeZone)} · ` : ""}
            {formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timeZone)} · {appointment.title}
          </span>
        </span>
        <ChevronRight
          aria-hidden
          className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500"
        />
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
    if (hasActiveFilters) {
      return (
        <div className="px-2">
          <EmptyState
            icon={SearchX}
            title="No appointments match your filters."
            description="Try a different search term, or clear your filters to see the full list."
          />
        </div>
      );
    }

    const empty =
      view === "today"
        ? {
            icon: CalendarCheck2,
            title: "Nothing on the schedule today.",
            description: "Today's calendar is clear. New appointments will show up here as soon as they're booked.",
          }
        : view === "past"
          ? {
              icon: History,
              title: "No past appointments yet.",
              description: "Completed and past visits will appear here once you've had your first appointment.",
            }
          : {
              icon: CalendarClock,
              title: "No upcoming appointments.",
              description: "Appointments you schedule will show up here, soonest first.",
            };

    return (
      <div className="px-2">
        <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />
      </div>
    );
  }

  if (view !== "upcoming") {
    // "past" reads most-recent-first; the base list is ascending by start_at.
    const ordered = view === "past" ? [...appointments].reverse() : appointments;

    return (
      <ul className="divide-y divide-slate-100">
        {ordered.map((appointment) => (
          <AppointmentRow key={appointment.id} appointment={appointment} showDate={view === "past"} timeZone={timeZone} />
        ))}
      </ul>
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
    <div className="space-y-8">
      {[...groups.entries()].map(([label, items]) => (
        <div key={label}>
          <p className={sectionLabelClass}>{label}</p>
          <ul className="mt-3 divide-y divide-slate-100">
            {items.map((appointment) => (
              <AppointmentRow key={appointment.id} appointment={appointment} showDate={false} timeZone={timeZone} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
