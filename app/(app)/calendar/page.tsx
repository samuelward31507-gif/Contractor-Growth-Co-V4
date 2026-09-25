import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { getAppointmentsInRange } from "@/lib/appointments/queries";
import { getBlockedTimeInRange } from "@/lib/scheduling/blocked-time";
import { getOrganizationTimezone, getBusinessHours, getBookingSettings } from "@/lib/settings/queries";
import { PageHeader } from "@/lib/ui/page-header";
import {
  parseDateOnly,
  formatDateOnly,
  localDateParts,
  getDayRange,
  getWeekRange,
  getWeekStart,
  getMonthGrid,
  navigateDate,
  addDays,
  buildCalendarHref,
  type CalendarView,
  type DateParts,
} from "./_lib/date-range";
import { getGridBounds, localMinutesSinceMidnight } from "./_lib/grid";
import { CalendarToolbar } from "./_components/calendar-toolbar";
import { CalendarGrid } from "./_components/calendar-grid";
import { MonthView } from "./_components/month-view";

const VALID_VIEWS = new Set<string>(["day", "week", "month"]);

function normalizeView(value: string | undefined): CalendarView {
  return value && VALID_VIEWS.has(value) ? (value as CalendarView) : "week";
}

/** Renders a plain calendar date/range label - always via "UTC" against Y/M/D parts (never the org's real timeZone), since these are plain calendar dates being labeled, not instants being displayed; the actual instant-to-local-time conversions for appointment times happen elsewhere (lib/appointments/format.ts), always with the real organization timezone. */
function formatRangeLabel(view: CalendarView, parts: ReturnType<typeof parseDateOnly>): string {
  if (!parts) return "";
  const asDate = (p: NonNullable<typeof parts>) => new Date(Date.UTC(p.year, p.month - 1, p.day, 12));

  if (view === "day") {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(asDate(parts));
  }
  if (view === "month") {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(asDate(parts));
  }
  const weekStart = getWeekStart(parts);
  const weekEnd = addDays(weekStart, 6);
  const startLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(asDate(weekStart));
  const endLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(asDate(weekEnd));
  return `${startLabel} – ${endLabel}`;
}

/**
 * Pass 2 (Native Calendar System): the native Trackpr calendar - the
 * contractor's operational scheduling system. Server-fetches real
 * appointments/blocked time for exactly the requested view's date range
 * (never the full org - getAppointmentsInRange/getBlockedTimeInRange are
 * both range-scoped, see their own comments) and renders the Day/Week grid
 * or the Month summary view. All availability/conflict logic still lives in
 * lib/scheduling/availability.ts and the appointments Server Actions - this
 * page and its components only display real data and dispatch to those
 * existing, authoritative primitives; it never computes availability or
 * conflicts itself.
 */
export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  const params = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) redirect("/onboarding");

  const organizationId = membership.organizationId;
  const timeZone = (await getOrganizationTimezone(supabase, organizationId)) ?? "UTC";

  const view = normalizeView(typeof params.view === "string" ? params.view : undefined);
  const requestedDate = typeof params.date === "string" ? parseDateOnly(params.date) : null;
  const todayParts = localDateParts(new Date(), timeZone);
  const activeParts = requestedDate ?? todayParts;
  const todayKey = formatDateOnly(todayParts);

  const [businessHours, bookingSettings, contacts, leads] = await Promise.all([
    getBusinessHours(supabase, organizationId),
    getBookingSettings(supabase, organizationId),
    getContacts(supabase, organizationId),
    getLeads(supabase, organizationId),
  ]);

  let dataRangeStart: Date;
  let dataRangeEnd: Date;
  let days: DateParts[];
  let monthGrid: ReturnType<typeof getMonthGrid> | null = null;

  if (view === "day") {
    const range = getDayRange(activeParts, timeZone);
    dataRangeStart = range.start;
    dataRangeEnd = range.end;
    days = [activeParts];
  } else if (view === "week") {
    const range = getWeekRange(activeParts, timeZone);
    dataRangeStart = range.start;
    dataRangeEnd = range.end;
    const weekStart = getWeekStart(activeParts);
    days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  } else {
    monthGrid = getMonthGrid(activeParts, timeZone);
    dataRangeStart = monthGrid.gridRange.start;
    dataRangeEnd = monthGrid.gridRange.end;
    days = [];
  }

  const [appointments, blockedTime] = await Promise.all([
    getAppointmentsInRange(supabase, organizationId, dataRangeStart, dataRangeEnd),
    getBlockedTimeInRange(supabase, organizationId, dataRangeStart, dataRangeEnd),
  ]);

  const prevParts = navigateDate(activeParts, view, -1);
  const nextParts = navigateDate(activeParts, view, 1);

  const extraMinutes = [...appointments, ...blockedTime].map((item) => localMinutesSinceMidnight(item.start_at, timeZone));
  const bounds = getGridBounds(businessHours, extraMinutes);

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Operate"
        title="Calendar"
        description="Your real-time scheduling command center - appointments, availability, and blocked time in one place."
      />

      <CalendarToolbar
        view={view}
        label={formatRangeLabel(view, activeParts)}
        prevHref={buildCalendarHref(view, formatDateOnly(prevParts))}
        nextHref={buildCalendarHref(view, formatDateOnly(nextParts))}
        todayHref={buildCalendarHref(view, todayKey)}
        activeDateStr={formatDateOnly(activeParts)}
        contacts={contacts}
        leads={leads}
        timeZone={timeZone}
      />

      {view === "month" && monthGrid ? (
        <MonthView
          gridDays={monthGrid.gridDays}
          currentMonth={activeParts.month}
          appointments={appointments}
          blockedTime={blockedTime}
          timeZone={timeZone}
          todayKey={todayKey}
        />
      ) : (
        <CalendarGrid
          days={days}
          bounds={bounds}
          appointments={appointments}
          blockedTime={blockedTime}
          contacts={contacts}
          leads={leads}
          timeZone={timeZone}
          defaultDurationMinutes={bookingSettings.default_duration_minutes || 60}
          todayKey={todayKey}
        />
      )}
    </div>
  );
}
