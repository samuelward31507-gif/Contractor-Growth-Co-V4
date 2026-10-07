import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
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
import { getOrganizationConnectStatus } from "@/lib/payments/connect";
import { refreshStaleConnectStatus } from "@/lib/payments/connect-backstop";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { onlinePaymentsBanner } from "@/lib/payments/online-payments-view";
import type { CalendarListItem } from "@/lib/calendar/provider";
import { sectionLabelClass } from "@/lib/ui/typography";
import { cardClass } from "@/lib/ui/surface";
import { PageHeader } from "@/lib/ui/page-header";
import { successBannerClass, errorBannerClass } from "@/lib/ui/form";
import { AiSettingsSection } from "./_components/ai-settings-section";
import { AutomationModeSection } from "./_components/automation-mode-section";
import { BookingSettingsSection } from "./_components/booking-settings-section";
import { CalendarConnectionSection } from "./_components/calendar-connection-section";
import { BusinessHoursSection } from "./_components/business-hours-section";
import { BusinessProfileSection } from "./_components/business-profile-section";
import { LeadCaptureSection } from "./_components/lead-capture-section";
import { NotificationSettingsSection } from "./_components/notification-settings-section";
import { OnlinePaymentsSection } from "./_components/online-payments-section";
import { OperationsDetailSection } from "./_components/operations-detail-section";
import { ReputationSection } from "./_components/reputation-section";
import { ServiceAreasSection } from "./_components/service-areas-section";
import { ServicesSection } from "./_components/services-section";
import { SmsSummarySection } from "./_components/sms-summary-section";
import { TeamSection } from "./_components/team-section";
import { getTeamMembers } from "@/lib/team/queries";
import { SettingsJumpNav } from "./_components/settings-jump-nav";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";

/** Usability audit fix (#7): a stable slug per group label, used both as the section's scroll anchor and the jump nav's href - derived from the same label passed to SettingsGroup, never a second source of truth for section names. */
function settingsGroupId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    // Final redesign: each group is one white card on the gray workspace,
    // its sections separated by hairlines - the same form sections, framed.
    <div id={settingsGroupId(label)} className="scroll-mt-6 pt-10 first:pt-0">
      <p className={sectionLabelClass}>{label}</p>
      <div className={`mt-3 divide-y divide-line ${cardClass} [&>*]:px-4 [&>*]:py-6 sm:[&>*]:px-6`}>{children}</div>
    </div>
  );
}

const SETTINGS_GROUP_LABELS = ["Business & Organization", "Automations", "Scheduling & Booking", "Communications & Notifications", "AI", "Reputation"];

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
  const paymentsBanner = onlinePaymentsBanner(params);

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  const canEdit = membership.role === "owner" || membership.role === "admin";
  const organizationId = membership.organizationId;

  // Performance Pass B: the calendar connection and the stored Stripe
  // Connect status are independent reads of this organization, so they now
  // run in the same batch as everything else instead of one after another
  // afterwards. What depends on them (the calendar list, the Stripe
  // backstop) still runs after, unchanged.
  const [profile, hoursRows, services, serviceAreas, aiSettings, bookingSettings, notificationSettings, smsPhoneNumber, automationMode, leadIntakeToken, calendarConnection, storedConnectStatus, team] =
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
      getCalendarConnection(supabase, organizationId),
      getOrganizationConnectStatus(supabase, organizationId),
      // Phase 3 (W3): the team - memberships via the caller's RLS, emails via Supabase Auth.
      getTeamMembers(supabase, createServiceRoleClient(), organizationId),
    ]);

  const appBaseUrl = resolveAppBaseUrl();
  const leadIntakeUrl = appBaseUrl && leadIntakeToken ? `${appBaseUrl}/api/leads/capture/${leadIntakeToken}` : null;

  // Only fetched (a real provider call) when there's actually a connection
  // with no calendar chosen yet - see calendar-connection-section.tsx's own
  // comment for why this isn't fetched unconditionally on every page load.
  let availableCalendars: CalendarListItem[] = [];
  if (calendarConnection && !calendarConnection.calendarId) {
    const listResult = await listConnectedCalendars(calendarConnection.id);
    if (listResult.ok) availableCalendars = listResult.value;
  }

  // Phase 1C: the stored Stripe Connect status (a plain read of the
  // organization row, loaded in the batch above; the start/return routes are
  // what re-read Stripe).
  // Backstop (owners/admins only): if the stored status is incomplete and
  // wasn't synced in the last minute, re-read it from Stripe (Accounts v2)
  // before rendering. Never creates an account or a link; keeps the stored
  // status if Stripe can't be reached. See lib/payments/connect-backstop.ts.
  const connectBackstop = canEdit
    ? await refreshStaleConnectStatus(createServiceRoleClient(), organizationId, storedConnectStatus)
    : { status: storedConnectStatus, refreshed: false, refreshFailed: false };

  if (!profile) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-ink">We couldn&apos;t load your business settings.</h1>
        <p className="text-sm text-ink-3">Please try again in a moment.</p>
      </div>
    );
  }

  const hours = withDefaultHours(hoursRows);

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <div>
        <PageHeader eyebrow="Workspace" title="Settings" description="Configure the business rules your automations use." />
        {!canEdit ? (
          <p className="mt-3 inline-flex items-center rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink-3">
            You have read-only access. Only owners and admins can change these settings.
          </p>
        ) : null}
        {calendarBannerMessage ? (
          <p className={`mt-3 ${calendarParam === "connected" ? successBannerClass : errorBannerClass}`} role={calendarParam === "connected" ? undefined : "alert"}>{calendarBannerMessage}</p>
        ) : null}
        {paymentsBanner ? (
          <p
            className={`mt-3 ${paymentsBanner.tone === "success" ? successBannerClass : paymentsBanner.tone === "error" ? errorBannerClass : "rounded-lg border border-info-border bg-info-muted px-3.5 py-2.5 text-sm text-info-text"}`}
            role={paymentsBanner.tone === "error" ? "alert" : undefined}
          >
            {paymentsBanner.message}
          </p>
        ) : null}
      </div>

      {/* Usability audit fix (#7): a sticky jump nav alongside the existing
          form on desktop - the grid collapses to the plain single-column
          form (unchanged) below `lg`, per the audit's own instruction to
          preserve the existing vertical form on mobile rather than add a
          second, compact mechanism. */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[180px_minmax(0,1fr)]">
        <SettingsJumpNav groups={SETTINGS_GROUP_LABELS.map((label) => ({ id: settingsGroupId(label), label }))} />

        <div className="min-w-0">
          <SettingsGroup label="Business & Organization">
            <BusinessProfileSection profile={profile} canEdit={canEdit} />
            <OnlinePaymentsSection status={connectBackstop.status} paymentStatus={membership.paymentStatus} canEdit={canEdit} refreshFailed={connectBackstop.refreshFailed} />
            <TeamSection members={team.members} currentUserId={user.id} canEdit={canEdit} failed={team.failed} />
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
            <LeadCaptureSection intakeUrl={leadIntakeUrl} canRotate={canEdit} />
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
    </div>
  );
}
