import Link from "next/link";
import { segmentedItemClass, segmentedTrackClass } from "@/lib/ui/segmented";

export type ScheduleViewOption = "agenda" | "day" | "week" | "month" | "list";

// Batch 3: Agenda (today and next) is Schedule's default; the calendar grids and the full list stay one tap away.
const OPTIONS: { value: ScheduleViewOption; label: string }[] = [
  { value: "agenda", label: "Agenda" },
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
    <div className={segmentedTrackClass} role="group" aria-label="Schedule view">
      {OPTIONS.map((item) => (
        <Link
          key={item.value}
          href={hrefs[item.value]}
          aria-pressed={active === item.value}
          // Trackpr 2.0 (step 2G): the same segmented control as the
          // Dashboard's Priority / By type switch - 44px on touch.
          className={segmentedItemClass(active === item.value)}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}
