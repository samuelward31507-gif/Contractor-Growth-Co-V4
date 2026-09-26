import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import {
  getAiSettings,
  getAutomationMode,
  getBookingSettings,
  getBusinessHours,
  getBusinessProfile,
  getLeadIntakeToken,
  getNotificationSettings,
  getServiceAreas,
  getServices,
  withDefaultHours,
} from "@/lib/settings/queries";
import { getOrganizationSmsNumber } from "@/lib/settings/sms-routing";
import { resolveAppBaseUrl } from "@/lib/automation/sms";
import { getCalendarConnection, listConnectedCalendars } from "@/lib/calendar/connection";
import type { CalendarListItem } from "@/lib/calendar/provider";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass } from "@/lib/ui/typography";
import { successBannerClass, errorBannerClass } from "@/lib/ui/form";
import { AiSettingsSection } from "./_components/ai-settings-section";
import { AutomationModeSection } from "./_components/automation-mode-section";
import { BookingSettingsSection } from "./_components/booking-settings-section";
import { CalendarConnectionSection } from "./_components/calendar-connection-section";
import { BusinessHoursSection } from "./_components/business-hours-section";
import { BusinessProfileSection } from "./_components/business-profile-section";
import { LeadCaptureSection } from "./_components/lead-capture-section";
import { NotificationSettingsSection } from "./_components/notification-settings-section";
import { OperationsDetailSection } from "./_components/operations-detail-section";
import { ReputationSection } from "./_components/reputation-section";
import { ServiceAreasSection } from "./_components/service-areas-section";
import { ServicesSection } from "./_components/services-section";
import { SmsSummarySection } from "./_components/sms-summary-section";

function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-slate-200 pt-8 first:border-t-0 first:pt-0">
      <p className={sectionLabelClass}>{label}</p>
      <div className="mt-5 space-y-10">{children}</div>
    </div>
  );
}

const CALENDAR_STATUS_MESSAGE: Record<string, string> = {
  connected: "Google Calendar connected.",
  invalid_state: "That connection attempt couldn't be verified. Please try connecting again.",
  not_authorized: "Only owners and admins can connect a calendar.",
  access_denied: "Google Calendar access was not granted.",
  exchange_failed: "We couldn't complete the connection to Google Calendar. Please try again.",
  storage_failed: "We couldn't save the calendar connection. Please try again.",
};

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const calendarParam = typeof params.calendar === "string" ? params.calendar : null;
  const calendarReason = typeof params.reason === "string" ? params.reason : null;
  const calendarBannerMessage = calendarParam === "connected" ? CALENDAR_STATUS_MESSAGE.connected : calendarParam === "error" ? (calendarReason && CALENDAR_STATUS_MESSAGE[calendarReason]) || "We couldn't connect Google Calendar. Please try again." : null;

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

  const canEdit = membership.role === "owner" || membership.role === "admin";
  const organizationId = membership.organizationId;

  const [profile, hoursRows, services, serviceAreas, aiSettings, bookingSettings, notificationSettings, smsPhoneNumber, automationMode, leadIntakeToken] =
    await Promise.all([
      getBusinessProfile(supabase, organizationId),
      getBusinessHours(supabase, organizationId),
      getServices(supabase, organizationId),
      getServiceAreas(supabase, organizationId),
      getAiSettings(supabase, organizationId),
      getBookingSettings(supabase, organizationId),
      getNotificationSettings(supabase, organizationId),
      getOrganizationSmsNumber(supabase, organizationId),
      getAutomationMode(supabase, organizationId),
      getLeadIntakeToken(supabase, organizationId),
    ]);

  const appBaseUrl = resolveAppBaseUrl();
  const leadIntakeUrl = appBaseUrl && leadIntakeToken ? `${appBaseUrl}/api/leads/capture/${leadIntakeToken}` : null;

  // Only fetched (a real provider call) when there's actually a connection
  // with no calendar chosen yet - see calendar-connection-section.tsx's own
  // comment for why this isn't fetched unconditionally on every page load.
  const calendarConnection = await getCalendarConnection(supabase, organizationId);
  let availableCalendars: CalendarListItem[] = [];
  if (calendarConnection && !calendarConnection.calendarId) {
    const listResult = await listConnectedCalendars(calendarConnection.id);
    if (listResult.ok) availableCalendars = listResult.value;
  }

  if (!profile) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">We couldn&apos;t load your business settings.</h1>
        <p className="text-sm text-slate-500">Please try again in a moment.</p>
      </div>
    );
  }

  const hours = withDefaultHours(hoursRows);

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">System</p>
        <h1 className={pageTitleClass}>Settings</h1>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>
          Configure the business rules your automations use.
        </p>
        {!canEdit ? (
          <p className="mt-3 inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-500">
            You have read-only access. Only owners and admins can change these settings.
          </p>
        ) : null}
        {calendarBannerMessage ? (
          <p className={`mt-3 ${calendarParam === "connected" ? successBannerClass : errorBannerClass}`}>{calendarBannerMessage}</p>
        ) : null}
      </div>

      <div>
        <SettingsGroup label="Business & Organization">
          <BusinessProfileSection profile={profile} canEdit={canEdit} />
        </SettingsGroup>

        <SettingsGroup label="Automations">
          <AutomationModeSection mode={automationMode} canEdit={canEdit} />
        </SettingsGroup>

        <SettingsGroup label="Scheduling & Booking">
          <BusinessHoursSection hours={hours} timezone={profile.timezone} canEdit={canEdit} />
          <ServicesSection services={services} canEdit={canEdit} />
          <ServiceAreasSection areas={serviceAreas} canEdit={canEdit} />
          <BookingSettingsSection settings={bookingSettings} canEdit={canEdit} />
          <CalendarConnectionSection connection={calendarConnection} availableCalendars={availableCalendars} canEdit={canEdit} />
          <OperationsDetailSection profile={profile} canEdit={canEdit} />
        </SettingsGroup>

        <SettingsGroup label="Communications & Notifications">
          <SmsSummarySection smsPhoneNumber={smsPhoneNumber} />
          <LeadCaptureSection intakeUrl={leadIntakeUrl} />
          <NotificationSettingsSection settings={notificationSettings} canEdit={canEdit} />
        </SettingsGroup>

        <SettingsGroup label="AI">
          <AiSettingsSection settings={aiSettings} canEdit={canEdit} />
        </SettingsGroup>

        <SettingsGroup label="Reputation">
          <ReputationSection profile={profile} canEdit={canEdit} />
        </SettingsGroup>
      </div>
    </div>
  );
}
