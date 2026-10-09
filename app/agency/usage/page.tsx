import { AlertCircle, Bot, Building2, MessageSquare, PhoneMissed, Workflow } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyCostReadiness } from "@/lib/agency/cost-readiness";
import { metaClass } from "@/lib/ui/typography";
import { PageHeader } from "@/lib/ui/page-header";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { SectionCard } from "@/lib/ui/section-card";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { formatCount } from "../_components/format";
import { UnauthorizedState } from "../_components/unauthorized-state";
import { ErrorState } from "../_components/error-state";
import { ClientUsageRows } from "./_components/client-usage-rows";
import { CostReadinessSection } from "./_components/cost-readiness-section";

/**
 * Trackpr Phase 5B - Agency Client Usage Intelligence. A thin, read-only
 * presentation layer over lib/agency/usage.ts, itself a thin aggregation
 * layer over the existing BI snapshot every other agency page already reads
 * (see lib/agency/usage.ts's own header comment). This is usage visibility,
 * not billing - no dollar figure appears anywhere on this page, by design.
 *
 * Busiest client first (by total messages + AI interactions + automation
 * executions) - a plain, undisputed sort by real activity volume, never a
 * scored "confidence" or ranking. lib/agency/usage.ts returns clients in
 * whatever order the underlying snapshot naturally comes in, and this page
 * does the one sort that makes the page useful to scan.
 *
 * Trackpr Phase 5C: fetches through getAgencyCostReadiness(), which calls
 * getAgencyUsageSummary() internally exactly once and returns its result
 * unchanged under `usage`, plus the Cost Readiness section's
 * `costReadiness` field - no second data fetch.
 *
 * Agency redesign: the client app's page anatomy (standard page container,
 * PageHeader, StatGrid, SectionCards, shared table primitives). The read,
 * the sort, authorization and the error path are unchanged. A null missed-
 * call total shows "—" with a note (never 0); the AI total says how many
 * clients' AI data it could not include.
 */
function totalActivity(client: { messaging: { total: number }; ai: { interactions: number }; automation: { executions: number } }): number {
  return client.messaging.total + client.ai.interactions + client.automation.executions;
}

const PAGE_CLASS = `${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`;

export default async function AgencyUsagePage() {
  const supabase = await createClient();
  const service = createServiceRoleClient();

  let result: Awaited<ReturnType<typeof getAgencyCostReadiness>>;

  try {
    result = await getAgencyCostReadiness(supabase, service);
  } catch {
    return (
      <div className={PAGE_CLASS}>
        <ErrorState />
      </div>
    );
  }

  if (!result.ok) {
    return (
      <div className={PAGE_CLASS}>
        <UnauthorizedState />
      </div>
    );
  }

  const { clients, totals } = result.usage;
  const { partialData } = result;
  const period = clients[0]?.period.label ?? "last 30 days";

  const sortedClients = [...clients].sort((a, b) => totalActivity(b) - totalActivity(a));
  // Presentation only: how many clients' AI figures are zeroed placeholders
  // (client.ai.unavailable) and therefore not part of the AI total below.
  const aiUnavailableCount = clients.filter((client) => client.ai.unavailable).length;
  const mayBeIncomplete = "May be incomplete - see the notice above";

  return (
    <div className={PAGE_CLASS}>
      <div>
        <PageHeader
          eyebrow="Agency"
          title="Client usage"
          description="How much each managed client is actually using Trackpr — messaging, AI, and automation activity, not billing."
        />
        <p className={`mt-1.5 ${metaClass}`}>Period: {period}</p>
      </div>

      {/* Mirrors app/agency/page.tsx's own health.partialData banner and
          app/agency/expansion/page.tsx's identical treatment - a real read
          failure for any one client must never render this page as if every
          client's usage were fully accounted for. */}
      {partialData ? (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some usage data is temporarily unavailable for one or more clients. Figures marked &ldquo;Partial&rdquo; or &ldquo;Unavailable&rdquo; below may be incomplete.</p>
        </div>
      ) : null}

      <StatGrid columns={5}>
        <StatCard label="Clients monitored" value={formatCount(totals.organizationCount)} description="Managed client organizations" icon={Building2} />
        <StatCard label="Total messages" value={formatCount(totals.totalMessages)} description={partialData ? mayBeIncomplete : "Across every managed client"} icon={MessageSquare} />
        <StatCard
          label="Total AI interactions"
          value={formatCount(totals.totalAiInteractions)}
          description={
            aiUnavailableCount > 0
              ? `Excludes ${aiUnavailableCount} client${aiUnavailableCount === 1 ? "" : "s"} whose AI data is unavailable`
              : partialData
                ? mayBeIncomplete
                : "Across every managed client"
          }
          tone={aiUnavailableCount > 0 ? "warning" : "neutral"}
          icon={Bot}
        />
        <StatCard
          label="Automation executions"
          value={formatCount(totals.totalAutomationExecutions)}
          description={partialData ? mayBeIncomplete : "Across every managed client"}
          icon={Workflow}
        />
        <StatCard
          label="Missed calls"
          value={totals.totalMissedCalls === null ? "—" : formatCount(totals.totalMissedCalls)}
          description={totals.totalMissedCalls === null ? "Unavailable - missed-call data could not be loaded" : "The one voice fact Trackpr can confirm"}
          tone={totals.totalMissedCalls === null ? "warning" : "neutral"}
          icon={PhoneMissed}
        />
      </StatGrid>

      <div className="flex flex-col gap-6">
        <SectionCard
          title="Client activity"
          description="Busiest client first. Open a client for its full record."
          action={clients.length > 0 ? <span className="shrink-0 text-xs text-ink-3">{clients.length} client{clients.length === 1 ? "" : "s"}</span> : undefined}
        >
          <ClientUsageRows clients={sortedClients} />
        </SectionCard>

        <CostReadinessSection clients={result.costReadiness.clients} />

        <SectionCard title="About this page">
          <ul className="space-y-1.5 text-xs text-ink-3">
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              This is usage visibility, not billing — no dollar cost is calculated or shown anywhere on this page. No pricing or rate data exists in Trackpr today for SMS, AI, voice, or automation.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              &ldquo;Unavailable&rdquo; means the underlying data could not be confirmed — never treated the same as a genuine 0.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              Missed calls are the one fact Trackpr can confirm about voice activity — Trackpr does not answer calls, so duration, voicemail, and answered calls are not tracked.
            </li>
            <li className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-strong" aria-hidden />
              Leads, appointments, estimates, and jobs are shown as business activity for context — not platform usage, and never a billable figure.
            </li>
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}
