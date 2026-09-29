import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { AlertCircle } from "lucide-react";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import {
  filterAppointments,
  filterAppointmentsByView,
  getAppointmentsResult,
  summarizeAppointments,
  type AppointmentStatus,
  type AppointmentView,
} from "@/lib/appointments/queries";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { AddAppointmentButton } from "./_components/add-appointment-button";
import { AppointmentsEmptyState } from "./_components/appointments-empty-state";
import { AppointmentsList } from "./_components/appointments-list";
import { AppointmentsSummary } from "./_components/appointments-summary";
import { AppointmentsToolbar } from "./_components/appointments-toolbar";
import { ScheduleViewSwitcher } from "../schedule/_components/schedule-view-switcher";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

const VALID_STATUSES = new Set<string>(["scheduled", "confirmed", "completed", "cancelled", "no_show"]);
const VALID_VIEWS = new Set<string>(["upcoming", "today", "past"]);

function normalizeStatus(value: string | undefined): AppointmentStatus | "all" {
  return value && VALID_STATUSES.has(value) ? (value as AppointmentStatus) : "all";
}

function normalizeView(value: string | undefined): AppointmentView {
  return value && VALID_VIEWS.has(value) ? (value as AppointmentView) : "upcoming";
}

/**
 * Trackpr 2.0, Phase 3D: the header now reads "Schedule" with a "List view"
 * badge, rather than a standalone "Appointments" identity - the literal
 * /appointments URL permanently redirects to /schedule?view=list
 * (next.config.ts) before Next.js would ever resolve this file directly, so
 * this component is only ever rendered through the /schedule dispatcher now.
 * This shows the exact same appointments data as the Calendar grid view
 * (see calendar/page.tsx's own comment) - just a list presentation of it -
 * so both consistently read as "Schedule," with a plain link back to the
 * grid view.
 */
export default async function AppointmentsPage({ searchParams }: PageProps<"/appointments">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const status = normalizeStatus(typeof params.status === "string" ? params.status : undefined);
  const view = normalizeView(typeof params.view === "string" ? params.view : undefined);

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  const [appointmentsResult, contacts, leads, timeZone] = await Promise.all([
    getAppointmentsResult(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
    getOrganizationTimezone(supabase, membership.organizationId),
  ]);
  const allAppointments = appointmentsResult.data;

  const summary = summarizeAppointments(allAppointments);
  const inView = filterAppointmentsByView(allAppointments, view);
  const filtered = filterAppointments(inView, { query, status });
  const hasActiveFilters = Boolean(query.trim()) || status !== "all";

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      {/* Usability audit fix (#6): the old "List view" badge + plain
          "Calendar view" text link are gone - the same ScheduleViewSwitcher
          CalendarToolbar uses now sits here too, so Day/Week/Month/List
          reads as one consistent control on both presentations of Schedule
          rather than two different affordances for the same idea. */}
      <PageHeader
        title="Appointments"
        description="Every appointment in one list - upcoming, today and past."
        action={
          <div className="flex flex-wrap items-center gap-3">
            <ScheduleViewSwitcher active="list" hrefs={{ day: "/schedule?view=day", week: "/schedule?view=week", month: "/schedule?view=month", list: "/schedule?view=list" }} />
            <AddAppointmentButton contacts={contacts} leads={leads} />
          </div>
        }
      />

      {appointmentsResult.failed ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some information is temporarily unavailable. Please try again.</p>
        </div>
      ) : null}

      <AppointmentsSummary summary={summary} />

      {allAppointments.length === 0 ? (
        <AppointmentsEmptyState contacts={contacts} leads={leads} />
      ) : (
        <div className="border-t border-line pt-8">
          <AppointmentsToolbar initialQuery={query} initialStatus={status} view={view} todayCount={summary.today} />
          <div className="mt-5">
            <AppointmentsList
              appointments={filtered}
              view={view}
              hasActiveFilters={hasActiveFilters}
              timeZone={timeZone}
            />
          </div>
        </div>
      )}
    </div>
  );
}
