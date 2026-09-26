import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import {
  filterAppointments,
  filterAppointmentsByView,
  getAppointments,
  summarizeAppointments,
  type AppointmentStatus,
  type AppointmentView,
} from "@/lib/appointments/queries";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import Link from "next/link";
import { PageHeader } from "@/lib/ui/page-header";
import { AddAppointmentButton } from "./_components/add-appointment-button";
import { AppointmentsEmptyState } from "./_components/appointments-empty-state";
import { AppointmentsList } from "./_components/appointments-list";
import { AppointmentsSummary } from "./_components/appointments-summary";
import { AppointmentsToolbar } from "./_components/appointments-toolbar";

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

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getUserOrganization(supabase, user.id);
  if (!membership) {
    redirect("/onboarding");
  }

  const [allAppointments, contacts, leads, timeZone] = await Promise.all([
    getAppointments(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
    getOrganizationTimezone(supabase, membership.organizationId),
  ]);

  const summary = summarizeAppointments(allAppointments);
  const inView = filterAppointmentsByView(allAppointments, view);
  const filtered = filterAppointments(inView, { query, status });
  const hasActiveFilters = Boolean(query.trim()) || status !== "all";

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Operate"
        title="Schedule"
        description="Keep every customer appointment organized and on schedule."
        badge={<span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">List view</span>}
        action={
          <div className="flex items-center gap-4">
            <Link
              href="/schedule"
              className="rounded text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Calendar view
            </Link>
            <AddAppointmentButton contacts={contacts} leads={leads} />
          </div>
        }
      />

      <AppointmentsSummary summary={summary} />

      {allAppointments.length === 0 ? (
        <AppointmentsEmptyState contacts={contacts} leads={leads} />
      ) : (
        <div className="border-t border-slate-200 pt-8">
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
