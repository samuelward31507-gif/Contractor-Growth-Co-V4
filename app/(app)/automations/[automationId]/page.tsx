import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Zap, Workflow, History } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { getAutomationDefinition } from "@/lib/automation/catalog";
import { getWorkflowNameStats, getRecentExecutionsForWorkflows, buildAutomationSummaries } from "@/lib/automation/queries";
import {
  getAutomationEnabledMap,
  getAutomationConfig,
  readAppointmentReminderConfig,
  readEstimateFollowupConfig,
  readInboundCustomerReplyConfig,
  readInstantLeadFollowupConfig,
  readLostLeadNurtureConfig,
  readLeadReactivationConfig,
  readAppointmentLifecycleConfig,
  readJobLifecycleConfig,
  readReviewReferralFollowupConfig,
} from "@/lib/automation/settings";
import { getBusinessHours } from "@/lib/settings/queries";
import { metaClass } from "@/lib/ui/typography";
import { PageHeader } from "@/lib/ui/page-header";
import { SectionCard } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge } from "@/lib/ui/badge";
import { errorBannerClass } from "@/lib/ui/form";
import { AUTOMATION_STATUS_BADGE, formatCount } from "../_components/format";
import { HowItWorks } from "../_components/how-it-works";
import { RecentExecutions } from "../_components/recent-executions";
import { ManualRunControls } from "../_components/manual-run-controls";
import { EnableToggle } from "../_components/enable-toggle";
import { AppointmentReminderConfigForm } from "../_components/appointment-reminder-config";
import { EstimateFollowupConfigForm } from "../_components/estimate-followup-config";
import { InboundCustomerReplyConfigForm } from "../_components/inbound-customer-reply-config";
import { InstantLeadFollowupConfigForm } from "../_components/instant-lead-followup-config";
import { LostLeadNurtureConfigForm } from "../_components/lost-lead-nurture-config";
import { LeadReactivationConfigForm } from "../_components/lead-reactivation-config";
import { AppointmentLifecycleConfigForm } from "../_components/appointment-lifecycle-config";
import { JobLifecycleConfigForm } from "../_components/job-lifecycle-config";
import { ReviewReferralFollowupConfigForm } from "../_components/review-referral-followup-config";
import { SAFE_RETRY_AUTOMATION_IDS } from "@/lib/automation/retry-eligibility";

const CONFIGURABLE_AUTOMATION_IDS = new Set([
  "appointment-reminders",
  "estimate-followup",
  "inbound-customer-reply",
  "instant-lead-followup",
  "lost-lead-nurture",
  "lead-reactivation",
  "appointment-lifecycle",
  "job-lifecycle",
  "review-referral-followup",
]);

/** Automations whose configuration includes a business-hours toggle (V2.2/V5) - used to decide whether to fetch business_hours at all. */
const BUSINESS_HOURS_AUTOMATION_IDS = new Set([
  "inbound-customer-reply",
  "instant-lead-followup",
  "appointment-lifecycle",
  "job-lifecycle",
  "review-referral-followup",
]);

/**
 * Detail view for one automation catalog entry. Reuses the same
 * organization-scoped, session-authenticated query layer as the list page -
 * no second authorization path, no service-role client. An unknown
 * automationId is a plain 404: catalog ids are static, non-secret slugs
 * (not org-specific identifiers), so there is nothing to protect by
 * distinguishing "doesn't exist" from anything else here.
 */
export default async function AutomationDetailPage({ params }: { params: Promise<{ automationId: string }> }) {
  const { automationId } = await params;

  const definition = getAutomationDefinition(automationId);
  if (!definition) {
    notFound();
  }

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

  // Manual run/dry run (Phase D) are only offered for the two
  // Trackpr-dispatched automations - see ManualRunControls's own comment.
  // This is a rendering-only signal; app/(app)/automations/actions.ts holds
  // its own independent, authoritative allowlist and re-validates it
  // server-side regardless of what this page renders.
  const supportsManualRun = definition.dispatch === "trackpr";

  // Phase G: org admin/owner only for the enable/disable toggle - a
  // rendering-only signal exactly like supportsManualRun above;
  // setAutomationEnabled re-verifies assertOrgAdmin() itself regardless.
  const canManage = membership.role === "owner" || membership.role === "admin";

  // Automation Configuration V1/V2.1/V2.2: only these four catalog
  // automations have any configurable value so far - see
  // lib/automation/settings.ts.
  const isConfigurable = CONFIGURABLE_AUTOMATION_IDS.has(definition.id);
  const needsBusinessHours = BUSINESS_HOURS_AUTOMATION_IDS.has(definition.id);

  const [statsByName, executions, enabledByAutomationId, rawConfig, businessHours] = await Promise.all([
    getWorkflowNameStats(supabase, membership.organizationId),
    getRecentExecutionsForWorkflows(supabase, membership.organizationId, definition.workflowNames),
    getAutomationEnabledMap(supabase, membership.organizationId),
    isConfigurable ? getAutomationConfig(supabase, membership.organizationId, definition.id) : Promise.resolve(null),
    needsBusinessHours ? getBusinessHours(supabase, membership.organizationId) : Promise.resolve([]),
  ]);

  const hasBusinessHoursConfigured = businessHours.length > 0;

  const summary = buildAutomationSummaries(statsByName, enabledByAutomationId).find((s) => s.definition.id === definition.id)!;
  const automationEnabled = summary.enabled;
  const Icon = definition.icon;
  const statusBadge = AUTOMATION_STATUS_BADGE[summary.status];

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <Link href="/automations" className="inline-flex items-center gap-1 rounded text-xs font-medium text-slate-500 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Automations
        </Link>

        <div className="mt-2 flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-900">
            <Icon className="h-4 w-4 text-white" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <PageHeader
              title={definition.name}
              description={definition.description}
              badge={
                <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
                  {statusBadge.label}
                </Badge>
              }
              action={
                canManage && definition.kind !== "safety-layer" ? <EnableToggle automationId={definition.id} enabled={automationEnabled} /> : undefined
              }
            />
          </div>
        </div>
      </div>

      {summary.failedExecutions > 0 ? (
        <div className={errorBannerClass}>
          <p className="font-medium">Attention</p>
          <p>
            {formatCount(summary.failedExecutions)} failed execution{summary.failedExecutions === 1 ? "" : "s"} in the last 30 days.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <SectionCard title="Trigger" icon={Zap} className="lg:col-span-1">
          <p className="text-sm text-slate-900">{definition.trigger}</p>
          {definition.eventTypes.length > 0 ? (
            <p className={`mt-3 ${metaClass}`}>
              Event type{definition.eventTypes.length === 1 ? "" : "s"}: {definition.eventTypes.join(", ")}
            </p>
          ) : null}
          {definition.workflowNames.length > 0 ? (
            <p className={metaClass}>
              Workflow{definition.workflowNames.length === 1 ? "" : "s"}: {definition.workflowNames.join(", ")}
            </p>
          ) : null}
          {supportsManualRun ? <ManualRunControls automationId={definition.id} enabled={automationEnabled} /> : null}
        </SectionCard>

        <SectionCard title="How it works" description="The real pipeline this automation runs, in order." icon={Workflow} className="lg:col-span-2">
          <HowItWorks steps={definition.steps} />
        </SectionCard>
      </div>

      {isConfigurable && canManage ? (
        <>
          {definition.id === "appointment-reminders" ? (
            <AppointmentReminderConfigForm initialLeadTimeHours={readAppointmentReminderConfig(rawConfig).reminder_lead_time_hours} />
          ) : definition.id === "estimate-followup" ? (
            <EstimateFollowupConfigForm
              initialFollowup1Hours={readEstimateFollowupConfig(rawConfig).followup_1_hours}
              initialFollowup2Hours={readEstimateFollowupConfig(rawConfig).followup_2_hours}
            />
          ) : definition.id === "inbound-customer-reply" ? (
            <InboundCustomerReplyConfigForm
              initialRecentMessageWindow={readInboundCustomerReplyConfig(rawConfig).recent_message_window}
              initialRespectBusinessHours={readInboundCustomerReplyConfig(rawConfig).respect_business_hours}
              hasBusinessHoursConfigured={hasBusinessHoursConfigured}
            />
          ) : definition.id === "instant-lead-followup" ? (
            <InstantLeadFollowupConfigForm
              initialRespectBusinessHours={readInstantLeadFollowupConfig(rawConfig).respect_business_hours}
              hasBusinessHoursConfigured={hasBusinessHoursConfigured}
            />
          ) : definition.id === "lost-lead-nurture" ? (
            <LostLeadNurtureConfigForm
              initialTouch1Days={readLostLeadNurtureConfig(rawConfig).touch_1_days}
              initialTouch2Days={readLostLeadNurtureConfig(rawConfig).touch_2_days}
            />
          ) : definition.id === "lead-reactivation" ? (
            <LeadReactivationConfigForm
              initialTouch1Days={readLeadReactivationConfig(rawConfig).touch_1_days}
              initialTouch2Days={readLeadReactivationConfig(rawConfig).touch_2_days}
            />
          ) : definition.id === "appointment-lifecycle" ? (
            <AppointmentLifecycleConfigForm
              initialRespectBusinessHours={readAppointmentLifecycleConfig(rawConfig).respect_business_hours}
              hasBusinessHoursConfigured={hasBusinessHoursConfigured}
            />
          ) : definition.id === "job-lifecycle" ? (
            <JobLifecycleConfigForm
              initialRespectBusinessHours={readJobLifecycleConfig(rawConfig).respect_business_hours}
              hasBusinessHoursConfigured={hasBusinessHoursConfigured}
            />
          ) : (
            <ReviewReferralFollowupConfigForm
              initialRespectBusinessHours={readReviewReferralFollowupConfig(rawConfig).respect_business_hours}
              hasBusinessHoursConfigured={hasBusinessHoursConfigured}
            />
          )}
        </>
      ) : null}

      <SectionCard title="Recent executions" icon={History}>
        {definition.workflowNames.length === 0 ? (
          <EmptyState
            icon={Icon}
            title="No execution log of its own"
            description="Safe AI Outbound has no dedicated workflow - its checks run inline as part of every other automation's execution."
          />
        ) : (
          <RecentExecutions executions={executions} retrySupported={SAFE_RETRY_AUTOMATION_IDS.has(definition.id)} />
        )}
      </SectionCard>
    </div>
  );
}
