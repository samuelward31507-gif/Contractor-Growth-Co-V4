import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { isAgencyAdmin } from "@/lib/agency/queries";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { loadSpecialistInputs } from "@/lib/agents/load";
import { runOperatingLayer } from "@/lib/agents/operating-layer";
import { agentRunPersistenceEnabled, persistAgentRuns } from "@/lib/agents/persistence";
import { PageHeader } from "@/lib/ui/page-header";
import { PageContainer } from "@/lib/ui/page";
import { greetingForHour, hourInTimeZone } from "../../today/_components/dashboard-model";
import { BriefingConsole } from "./_components/briefing-console";

/**
 * Trackpr Intelligence - the internal agent operating console (Agent
 * Operating Layer, Phase 1).
 *
 * Internal only: rendered for agency admins (Trackpr's own operators) and
 * a 404 for everyone else, checked server-side through the same
 * is_agency_admin() RPC the Agency Command Center uses. Data is the
 * signed-in operator's own organization (their verified membership), read
 * through the request's RLS-scoped client - never the service role, never
 * an organization id from the URL.
 *
 * Read-only: rendering runs the agents over existing reads and shows the
 * Chief of Staff's briefing. Nothing is sent, dispatched or changed. Run
 * history is written only when TRACKPR_AGENT_RUN_PERSISTENCE=on, after the
 * response, and a failed write never affects the page.
 */
export default async function IntelligencePage() {
  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();
  if (!user) redirect("/login");
  if (!membership) redirect("/onboarding");
  if (!(await isAgencyAdmin(supabase).catch(() => false))) notFound();

  const now = new Date();
  const timeZone = (await getOrganizationTimezone(supabase, membership.organizationId).catch(() => null)) ?? null;
  const inputs = await loadSpecialistInputs(supabase, membership.organizationId, { now, timeZone });
  const run = await runOperatingLayer(inputs, { now });

  if (agentRunPersistenceEnabled()) {
    after(() => persistAgentRuns(supabase, { organizationId: membership.organizationId, userId: user.id, results: [...run.results, run.chiefOfStaff] }));
  }

  return (
    <PageContainer gap="compact">
      <PageHeader eyebrow="Insights" title="Trackpr Intelligence" description="Internal operating console. Read-only: agents recommend, nothing here sends, changes or runs anything." />
      <BriefingConsole briefing={run.briefing} greeting={greetingForHour(hourInTimeZone(now, timeZone))} />
    </PageContainer>
  );
}
