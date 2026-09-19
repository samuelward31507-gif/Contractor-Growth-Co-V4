import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { getAutomationDefinition } from "@/lib/automation/catalog";
import { getWorkflowNameStats, getRecentExecutionsForWorkflows, buildAutomationSummaries } from "@/lib/automation/queries";
import { getAutomationEnabledMap } from "@/lib/automation/settings";
import { pageTitleClass, sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { AutomationStatusPill } from "../_components/status-pill";
import { HowItWorks } from "../_components/how-it-works";
import { RecentExecutions } from "../_components/recent-executions";
import { ManualRunControls } from "../_components/manual-run-controls";
import { EnableToggle } from "../_components/enable-toggle";
import { formatCount } from "../_components/format";
import { SAFE_RETRY_AUTOMATION_IDS } from "@/lib/automation/retry-eligibility";

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

  const [statsByName, executions, enabledByAutomationId] = await Promise.all([
    getWorkflowNameStats(supabase, membership.organizationId),
    getRecentExecutionsForWorkflows(supabase, membership.organizationId, definition.workflowNames),
    getAutomationEnabledMap(supabase, membership.organizationId),
  ]);

  const summary = buildAutomationSummaries(statsByName, enabledByAutomationId).find((s) => s.definition.id === definition.id)!;
  const automationEnabled = summary.enabled;
  const Icon = definition.icon;

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <Link href="/automations" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Automations
        </Link>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-900">
            <Icon className="h-4 w-4 text-white" aria-hidden />
          </span>
          <h1 className={pageTitleClass}>{definition.name}</h1>
          <AutomationStatusPill status={summary.status} />
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-slate-500">{definition.description}</p>
        {canManage && definition.kind !== "safety-layer" ? (
          <div className="mt-3">
            <EnableToggle automationId={definition.id} enabled={automationEnabled} />
          </div>
        ) : null}
      </div>

      {summary.failedExecutions > 0 ? (
        <div className="rounded-lg border border-red-100 bg-red-50/60 px-3.5 py-2.5 text-sm">
          <p className="font-medium text-red-800">Attention</p>
          <p className="text-red-700">
            {formatCount(summary.failedExecutions)} failed execution{summary.failedExecutions === 1 ? "" : "s"} in the last 30 days.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 lg:col-span-1">
          <p className={sectionLabelClass}>Trigger</p>
          <p className="mt-2 text-sm text-slate-900">{definition.trigger}</p>
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
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 lg:col-span-2">
          <p className={sectionLabelClass}>How it works</p>
          <div className="mt-3">
            <HowItWorks steps={definition.steps} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <p className={sectionLabelClass}>Recent executions</p>
        <div className="mt-3">
          {definition.workflowNames.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-6 text-center">
              <p className="text-sm font-medium text-slate-900">No execution log of its own</p>
              <p className="mt-0.5 text-xs text-slate-500">Safe AI Outbound has no dedicated workflow - its checks run inline as part of every other automation&apos;s execution.</p>
            </div>
          ) : (
            <RecentExecutions executions={executions} retrySupported={SAFE_RETRY_AUTOMATION_IDS.has(definition.id)} />
          )}
        </div>
      </div>
    </div>
  );
}
