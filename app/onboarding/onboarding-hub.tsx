import { CheckCircle2, Circle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getBusinessProfile, getLeadIntakeToken } from "@/lib/settings/queries";
import { resolveAppBaseUrl } from "@/lib/automation/sms";
import { computeOnboardingReadiness, getLatestTestLeadOutcome, ONBOARDING_STATUS_LABEL, type OnboardingStatus } from "@/lib/onboarding/readiness";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { LeadCaptureSection } from "@/app/(app)/settings/_components/lead-capture-section";
import { AutomationModeSection } from "@/app/(app)/settings/_components/automation-mode-section";
import { TestLeadPanel } from "./test-lead-panel";

const STATUS_TONE: Record<OnboardingStatus, BadgeTone> = {
  setup: "neutral",
  blocked: "danger",
  testing: "warning",
  ready: "info",
  live: "success",
};

/**
 * First Client Onboarding V1: the resumable Steps 2-7 hub. Deliberately
 * reuses LeadCaptureSection and AutomationModeSection unchanged from
 * app/(app)/settings rather than re-implementing them - this page is a
 * guided view over the exact same server-derived data and actions Settings
 * already uses, not a second, competing configuration surface. Business
 * hours/AI/SMS configuration themselves stay on Settings (their one real
 * home); this page links out to them rather than duplicating their forms.
 */
export async function OnboardingHub({ organizationId, canEdit }: { organizationId: string; canEdit: boolean }) {
  const supabase = await createClient();

  const [profile, readiness, leadIntakeToken, testLeadOutcome] = await Promise.all([
    getBusinessProfile(supabase, organizationId),
    computeOnboardingReadiness(supabase, organizationId),
    getLeadIntakeToken(supabase, organizationId),
    getLatestTestLeadOutcome(supabase, organizationId),
  ]);

  const appBaseUrl = resolveAppBaseUrl();
  const leadIntakeUrl = appBaseUrl && leadIntakeToken ? `${appBaseUrl}/api/leads/capture/${leadIntakeToken}` : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <p className={`mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent`}>Getting started</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className={pageTitleClass}>{profile?.name ?? "Your business"}</h1>
          <Badge tone={STATUS_TONE[readiness.status]}>{ONBOARDING_STATUS_LABEL[readiness.status]}</Badge>
        </div>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>
          {readiness.status === "live"
            ? "Your system is ready and live for real customers."
            : "Complete these items before going live. Nothing here can reach a real customer until you explicitly go live."}
        </p>
      </div>

      <section>
        <p className={sectionLabelClass}>Readiness checklist</p>
        <ul className="mt-3 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {readiness.items.map((item) => (
            <li key={item.key} className="flex items-start gap-3 px-4 py-3">
              {item.complete ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{item.label}</p>
                <p className={`mt-0.5 ${metaClass}`}>{item.detail}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className={`mt-2 ${metaClass}`}>
          Business information, business hours, and business phone number are managed on the{" "}
          <a href="/settings" className="font-medium text-slate-700 underline underline-offset-2">
            Settings
          </a>{" "}
          page.
        </p>
      </section>

      <div className="border-t border-slate-200 pt-8">
        <LeadCaptureSection intakeUrl={leadIntakeUrl} />
      </div>

      <div className="border-t border-slate-200 pt-8">
        <TestLeadPanel outcome={testLeadOutcome} canEdit={canEdit} />
      </div>

      <div className="border-t border-slate-200 pt-8">
        <AutomationModeSection mode={readiness.automationMode} canEdit={canEdit} />
      </div>
    </div>
  );
}
