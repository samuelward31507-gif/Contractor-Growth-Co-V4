import Link from "next/link";
import { sectionLabelClass } from "@/lib/ui/typography";
import { formatAppointmentTimeRange, STATUS_DOT_CLASS, STATUS_LABELS } from "@/lib/appointments/format";
import type { Appointment } from "@/lib/appointments/queries";

function contactName(appointment: Appointment): string | null {
  const contact = appointment.contact;
  if (!contact) return null;
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

/**
 * Trackpr 2.0, Phase 3B: previously this row showed EITHER the contact name
 * OR the appointment title, never both - if a contact existed, its own
 * title/service context (real data, already on every appointment row) was
 * silently hidden. Now the contact name (when present) is the primary line
 * and the title becomes a real secondary "what this is" line underneath,
 * matching the time -> customer -> service/context -> status grammar this
 * section is meant to read as. No new data - `appointment.title` already
 * existed and was already being fetched; this only changes which of the two
 * already-fetched fields gets shown when both are present.
 */
function contactOrTitle(appointment: Appointment): string {
  return contactName(appointment) ?? appointment.title;
}

/**
 * Client #1 polish pass - "what do I need to do today" answered without
 * leaving the dashboard. `todaysAppointments` is filtered in the page from
 * the exact same getAppointments() read the Appointments page itself uses -
 * no new query, nothing invented. Cancelled visits are excluded: a
 * cancelled appointment isn't part of "today's schedule" anymore.
 *
 * Trackpr 2.0, Phase 2A: `timeZone` is optional and purely a display concern
 * here - which appointments count as "today" is now decided in the page
 * itself using the organization's configured timezone (see page.tsx's own
 * comment); this component just needs the same timezone for its displayed
 * time range, so it never shows a time in a different zone than the day
 * boundary that selected it. Omitted, behavior is unchanged from before.
 */
export function TodaysSchedule({ appointments, timeZone }: { appointments: Appointment[]; timeZone?: string }) {
  const items = appointments
    .filter((appointment) => appointment.status !== "cancelled")
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());

  return (
    <div>
      <h2 className={sectionLabelClass}>Today&apos;s schedule</h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No appointments scheduled for today.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {items.map((appointment) => {
            const name = contactName(appointment);
            return (
              <li key={appointment.id}>
                <Link
                  href={`/appointments/${appointment.id}`}
                  className="group -mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1"
                >
                  <span className="w-[92px] shrink-0 text-xs font-medium tabular-nums text-slate-500">
                    {formatAppointmentTimeRange(appointment.start_at, appointment.end_at, timeZone)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900">{contactOrTitle(appointment)}</span>
                    {name ? <span className="block truncate text-xs text-slate-500">{appointment.title}</span> : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-slate-500">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[appointment.status]}`} aria-hidden />
                    {STATUS_LABELS[appointment.status]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
