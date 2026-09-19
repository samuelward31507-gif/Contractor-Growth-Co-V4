import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { getOrganizationHealth, getAutomationHealthSummaries, getLatestHealthCheckRun } from "@/lib/automation-health/health";
import { listIncidents } from "@/lib/automation-health/queries";
import { metaClass } from "@/lib/ui/typography";
import { PageHeader } from "@/lib/ui/page-header";
import { Badge } from "@/lib/ui/badge";
import { HealthSummaryCards, HEALTH_STATUS_BADGE } from "./_components/health-summary-cards";
import { IncidentList } from "./_components/incident-list";
import { AutomationHealthTable } from "./_components/automation-health-table";

/**
 * Automation Health + Alerting V1 - a standalone route
 * (/automation-health), read-only for every organization member (matching
 * the Automation Control Center's own precedent: viewing is member-
 * accessible, only acknowledge/resolve require owner/admin - see
 * actions.ts). Every query goes through the caller's own session-
 * authenticated client; RLS (automation_incidents_select -> is_org_member)
 * is the only thing that ever restricts which rows come back, exactly like
 * every other page under app/(app)/.
 *
 * Leads with the answer: the overall healthy/degraded/unhealthy status sits
 * directly in the page header, next to the title, before any supporting
 * detail - "is my system working?" is answerable in the first second on the
 * page, per the design brief. It's still conveyed by an icon + text label,
 * not color alone (Badge always pairs both), so an unhealthy state reads
 * correctly for screen reader users too - not just a red chip.
 */
export default async function AutomationHealthPage() {
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

  const [orgHealth, automationSummaries, incidents, lastHealthCheck] = await Promise.all([
    getOrganizationHealth(supabase, membership.organizationId),
    getAutomationHealthSummaries(supabase, membership.organizationId),
    listIncidents(supabase, membership.organizationId, { status: ["open", "acknowledged"] }),
    getLatestHealthCheckRun(supabase),
  ]);

  const statusBadge = HEALTH_STATUS_BADGE[orgHealth.status];

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <PageHeader
        title="Automation Health"
        description="Detect, deduplicate, and track automation failures before a customer notices."
        badge={
          <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
            {statusBadge.label}
          </Badge>
        }
      />

      <div className="flex flex-col gap-2">
        <HealthSummaryCards health={orgHealth} />
        <p className={metaClass}>
          {lastHealthCheck
            ? `Last automated health check: ${new Date(lastHealthCheck.checkedAt).toLocaleString()} (${lastHealthCheck.stuckCount} stuck execution${lastHealthCheck.stuckCount === 1 ? "" : "s"} found)`
            : "No automated health check has run yet."}
        </p>
      </div>

      <IncidentList incidents={incidents} />

      <AutomationHealthTable summaries={automationSummaries} />
    </div>
  );
}
