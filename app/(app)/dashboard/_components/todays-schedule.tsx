import Link from "next/link";
import { sectionLabelClass } from "@/lib/ui/typography";
import { formatAppointmentTimeRange, STATUS_DOT_CLASS, STATUS_LABELS } from "@/lib/appointments/format";
import type { Appointment } from "@/lib/appointments/queries";

function contactOrTitle(appointment: Appointment): string {
  const contact = appointment.contact;
  if (contact) {
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
    if (name) return name;
  }
  return appointment.title;
}

/**
 * Client #1 polish pass - "what do I need to do today" answered without
 * leaving the dashboard. `todaysAppointments` is filtered in the page from
 * the exact same getAppointments() read the Appointments page itself uses -
 * no new query, nothing invented. Cancelled visits are excluded: a
 * cancelled appointment isn't part of "today's schedule" anymore.
 */
export function TodaysSchedule({ appointments }: { appointments: Appointment[] }) {
  const items = appointments
    .filter((appointment) => appointment.status !== "cancelled")
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());

  return (
    <div>
      <p className={sectionLabelClass}>Today&apos;s schedule</p>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No appointments scheduled for today.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {items.map((appointment) => (
            <li key={appointment.id}>
              <Link
                href={`/appointments/${appointment.id}`}
                className="group -mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-slate-50"
              >
                <span className="w-[92px] shrink-0 text-xs font-medium tabular-nums text-slate-500">
                  {formatAppointmentTimeRange(appointment.start_at, appointment.end_at)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{contactOrTitle(appointment)}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-slate-500">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[appointment.status]}`} aria-hidden />
                  {STATUS_LABELS[appointment.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
