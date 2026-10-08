import CalendarPage from "../calendar/page";
import AppointmentsPage from "../appointments/page";
import { ScheduleAgendaPage } from "./_components/agenda-page";

/**
 * Trackpr 2.0, Phase 0: the smallest safe migration target for the locked
 * Schedule destination (/calendar + /appointments -> /schedule). Not the
 * final Schedule UI (day/week/month/list as one real, unified surface) -
 * that is Phase 4's job (Master Product Specification Part 10/26).
 *
 * Dispatches, unchanged, to the real CalendarPage or AppointmentsPage
 * component based on the incoming `view` query parameter, using the
 * FUTURE Trackpr 2.0 vocabulary (day/week/month/list) as the selector:
 * `list` (or the calendar-incompatible values already normalized away by
 * CalendarPage itself) goes to the real, unmodified Appointments list;
 * day/week/month (or a bare `date`) goes to the real, unmodified Calendar
 * grid, which already natively supports exactly those three values. Batch
 * 3: no view at all is the agenda (ScheduleAgendaPage).
 *
 * `apptView` (renamed from Appointments' own `view` param by
 * next.config.ts's redirect rules, to avoid colliding with this page's own
 * `view` selector - see that file's own header comment) is read back out
 * here and forwarded to AppointmentsPage under ITS expected `view` key
 * (upcoming/today/past) - the one place this file does more than a bare
 * dispatch, and still zero new business logic: it only reshapes a query
 * key name before handing off to the real, unchanged component.
 */
export default async function SchedulePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await props.searchParams;
  const view = typeof params.view === "string" ? params.view : undefined;

  if (view === "list") {
    const { from, view: _discardScheduleView, apptView, ...rest } = params;
    void from;
    void _discardScheduleView;
    const appointmentsSearchParams: Record<string, string | string[] | undefined> = { ...rest };
    if (typeof apptView === "string") {
      appointmentsSearchParams.view = apptView;
    }
    return AppointmentsPage({ searchParams: Promise.resolve(appointmentsSearchParams) } as Parameters<typeof AppointmentsPage>[0]);
  }

  // Batch 3 (core daily loop): no view at all is the agenda - today and
  // next. A calendar view (day/week/month), or a bare `date` deep link
  // (/calendar?date=... redirects here), still opens the calendar grid.
  if (view === undefined && typeof params.date !== "string") {
    return ScheduleAgendaPage();
  }

  return CalendarPage(props as Parameters<typeof CalendarPage>[0]);
}
