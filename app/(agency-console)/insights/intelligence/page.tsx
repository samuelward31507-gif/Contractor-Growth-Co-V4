import { redirect } from "next/navigation";
import { after } from "next/server";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { isAgencyAdmin } from "@/lib/agency/queries";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { parseAgentView, resolveCommandCenterAccess } from "@/lib/agents/access";
import { loadSpecialistInputs } from "@/lib/agents/load";
import { runOperatingLayer } from "@/lib/agents/operating-layer";
import { agentRunPersistenceEnabled, persistAgentRuns } from "@/lib/agents/persistence";
import { PageHeader } from "@/lib/ui/page-header";
import { greetingForHour, hourInTimeZone } from "@/app/(app)/today/_components/dashboard-model";
import { UnauthorizedState } from "@/app/agency/_components/unauthorized-state";
import { AgentNav, ChiefOfStaffView, SpecialistView } from "./_components/command-center";

/**
 * Trackpr Intelligence - the internal Command Center (Agent Operating Layer).
 *
 * Internal only, and rendered inside the Agency Command Center's shell
 * ((agency-console)/layout.tsx re-exports app/agency/layout.tsx), never the
 * contractor shell. Access is decided server-side, before any agent input is
 * read, by resolveCommandCenterAccess over the existing is_agency_admin()
 * RPC: a signed-in user who is not an agency admin - every contractor - gets
 * the Agency surfaces' own UnauthorizedState and nothing else. Data is the
 * operator's own verified organization, read through the request's
 * RLS-scoped client - never the service role, never an organization id from
 * the URL. The only URL input is ?agent=<specialist>, validated against the
 * agent registry.
 *
 * Read-only: rendering runs the agents over existing reads. Nothing is sent,
 * dispatched or changed. Run history is written only when
 * TRACKPR_AGENT_RUN_PERSISTENCE=on, after the response.
 */
export default async function CommandCenterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const supabase = await getRequestSupabase();
  const access = await resolveCommandCenterAccess({ getMembership: getRequestMembership, isAgencyAdmin: () => isAgencyAdmin(supabase) });
  if (access.kind === "unauthenticated") redirect("/login");
  if (access.kind === "denied") {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <UnauthorizedState />
      </div>
    );
  }
  if (access.kind === "no_membership") redirect("/onboarding");
  const { user, membership } = access;

  const view = parseAgentView((await searchParams).agent);
  const now = new Date();
  const timeZone = (await getOrganizationTimezone(supabase, membership.organizationId).catch(() => null)) ?? null;
  const inputs = await loadSpecialistInputs(supabase, membership.organizationId, { now, timeZone });
  const run = await runOperatingLayer(inputs, { now });

  if (agentRunPersistenceEnabled()) {
    after(() => persistAgentRuns(supabase, { organizationId: membership.organizationId, userId: user.id, results: [...run.results, run.chiefOfStaff] }));
  }

  const status = view ? run.briefing.agents.find((line) => line.agent === view) : undefined;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <PageHeader eyebrow="Intelligence" title="Command Center" description={`Your AI operating team, watching ${membership.organizationName ?? "your workspace"}. Read-only: agents recommend; nothing here sends, changes or runs anything.`} />
      <AgentNav agents={run.briefing.agents} current={view} />
      {view && status ? <SpecialistView result={run.results.find((r) => r.agent === view)} status={status} /> : <ChiefOfStaffView briefing={run.briefing} greeting={greetingForHour(hourInTimeZone(now, timeZone))} />}
    </div>
  );
}
