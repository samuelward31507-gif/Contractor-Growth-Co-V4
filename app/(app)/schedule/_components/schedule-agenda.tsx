import Link from "next/link";
import { CalendarCheck2 } from "lucide-react";
import type { Agenda, AgendaRow } from "@/lib/appointments/agenda";
import { formatAppointmentTimeRange } from "@/lib/appointments/format";
import { formatCalendarDay } from "@/lib/format/datetime";
import { EmptyState } from "@/lib/ui/empty-state";
import { OwnerChip } from "@/lib/ui/owner-chip";
import { cardClass } from "@/lib/ui/surface";
import { primarySectionTitleClass } from "@/lib/ui/typography";

/**
 * Batch 3 (core daily loop): Schedule's agenda - a scannable list of today
 * and the next two weeks, each visit with its time, customer, status and
 * whose move it is (lib/appointments/agenda.ts). Past visits nobody closed
 * out come first, since they are the only thing here that needs the
 * contractor.
 */
export function ScheduleAgenda({ agenda, timeZone, emptyAction }: { agenda: Agenda; timeZone: string | undefined; emptyAction: React.ReactNode }) {
  const nothingAhead = agenda.today.length === 0 && agenda.upcoming.length === 0 && agenda.needsClosing.length === 0;
  if (nothingAhead) {
    return (
      <EmptyState
        icon={CalendarCheck2}
        title="Nothing on the calendar for the next two weeks."
        description="Appointments you or Trackpr book show up here, today first. The calendar and the full list keep everything else."
        action={emptyAction}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {agenda.needsClosing.length > 0 ? <AgendaSection id="agenda-close-out" title="Needs closing out" rows={agenda.needsClosing} timeZone={timeZone} showDate /> : null}
      <AgendaSection id="agenda-today" title="Today" rows={agenda.today} timeZone={timeZone} empty="Nothing on the calendar today." />
      <section aria-labelledby="agenda-upcoming" className={`min-w-0 overflow-hidden ${cardClass}`}>
        <h2 id="agenda-upcoming" className={`px-4 pb-2 pt-4 sm:px-5 sm:pt-5 ${primarySectionTitleClass}`}>
          Coming up
        </h2>
        {agenda.upcoming.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-ink-3 sm:px-5 sm:pb-5">Nothing booked in the next two weeks.</p>
        ) : (
          agenda.upcoming.map((group) => (
            <div key={group.label}>
              <p className="border-t border-line bg-inset/60 px-4 py-1.5 text-xs font-medium text-ink-3 sm:px-5">{group.label}</p>
              <AgendaRows rows={group.rows} timeZone={timeZone} />
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function AgendaSection({ id, title, rows, timeZone, empty, showDate = false }: { id: string; title: string; rows: AgendaRow[]; timeZone: string | undefined; empty?: string; showDate?: boolean }) {
  return (
    <section aria-labelledby={id} className={`min-w-0 overflow-hidden ${cardClass}`}>
      <h2 id={id} className={`px-4 pb-2 pt-4 sm:px-5 sm:pt-5 ${primarySectionTitleClass}`}>
        {title}
      </h2>
      {rows.length === 0 ? <p className="px-4 pb-4 text-[13px] text-ink-3 sm:px-5 sm:pb-5">{empty}</p> : <AgendaRows rows={rows} timeZone={timeZone} showDate={showDate} />}
    </section>
  );
}

function AgendaRows({ rows, timeZone, showDate = false }: { rows: AgendaRow[]; timeZone: string | undefined; showDate?: boolean }) {
  return (
    <ul className="divide-y divide-line border-t border-line">
      {rows.map((row) => (
        <li key={row.id}>
          <Link href={`/appointments/${row.id}`} className="flex min-h-14 flex-col gap-1 px-4 py-3 transition-colors hover:bg-hover sm:flex-row sm:items-center sm:gap-4 sm:px-5">
            <span className="shrink-0 text-[12.5px] font-medium tabular-nums text-ink-2 sm:w-52">
              {showDate ? `${formatCalendarDay(row.startAt, timeZone)} · ` : ""}
              {formatAppointmentTimeRange(row.startAt, row.endAt, timeZone)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{row.contactName ?? row.title}</span>
              <span className="block truncate text-xs text-ink-3">{row.contactName ? row.title : "Appointment"}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1.5 sm:max-w-[45%]">
              {row.owner ? <OwnerChip owner={row.owner} urgent={row.needsYou} /> : null}
              <span className={`truncate text-xs ${row.needsYou ? "font-medium text-ink" : "text-ink-3"}`}>{row.line}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
