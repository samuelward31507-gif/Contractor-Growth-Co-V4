import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import {
  getAiSettings,
  getBookingSettings,
  getBusinessHours,
  getBusinessProfile,
  getNotificationSettings,
  getServiceAreas,
  getServices,
  withDefaultHours,
} from "@/lib/settings/queries";
import { AiSettingsSection } from "./_components/ai-settings-section";
import { BookingSettingsSection } from "./_components/booking-settings-section";
import { BusinessHoursSection } from "./_components/business-hours-section";
import { BusinessProfileSection } from "./_components/business-profile-section";
import { NotificationSettingsSection } from "./_components/notification-settings-section";
import { ServiceAreasSection } from "./_components/service-areas-section";
import { ServicesSection } from "./_components/services-section";

export default async function SettingsPage() {
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

  const [profile, hoursRows, services, serviceAreas, aiSettings, bookingSettings, notificationSettings] =
    await Promise.all([
      getBusinessProfile(supabase, organizationId),
      getBusinessHours(supabase, organizationId),
      getServices(supabase, organizationId),
      getServiceAreas(supabase, organizationId),
      getAiSettings(supabase, organizationId),
      getBookingSettings(supabase, organizationId),
      getNotificationSettings(supabase, organizationId),
    ]);

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
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Configure the business rules Trackpr and future automation will use.
        </p>
        {!canEdit ? (
          <p className="mt-3 inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-500">
            You have read-only access. Only owners and admins can change these settings.
          </p>
        ) : null}
      </div>

      <BusinessProfileSection profile={profile} canEdit={canEdit} />
      <BusinessHoursSection hours={hours} timezone={profile.timezone} canEdit={canEdit} />
      <ServicesSection services={services} canEdit={canEdit} />
      <ServiceAreasSection areas={serviceAreas} canEdit={canEdit} />
      <AiSettingsSection settings={aiSettings} canEdit={canEdit} />
      <BookingSettingsSection settings={bookingSettings} canEdit={canEdit} />
      <NotificationSettingsSection settings={notificationSettings} canEdit={canEdit} />
    </div>
  );
}
