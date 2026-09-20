import { CheckCircle2, Circle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import {
  getBookingSettings,
  getBusinessHours,
  getBusinessProfile,
  getLeadIntakeToken,
  getNotificationSettings,
  getServiceAreas,
  getServices,
  withDefaultHours,
} from "@/lib/settings/queries";
import { resolveAppBaseUrl } from "@/lib/automation/sms";
import { getOrganizationSmsNumber } from "@/lib/settings/sms-routing";
import { computeSetupChecklist, ONBOARDING_STAGE_LABEL, type OnboardingStage } from "@/lib/onboarding/checklist";
import { ONBOARDING_STATUS_LABEL, type OnboardingStatus } from "@/lib/onboarding/readiness";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass } from "@/lib/ui/typography";
import { BusinessProfileSection } from "@/app/(app)/settings/_components/business-profile-section";
import { ServicesSection } from "@/app/(app)/settings/_components/services-section";
import { ServiceAreasSection } from "@/app/(app)/settings/_components/service-areas-section";
import { BusinessHoursSection } from "@/app/(app)/settings/_components/business-hours-section";
import { OperationsDetailSection } from "@/app/(app)/settings/_components/operations-detail-section";
import { BookingSettingsSection } from "@/app/(app)/settings/_components/booking-settings-section";
import { SmsSummarySection } from "@/app/(app)/settings/_components/sms-summary-section";
import { LeadCaptureSection } from "@/app/(app)/settings/_components/lead-capture-section";
import { NotificationSettingsSection } from "@/app/(app)/settings/_components/notification-settings-section";
import { ReputationSection } from "@/app/(app)/settings/_components/reputation-section";
import { AutomationModeSection } from "@/app/(app)/settings/_components/automation-mode-section";
import { TestLeadPanel } from "./test-lead-panel";

const STATUS_TONE: Record<OnboardingStatus, BadgeTone> = {
  setup: "neutral",
  blocked: "danger",
  testing: "warning",
  ready: "info",
  live: "success",
};

const STAGE_TONE: Record<OnboardingStage, BadgeTone> = {
  new: "neutral",
  configuring: "warning",
  testing: "info",
  ready: "info",
  live: "success",
};

function HubSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-slate-200 pt-8">
      <p className={sectionLabelClass}>{label}</p>
      <div className="mt-4 space-y-8">{children}</div>
    </div>
  );
}

/**
 * First Contractor Onboarding + Internal Client Setup System: the same
 * persistent hub First Client Onboarding V1 already built, now expanded
 * into the actual sale -> client information -> configuration -> test ->
 * verification -> go live workflow. Every field/section below reuses the
 * exact same Settings components and Server Actions unchanged (canEdit still
 * gates every form the same way) - this page is a guided, organized view
 * over the same data Settings edits, not a second, competing configuration
 * surface or a new set of form components. Sections are grouped to match
 * the contractor-facing structure (Business, Services, Operations,
 * Communications, Reputation) without any technical/implementation detail
 * ever surfacing here.
 */
export async function OnboardingHub({ organizationId, canEdit }: { organizationId: string; canEdit: boolean }) {
  const supabase = await createClient();

  const [profile, checklist, leadIntakeToken, services, serviceAreas, hoursRows, bookingSettings, notificationSettings, smsPhoneNumber] =
    await Promise.all([
      getBusinessProfile(supabase, organizationId),
      computeSetupChecklist(supabase, organizationId),
      getLeadIntakeToken(supabase, organizationId),
      getServices(supabase, organizationId),
      getServiceAreas(supabase, organizationId),
      getBusinessHours(supabase, organizationId),
      getBookingSettings(supabase, organizationId),
      getNotificationSettings(supabase, organizationId),
      getOrganizationSmsNumber(supabase, organizationId),
    ]);

  if (!profile) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">We couldn&apos;t load your business setup.</h1>
        <p className="text-sm text-slate-500">Please try again in a moment.</p>
      </div>
    );
  }

  const appBaseUrl = resolveAppBaseUrl();
  const leadIntakeUrl = appBaseUrl && leadIntakeToken ? `${appBaseUrl}/api/leads/capture/${leadIntakeToken}` : null;
  const { readiness, testLeadOutcome } = checklist;
  const hours = withDefaultHours(hoursRows);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <p className={`mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent`}>Getting started</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className={pageTitleClass}>{profile.name}</h1>
          <div className="flex items-center gap-2">
            <Badge tone={STAGE_TONE[checklist.stage]}>{ONBOARDING_STAGE_LABEL[checklist.stage]}</Badge>
            <Badge tone={STATUS_TONE[readiness.status]}>{ONBOARDING_STATUS_LABEL[readiness.status]}</Badge>
          </div>
        </div>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>
          {readiness.status === "live"
            ? "Your system is ready and live for real customers."
            : "Complete these items before going live. Nothing here can reach a real customer until you explicitly go live."}
        </p>
      </div>

      <section>
        <p className={sectionLabelClass}>Setup checklist</p>
        <ul className="mt-3 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {checklist.items.map((item) => (
            <li key={item.key} className="flex items-center gap-3 px-4 py-3">
              {item.complete ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <Circle className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
              )}
              <p className="text-sm font-medium text-slate-900">{item.label}</p>
            </li>
          ))}
        </ul>
      </section>

      <HubSection label="Business">
        <BusinessProfileSection profile={profile} canEdit={canEdit} />
        <ServiceAreasSection areas={serviceAreas} canEdit={canEdit} />
      </HubSection>

      <HubSection label="Services">
        <ServicesSection services={services} canEdit={canEdit} />
      </HubSection>

      <HubSection label="Operations">
        <BusinessHoursSection hours={hours} timezone={profile.timezone} canEdit={canEdit} />
        <OperationsDetailSection profile={profile} canEdit={canEdit} />
        <BookingSettingsSection settings={bookingSettings} canEdit={canEdit} />
      </HubSection>

      <HubSection label="Communications">
        <SmsSummarySection smsPhoneNumber={smsPhoneNumber} />
        <LeadCaptureSection intakeUrl={leadIntakeUrl} />
        <NotificationSettingsSection settings={notificationSettings} canEdit={canEdit} />
      </HubSection>

      <HubSection label="Reputation">
        <ReputationSection profile={profile} canEdit={canEdit} />
      </HubSection>

      <div className="border-t border-slate-200 pt-8">
        <TestLeadPanel outcome={testLeadOutcome} canEdit={canEdit} />
      </div>

      <div className="border-t border-slate-200 pt-8">
        <AutomationModeSection mode={readiness.automationMode} canEdit={canEdit} />
      </div>
    </div>
  );
}
