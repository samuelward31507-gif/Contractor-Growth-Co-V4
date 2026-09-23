import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { getAutomationOverview, getWorkflowNameStats, buildAutomationSummaries, getRecentExecutionsForWorkflows } from "@/lib/automation/queries";
import { getAutomationEnabledMap } from "@/lib/automation/settings";
import { metaClass, sectionLabelClass } from "@/lib/ui/typography";
import { PageHeader } from "@/lib/ui/page-header";
import { SummaryCards } from "./_components/summary-cards";
import { AutomationList } from "./_components/automation-list";
import { AiAgents, getAiAgentWorkflowNames } from "./_components/ai-agents";
import { AiActivityFeed } from "./_components/ai-activity-feed";

/**
 * Automation Control Center - organization-scoped, read-only for v1. Every
 * query here goes through the caller's own session-authenticated Supabase
 * client, exactly like every other page under app/(app)/ - RLS
 * (workflow_executions_select / automation_events_select, both
 * is_org_member()-gated) is the only thing that ever restricts which rows
 * come back; no organization id is trusted from the client, and this page
 * never uses a service-role client (that pattern is reserved for the
 * unauthenticated cron/webhook routes - see lib/supabase/service.ts).
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

  const [overview, statsByName, enabledByAutomationId] = await Promise.all([
    getAutomationOverview(supabase, membership.organizationId),
    getWorkflowNameStats(supabase, membership.organizationId),
    getAutomationEnabledMap(supabase, membership.organizationId),
  ]);

  const summaries = buildAutomationSummaries(statsByName, enabledByAutomationId);
  const recentAiExecutions = await getRecentExecutionsForWorkflows(supabase, membership.organizationId, getAiAgentWorkflowNames(), 15);

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader eyebrow="Automate" title="Automations" description="Monitor and manage the automated systems running your business." />

      <div className="flex flex-col gap-2">
        <p className={sectionLabelClass}>Overview</p>
        <SummaryCards overview={overview} summaries={summaries} />
        <p className={metaClass}>Activity reflects the last 30 days.</p>
      </div>

      <AiAgents summaries={summaries} />

      <div className="flex flex-col gap-2">
        <p className={sectionLabelClass}>Recent AI activity</p>
        <AiActivityFeed executions={recentAiExecutions} />
      </div>

      <div className="flex flex-col gap-2">
        <p className={sectionLabelClass}>All automations</p>
        <AutomationList summaries={summaries} />
      </div>
    </div>
  );
}
