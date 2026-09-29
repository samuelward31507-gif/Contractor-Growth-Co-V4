import Link from "next/link";

export type ScheduleViewOption = "day" | "week" | "month" | "list";

const OPTIONS: { value: ScheduleViewOption; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "list", label: "List" },
];

/**
 * Usability audit fix (#6, Schedule segmented view control): a single shared
 * presentational control used by both CalendarPage (app/(app)/calendar,
 * rendered through /schedule) and AppointmentsPage (app/(app)/appointments,
 * rendered through /schedule?view=list) so Day/Week/Month/List reads as one
 * cohesive view switcher instead of "List view" being a plain text link that
 * feels like leaving the page while Day/Week/Month feel like view controls.
 * No new calendar architecture: every href is supplied by the caller, built
 * from the exact same route/query state each page already computes
 * (buildCalendarHref for Day/Week/Month, the existing /schedule?view=list
 * destination for List) - this component only renders the four already-real
 * destinations as one visually consistent segmented control. Plain <Link>s,
 * no client state of its own, so it renders identically whether imported
 * into a Server Component (AppointmentsPage) or a Client Component
 * (CalendarToolbar).
 */
export function ScheduleViewSwitcher({ active, hrefs }: { active: ScheduleViewOption; hrefs: Record<ScheduleViewOption, string> }) {
  return (
    <div className="inline-flex gap-0.5 rounded-md bg-inset p-0.5" role="group" aria-label="Schedule view">
      {OPTIONS.map((item) => (
        <Link
          key={item.value}
          href={hrefs[item.value]}
          aria-pressed={active === item.value}
          // Trackpr 2.0 (step 2G): the same segmented control as the
          // Dashboard's Priority / By type switch - 44px on touch.
          className={`inline-flex min-h-11 items-center rounded-[5px] px-3 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-7 ${
            active === item.value ? "bg-surface text-ink shadow-[0_1px_2px_rgba(23,25,26,0.08)]" : "text-ink-3 hover:text-ink"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}
