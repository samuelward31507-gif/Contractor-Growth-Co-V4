import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { segmentedItemClass, segmentedTrackClass } from "@/lib/ui/segmented";
import { secondaryButtonAutoClass } from "@/lib/ui/form";
import { getFounderCalendarItems, getFounderDeals } from "@/lib/founder/queries";
import { CALENDAR_VIEWS, calendarHref, calendarRange, calendarTitle, parseCalendarParams, placeItems, shiftAnchor } from "@/lib/founder/calendar";
import { toDealOptions } from "@/lib/founder/model";
import { requireFounderPage, LoadFailed } from "../_components/page-parts";
import { AddItemButton } from "../_components/add-item-button";
import { CalendarView, type DayEntry } from "../_components/calendar-view";

const VIEW_LABELS = { month: "Month", week: "Week", day: "Day" } as const;
const NAV_BUTTON = "inline-flex h-9 w-9 items-center justify-center rounded-md border border-line bg-surface text-ink-2 hover:bg-inset hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/**
 * The founder's calendar: month, week and day views of founder_items in the
 * founder's own time zone, with an Unscheduled list so undated tasks are
 * never hidden. Navigation is plain links (?view=&date=), so every view is
 * bookmarkable and works without client state.
 */
export default async function FounderCalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { supabase, userId, timeZone, now, todayKey } = await requireFounderPage();
  const { view, anchor } = parseCalendarParams({ view: params.view, date: params.date }, todayKey);
  const range = calendarRange(view, anchor, timeZone);

  const [itemsResult, dealsResult] = await Promise.all([getFounderCalendarItems(supabase, userId, range.start, range.end), getFounderDeals(supabase, userId)]);
  const deals = dealsResult.ok ? toDealOptions(dealsResult.data) : [];
  const placed = itemsResult.ok ? placeItems(itemsResult.data.inRange, range.days, timeZone) : new Map();
  const entriesByDay: Record<string, DayEntry[]> = {};
  for (const [day, entries] of placed) entriesByDay[day] = entries.map((e: { item: { id: string }; allDay: boolean; continued: boolean }) => ({ id: e.item.id, allDay: e.allDay, continued: e.continued }));
  const itemCount = itemsResult.ok ? itemsResult.data.inRange.length : 0;
  // ?item= opens that item's details (where a recommendation links). Only an id
  // among the founder's own loaded items is honoured; anything else is ignored.
  const requestedItem = typeof params.item === "string" ? params.item : null;
  const openItemId = itemsResult.ok && requestedItem && [...itemsResult.data.inRange, ...itemsResult.data.unscheduled].some((item) => item.id === requestedItem) ? requestedItem : null;

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader eyebrow="Founder" title="Calendar" description={`Meetings, events, tasks, deadlines and follow-ups · ${timeZone.replace(/_/g, " ")}`} action={<AddItemButton label="New item" defaultKind="meeting" deals={deals} timeZone={timeZone} />} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Link href={calendarHref(view, shiftAnchor(view, anchor, -1))} aria-label={`Previous ${view}`} className={NAV_BUTTON}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Link>
          <Link href={calendarHref(view, todayKey)} className={secondaryButtonAutoClass} aria-current={range.days.includes(todayKey) ? "date" : undefined}>
            Today
          </Link>
          <Link href={calendarHref(view, shiftAnchor(view, anchor, 1))} aria-label={`Next ${view}`} className={NAV_BUTTON}>
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
          <h2 className="ml-1 text-base font-semibold text-ink sm:text-lg" aria-live="polite">
            {calendarTitle(range)}
          </h2>
        </div>
        <nav aria-label="Calendar view" className={segmentedTrackClass}>
          {CALENDAR_VIEWS.map((v) => (
            <Link key={v} href={calendarHref(v, anchor)} aria-current={v === view ? "page" : undefined} className={segmentedItemClass(v === view)}>
              {VIEW_LABELS[v]}
            </Link>
          ))}
        </nav>
      </div>

      {!itemsResult.ok ? (
        <LoadFailed what="Your calendar" />
      ) : (
        <>
          {!dealsResult.ok ? <LoadFailed what="Your deals (for linking)" /> : null}
          {itemCount === 0 && itemsResult.data.unscheduled.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing on the calendar for this {view} yet. Use New item, or the + on any day.</p>
          ) : null}
          <CalendarView
            key={openItemId ?? "calendar"}
            view={view}
            anchor={anchor}
            days={range.days}
            todayKey={todayKey}
            entriesByDay={entriesByDay}
            items={itemsResult.data.inRange}
            unscheduled={itemsResult.data.unscheduled}
            deals={deals}
            timeZone={timeZone}
            nowIso={now.toISOString()}
            initialItemId={openItemId}
          />
        </>
      )}
    </div>
  );
}
