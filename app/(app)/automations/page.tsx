import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { getWorkflowNameStats, buildAutomationSummaries, getRecentExecutionsForWorkflows } from "@/lib/automation/queries";
import { getAutomationEnabledMap } from "@/lib/automation/settings";
import { getOrganizationHealth, getAutomationHealthSummaries, getLatestHealthCheckRun, isHealthCheckStale } from "@/lib/automation-health/health";
import { listIncidents } from "@/lib/automation-health/queries";
import { getScheduledAutomationLiveness } from "@/lib/automation-health/scheduled-automation-liveness";
import { metaClass, sectionLabelClass } from "@/lib/ui/typography";
import { PageHeader } from "@/lib/ui/page-header";
import { Badge } from "@/lib/ui/badge";
import { HealthSummaryCards, HEALTH_STATUS_BADGE } from "./_components/health-summary-cards";
import { IncidentList } from "./_components/incident-list";
import { AutomationList } from "./_components/automation-list";
import { ScheduledLivenessList } from "./_components/scheduled-liveness-list";
import { AiAgents, getAiAgentWorkflowNames } from "./_components/ai-agents";
import { AiActivityFeed } from "./_components/ai-activity-feed";

/**
 * Trackpr 2.0 Phase 4: the Automation Control Center, consolidating what
 * used to be two separate routes (/automations and /automation-health) into
 * one - a contractor should never have had to know which of two pages
 * answered "is my automation working." /automation-health now redirects
 * here (see that route's own comment). Every incident/health read below is
 * the exact same lib/automation-health/* layer that route always used
 * (getOrganizationHealth, getAutomationHealthSummaries, listIncidents,
 * getLatestHealthCheckRun) - no second health calculation, nothing
 * recomputed.
 *
 * Organization-scoped, read-only for automation state (acknowledge/resolve
 * are owner/admin only - see health-actions.ts). Every query goes through
 * the caller's own session-authenticated Supabase client, exactly like every
 * other page under app/(app)/ - RLS is the only thing that ever restricts
 * which rows come back; no organization id is trusted from the client, and
 * this page never uses a service-role client.
 */
export default async function AutomationsPage() {
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

  const [statsByName, enabledByAutomationId, orgHealth, automationHealthSummaries, incidents, lastHealthCheck, scheduledLiveness] = await Promise.all([
    getWorkflowNameStats(supabase, membership.organizationId),
    getAutomationEnabledMap(supabase, membership.organizationId),
    getOrganizationHealth(supabase, membership.organizationId),
    getAutomationHealthSummaries(supabase, membership.organizationId),
    listIncidents(supabase, membership.organizationId, { status: ["open", "acknowledged"] }),
    getLatestHealthCheckRun(supabase),
    // Pass 5A: global, not organization-scoped - every organization's
    // /automations page shows the exact same 5 rows, since "did the n8n
    // Schedule Trigger call this route" is a platform-wide fact, not a
    // per-organization one (see the migration's own comment).
    getScheduledAutomationLiveness(supabase),
  ]);

  const summaries = buildAutomationSummaries(statsByName, enabledByAutomationId);
  const recentAiExecutions = await getRecentExecutionsForWorkflows(supabase, membership.organizationId, getAiAgentWorkflowNames(), 15);

  const activeAutomationCount = summaries.filter((s) => s.status === "active").length;
  const healthByAutomationId = new Map(automationHealthSummaries.map((s) => [s.automationId, s]));
  const statusBadge = HEALTH_STATUS_BADGE[orgHealth.status];

  // SCHED-01 (pre-launch lead-leak audit): a passive, read-time staleness
  // check computed on page load - not a new cron or monitoring platform -
  // using the same heartbeat table this page already reads. See
  // isHealthCheckStale's own doc comment for the full reasoning.
  const healthCheckIsStale = isHealthCheckStale(lastHealthCheck?.checkedAt ?? null);

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Automate"
        title="Automations"
        description="What's running, whether it's healthy, and the controls to manage it - all in one place."
        badge={
          <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
            {statusBadge.label}
          </Badge>
        }
      />

      <div className="flex flex-col gap-2">
        <p className={sectionLabelClass}>Overview</p>
        <HealthSummaryCards health={orgHealth} activeAutomationCount={activeAutomationCount} />
        <p className={metaClass}>
          {lastHealthCheck
            ? `Activity reflects the last 30 days. Last automated health check: ${new Date(lastHealthCheck.checkedAt).toLocaleString()} (${lastHealthCheck.stuckCount} stuck execution${lastHealthCheck.stuckCount === 1 ? "" : "s"} found).`
            : "Activity reflects the last 30 days. No automated health check has run yet."}
        </p>
        {healthCheckIsStale ? (
          <Badge tone="warning">Automated health checks appear to have stopped - the scheduler may be down</Badge>
        ) : null}
      </div>

      <AiAgents summaries={summaries} />

      <div className="flex flex-col gap-2">
        <p className={sectionLabelClass}>Scheduled automation liveness</p>
        <ScheduledLivenessList liveness={scheduledLiveness} />
      </div>

      <IncidentList incidents={incidents} />

      <div className="flex flex-col gap-2">
        <p className={sectionLabelClass}>Recent AI activity</p>
        <AiActivityFeed executions={recentAiExecutions} />
      </div>

      <div className="flex flex-col gap-2">
        <p className={sectionLabelClass}>All automations</p>
        <AutomationList summaries={summaries} healthByAutomationId={healthByAutomationId} />
      </div>
    </div>
  );
}
