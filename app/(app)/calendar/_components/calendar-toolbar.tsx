"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronLeft, ChevronRight, Plus, CalendarOff } from "lucide-react";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import { primaryButtonAutoClass, secondaryButtonAutoClass, ghostButtonClass } from "@/lib/ui/form";
import { buildCalendarHref, type CalendarView } from "../_lib/date-range";
import { AppointmentDialog } from "../../appointments/_components/appointment-dialog";
import { BlockedTimeDialog } from "./blocked-time-dialog";

const VIEWS: { value: CalendarView; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

/**
 * Pass 2 (Native Calendar System): the calendar's own nav + primary actions
 * - view switcher, prev/today/next navigation (plain Links, so the calendar
 * stays fast/server-navigable and works without JS for the base navigation
 * itself), and the Add Appointment / Block Time triggers.
 *
 * prevHref/nextHref/todayHref are computed server-side (they depend on
 * navigateDate, already run in page.tsx). The view-switcher's own hrefs are
 * computed here instead, from `activeDateStr` (a plain string) via the
 * shared buildCalendarHref - a Server Component can't pass a function prop
 * across to a Client Component (the exact bug this replaces: this
 * component previously received a `dayHrefForView` closure directly from
 * page.tsx, which threw at render time), so this reuses the same pure href
 * builder page.tsx itself uses, rather than receiving one as a closure.
 */
export function CalendarToolbar({
  view,
  label,
  prevHref,
  nextHref,
  todayHref,
  activeDateStr,
  contacts,
  leads,
  timeZone,
}: {
  view: CalendarView;
  /** Human-readable label for the currently displayed range (e.g. "March 2027", "Mar 1 - Mar 7, 2027", "Monday, March 1"). */
  label: string;
  prevHref: string;
  nextHref: string;
  todayHref: string;
  /** The currently displayed date ("YYYY-MM-DD") - used to build each view-switcher link's href while staying on this same date. */
  activeDateStr: string;
  contacts: Contact[];
  leads: Lead[];
  timeZone?: string;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Link
            href={prevHref}
            aria-label="Previous"
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <ChevronLeft aria-hidden className="h-4 w-4" />
          </Link>
          <Link
            href={nextHref}
            aria-label="Next"
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <ChevronRight aria-hidden className="h-4 w-4" />
          </Link>
        </div>
        <h2 className="text-lg font-semibold text-slate-900">{label}</h2>
        <Link href={todayHref} className={ghostButtonClass}>
          Today
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
          {VIEWS.map((item) => (
            <Link
              key={item.value}
              href={buildCalendarHref(item.value, activeDateStr)}
              aria-pressed={view === item.value}
              className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                view === item.value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>

        <button type="button" onClick={() => setBlockOpen(true)} className={secondaryButtonAutoClass}>
          <CalendarOff aria-hidden className="h-4 w-4" />
          Block Time
        </button>

        {contacts.length === 0 ? (
          <Link href="/contacts" className={secondaryButtonAutoClass}>
            Add a contact first
          </Link>
        ) : (
          <button type="button" onClick={() => setAddOpen(true)} className={primaryButtonAutoClass}>
            <Plus aria-hidden className="h-4 w-4" />
            Add Appointment
          </button>
        )}
      </div>

      {addOpen ? <AppointmentDialog mode="create" contacts={contacts} leads={leads} onClose={() => setAddOpen(false)} /> : null}
      {blockOpen ? <BlockedTimeDialog mode="create" timeZone={timeZone} onClose={() => setBlockOpen(false)} /> : null}
    </div>
  );
}
