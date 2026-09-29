import Link from "next/link";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getAgencyCostReadiness } from "@/lib/agency/cost-readiness";
import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { PageHeader } from "@/lib/ui/page-header";
import { formatCount } from "../_components/format";
import { formatNullableCount } from "./_components/format";
import { UnauthorizedState } from "../_components/unauthorized-state";
import { ErrorState } from "../_components/error-state";
import { Row } from "../_components/row";
import { ClientUsageRows } from "./_components/client-usage-rows";
import { CostReadinessSection } from "./_components/cost-readiness-section";

/**
 * Trackpr Phase 5B - Agency Client Usage Intelligence. A thin, read-only
 * presentation layer over lib/agency/usage.ts, itself a thin aggregation
 * layer over the existing BI snapshot every other agency page already reads
 * (see lib/agency/usage.ts's own header comment). This is usage visibility,
 * not billing - no dollar figure appears anywhere on this page, by design;
 * there is no pricing/rate data anywhere in this codebase to compute one
 * from honestly.
 *
 * Busiest client first (by total messages + AI interactions + automation
 * executions) - a plain, undisputed sort by real activity volume, never a
 * scored "confidence" or ranking. Mirrors app/agency/expansion/page.tsx's
 * own client-grouping-in-the-page-component convention: lib/agency/usage.ts
 * returns clients in whatever order the underlying snapshot naturally comes
 * in, and this page does the one sort that makes the page useful to scan.
 *
 * Trackpr Phase 5C: now fetches through getAgencyCostReadiness() instead of
 * calling getAgencyUsageSummary() directly - that function calls
 * getAgencyUsageSummary() internally exactly once and returns its result
 * unchanged under `usage`, so every existing summary/table render below is
 * completely unmodified (same `clients`/`totals` shape, same component). The
 * only new content is the Cost Readiness section, added from the same
 * result's new `costReadiness` field - no second data fetch, no redesign of
 * the existing page.
 */
function totalActivity(client: { messaging: { total: number }; ai: { interactions: number }; automation: { executions: number } }): number {
  return client.messaging.total + client.ai.interactions + client.automation.executions;
}

export default async function AgencyUsagePage() {
  const supabase = await createClient();
  const service = createServiceRoleClient();

  let result: Awaited<ReturnType<typeof getAgencyCostReadiness>>;

  try {
    result = await getAgencyCostReadiness(supabase, service);
  } catch {
    return (
      <div className="mx-auto flex w-full max-w-[1150px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <ErrorState />
      </div>
    );
  }

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-[1150px] flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <UnauthorizedState />
      </div>
    );
  }

  const { clients, totals } = result.usage;
  const { partialData } = result;
  const period = clients[0]?.period.label ?? "last 30 days";

  const sortedClients = [...clients].sort((a, b) => totalActivity(b) - totalActivity(a));

  return (
    <div className="mx-auto w-full max-w-[1150px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <Link href="/agency" className="inline-flex items-center gap-1 text-xs font-medium text-ink-3 hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Agency Command Center
      </Link>

      <div className="mt-3">
        <PageHeader
          eyebrow="Monitoring"
          title="Client Usage"
          description="How much each managed client is actually using Trackpr — messaging, AI, and automation activity, not billing."
        />
        <p className={`mt-1 ${metaClass}`}>Period: {period}</p>
      </div>

      {/* Mirrors app/agency/page.tsx's own health.partialData banner and
          app/agency/expansion/page.tsx's identical treatment - a real read
          failure for any one client must never render this page as if every
          client's usage were fully accounted for. */}
      {partialData ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Some usage data is temporarily unavailable for one or more clients. Figures marked &ldquo;Partial&rdquo; or &ldquo;Unavailable&rdquo; below may be incomplete.</p>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-line py-4">
        <Row label="Clients monitored" value={formatCount(totals.organizationCount)} />
        <Row label="Total messages" value={formatCount(totals.totalMessages)} />
        <Row label="Total AI interactions" value={formatCount(totals.totalAiInteractions)} />
        <Row label="Total automation executions" value={formatCount(totals.totalAutomationExecutions)} />
        <Row label="Total missed calls" value={formatNullableCount(totals.totalMissedCalls)} />
      </div>

      <div className="mt-8">
        <div className="flex items-baseline justify-between">
          <p className={sectionLabelClass}>Client activity</p>
          {clients.length > 0 ? <span className={metaClass}>{clients.length} client{clients.length === 1 ? "" : "s"}</span> : null}
        </div>
        <div className="mt-2">
          <ClientUsageRows clients={sortedClients} />
        </div>
      </div>

      <CostReadinessSection clients={result.costReadiness.clients} />

      <div className="mt-8 border-t border-line pt-8">
        <p className={sectionLabelClass}>About this page</p>
        <ul className="mt-2 space-y-1.5 text-xs text-ink-3">
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
      </div>
    </div>
  );
}
