import { redirect } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { getContacts } from "@/lib/contacts/queries";
import { getLeads } from "@/lib/leads/queries";
import { getAppointmentsResult } from "@/lib/appointments/queries";
import { buildAgenda } from "@/lib/appointments/agenda";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { AddAppointmentButton } from "../../appointments/_components/add-appointment-button";
import { ScheduleViewSwitcher } from "./schedule-view-switcher";
import { ScheduleAgenda } from "./schedule-agenda";

/**
 * Batch 3 (core daily loop): Schedule's default view - "what's happening
 * today and next?" - from the same appointments read the list view makes
 * (getAppointmentsResult), arranged by lib/appointments/agenda.ts. The
 * calendar grids and the full list are one tap away in the view switcher.
 */
export async function ScheduleAgendaPage() {
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
  const agenda = buildAgenda(appointmentsResult.data, new Date(), timeZone);
  const addButton = <AddAppointmentButton contacts={contacts} leads={leads} />;

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader
        eyebrow="Schedule"
        title="Schedule"
        description="What's happening today, and what's next."
        action={
          <div className="flex flex-wrap items-center gap-3">
            <ScheduleViewSwitcher active="agenda" hrefs={{ agenda: "/schedule", day: "/schedule?view=day", week: "/schedule?view=week", month: "/schedule?view=month", list: "/schedule?view=list" }} />
            {addButton}
          </div>
        }
      />

      {appointmentsResult.failed ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some information is temporarily unavailable. Please try again.</p>
        </div>
      ) : null}

      <ScheduleAgenda agenda={agenda} timeZone={timeZone} emptyAction={addButton} />
    </div>
  );
}
