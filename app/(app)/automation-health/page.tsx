import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserOrganization } from "@/lib/auth/organization";
import { getOrganizationHealth, getAutomationHealthSummaries, getLatestHealthCheckRun } from "@/lib/automation-health/health";
import { listIncidents } from "@/lib/automation-health/queries";
import { pageTitleClass, pageDescriptionClass, metaClass } from "@/lib/ui/typography";
import { HealthSummaryCards } from "./_components/health-summary-cards";
import { IncidentList } from "./_components/incident-list";
import { AutomationHealthTable } from "./_components/automation-health-table";

/**
 * Automation Health + Alerting V1 - a standalone route
 * (/automation-health, no nav link), matching the established precedent
 * from SMS Routing Settings/Contact Deduplication for shipping new
 * organization-scoped UI without touching the in-progress Trackpr 2.0
 * redesign under app/(app)/ (see the "standalone route, no nav link"
 * decision made earlier this session).
 *
 * Read-only for every organization member (matching the Automation Control
 * Center's own precedent: viewing is member-accessible, only acknowledge/
 * resolve require owner/admin - see actions.ts). Every query goes through
 * the caller's own session-authenticated client; RLS (automation_incidents_select
 * -> is_org_member) is the only thing that ever restricts which rows come
 * back, exactly like every other page under app/(app)/.
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

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <h1 className={pageTitleClass}>Automation Health</h1>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>Detect, deduplicate, and track automation failures before a customer notices.</p>
      </div>

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
