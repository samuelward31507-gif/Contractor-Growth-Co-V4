import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestMembership, getRequestSupabase } from "@/lib/auth/request-context";
import { AlertCircle } from "lucide-react";
import { getDashboardSqlData } from "@/lib/dashboard/queries";
import { dashboardInvoiceSummary, getDashboardSummary, organizationDayBounds } from "@/lib/dashboard/sql";
import { getDashboardAiHandled } from "@/lib/dashboard/business-metrics";
import { getOwnerDailyBriefing, getEndOfDaySummary } from "@/lib/briefing/queries";
import { scheduleOpportunitySync } from "@/lib/opportunities/background-sync";
import { getOpenOpportunitiesResult } from "@/lib/opportunities/queries";
import { getPrioritizedOpportunities } from "@/lib/opportunities/intelligence";
import { assembleDecisions } from "@/lib/decisions/assemble";
import { getDecisionContext } from "@/lib/decisions/context";
import type { DecisionItem } from "@/lib/decisions/types";
import { getContacts } from "@/lib/contacts/queries";
import { calendarDateInTimeZone, formatMoney } from "@/lib/invoices/domain";
import { getAutomationMode, getOrganizationTimezone } from "@/lib/settings/queries";
import { formatCurrency } from "@/lib/dashboard/format";
import { pageEyebrowClass, pageTitleClass, pageDescriptionClass } from "@/lib/ui/typography";
import { PageContainer } from "@/lib/ui/page";
import { QueueRow } from "@/lib/ui/queue-row";
import { AddLeadButton } from "../leads/_components/add-lead-button";
import { OpportunitiesList } from "../opportunities/_components/opportunities-list";
import { TodayViewTabs, type TodayView } from "./_components/today-view-tabs";
import { ScrollToAnchorOnLoad } from "./_components/scroll-to-anchor-on-load";
import { attentionLine, conversationsWaitingCount, greetingForHour, handledLine, handlingLine, hourInTimeZone, pipelineStages, todayEyebrow, todayFigures } from "./_components/dashboard-model";
import { AttentionPanel, DashboardSection, PipelineFlow, SectionLink, ShowAllLink, TodayActivity, TodayKpis } from "./_components/dashboard-sections";

function normalizeView(value: string | undefined): TodayView {
  return value === "by-type" ? "by-type" : "priority";
}

/** How many attention rows show before "Show all" - the top of the priority order is what matters at a glance. */
const ATTENTION_PREVIEW = 6;

/** How many opportunity rows the third act previews before "Show all" opens every open opportunity by type. */
const OPPORTUNITY_PREVIEW = 6;

/**
 * Today - the "right now" page, in three acts:
 *   I.   What happened - new leads, appointments, conversations waiting on a
 *        reply, recent follow-ups and completed work, what Trackpr handled.
 *   II.  What needs attention - operational exceptions, then the priority
 *        list's time-sensitive tiers (replies, revenue at risk, leads to
 *        pursue, at-risk estimates and bookings). "You're all caught up"
 *        when it is empty.
 *   III. What opportunity exists - the recoverable and growth tiers
 *        (reactivation, reviews, referrals), every open opportunity by type
 *        one click away, and where the work and the money owed stand.
 * Historical performance - period revenue, conversion, the cached AI
 * observations - lives on Analytics (/insights), never here. System health
 * is not repeated here - the top bar is its one home.
 *
 * Data: one parallel batch of request-memoized reads, the same background
 * opportunity sync scheduled inside it, and the same partial-data
 * disclosure. The wording lives in ./_components/dashboard-model.ts,
 * composed from those values.
 *
 * The priority list still comes from lib/opportunities/intelligence.ts
 * (persisted opportunities, tiered and explained, merged with conversation
 * signals); operational exceptions still render first and are never tiered
 * alongside revenue opportunities. The priority order is split by tier, never
 * re-detected. Phase 2-2: lib/decisions/assemble.ts turns those reads into
 * DecisionItems (exceptions, Act II, Act III, and the one attention count),
 * every label, sentence and link resolved from the single next-action
 * registry (lib/decisions/registry.ts). "By type" (TodayViewTabs,
 * /today?view=by-type#opportunities) is the Opportunities nav destination
 * and reuses OpportunitiesList unmodified.
 */
export default async function TodayPage({ searchParams }: PageProps<"/today">) {
  const params = await searchParams;
  const view = normalizeView(typeof params.view === "string" ? params.view : undefined);
  const showAllAttention = params.all === "1";

  const supabase = await getRequestSupabase();
  const { user, membership } = await getRequestMembership();

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/onboarding");
  }

  // "Today" is the organization's own calendar day, never the server's
  // (UTC on Vercel): the timezone is read first so every day-scoped read
  // below - appointments today, the briefing, new leads, what Trackpr
  // handled - shares one set of organization-day bounds. One `now` and one
  // bounds object for the briefing and the end-of-day summary, so they share
  // a single dashboard_briefing call (request-scoped - see
  // lib/briefing/queries.ts).
  // Phase 3 (W5): started alongside the page's reads - whether the workspace is live decides the setup banner.
  const automationModeRead = getAutomationMode(supabase, membership.organizationId);
  const timeZone = await getOrganizationTimezone(supabase, membership.organizationId);
  const briefingNow = new Date();
  const dayBounds = organizationDayBounds(briefingNow, timeZone ?? "UTC");
  const [
    data,
    summary,
    contacts,
    aiHandled,
    dailyBriefing,
    endOfDaySummary,
    opportunitiesResult,
    prioritizedOpportunities,
    ,
    decisionContext,
  ] = await Promise.all([
    // Phase 2D: getDashboardData with its conversation attention computed in
    // SQL, memoized for this request so the briefing and end-of-day summary
    // below reuse the same load.
    getDashboardSqlData(supabase, membership.organizationId),
    // Phase 2D: every header / Money / invoice figure this page shows -
    // counted and summed by the database over the organization's complete
    // data (dashboard_summary). See lib/dashboard/sql.ts.
    getDashboardSummary(supabase, membership.organizationId, briefingNow, dayBounds),
    getContacts(supabase, membership.organizationId),
    // Phase 2A-1: only today's AI metrics - see lib/dashboard/business-metrics.ts.
    getDashboardAiHandled(supabase, membership.organizationId, dayBounds),
    getOwnerDailyBriefing(supabase, membership.organizationId, briefingNow, { source: "sql", dayBounds }),
    getEndOfDaySummary(supabase, membership.organizationId, briefingNow, { source: "sql", dayBounds }),
    getOpenOpportunitiesResult(supabase, membership.organizationId),
    // Canonical Opportunity Intelligence Layer: the one prioritized,
    // explained, actionability-checked read every consumer of "what needs
    // attention" shares.
    getPrioritizedOpportunities(supabase, membership.organizationId),
    // Phase 2C: opportunity detection never blocks this render - scheduled
    // here, run after the response (next/server after()). Never rejects.
    scheduleOpportunitySync(supabase, membership.organizationId),
    // Phase 2-3: who acts - chained onto the request-memoized dashboard
    // read (its waiting conversations), so it adds no await and never
    // re-reads the dashboard; the organization/settings reads inside are
    // shared with getPrioritizedOpportunities.
    getDashboardSqlData(supabase, membership.organizationId).then((dashboard) => getDecisionContext(supabase, membership.organizationId, { attentionItems: dashboard.attentionItems, timeZone: timeZone ?? null })),
  ]);

  const openOpportunities = opportunitiesResult.data;
  // A failed summary is disclosed exactly as the reads it replaced were.
  const moneyDataFailed = summary.failed;
  // "Overdue" is judged against today's date in the organization's own
  // timezone - the same calendar the issue trigger used for the due date.
  const today = calendarDateInTimeZone(new Date(), timeZone ?? "UTC");
  const invoiceSummary = dashboardInvoiceSummary(summary.data, today);

  // Operational exceptions render first, separately; conversation signals
  // merge with persisted opportunities into one priority order. Zero new
  // queries - assembled from data.attentionItems and the prioritized
  // opportunities, both already fetched above.
  const decisions = assembleDecisions({ attentionItems: data.attentionItems, prioritizedOpportunities, context: decisionContext });
  const operationalExceptions = decisions.exceptions;
  const queue = decisions.attention;
  const opportunityQueue = decisions.opportunities;
  // The one attention state: the header line, the Act II count and
  // "You're all caught up" all read this number.
  const totalNeedingAttention = decisions.totalNeedingAttention;
  const visibleQueue = showAllAttention ? queue : queue.slice(0, Math.max(0, ATTENTION_PREVIEW - operationalExceptions.length));
  const hiddenCount = queue.length - visibleQueue.length;
  const visibleOpportunityQueue = opportunityQueue.slice(0, OPPORTUNITY_PREVIEW);

  const greeting = greetingForHour(hourInTimeZone(briefingNow, timeZone ?? null));
  const isLive = (await automationModeRead) === "live";
  const canFinishSetup = membership.role === "owner" || membership.role === "admin";

  const figures = todayFigures({
    leadsReceivedToday: endOfDaySummary.leadsReceived,
    appointmentsToday: summary.data.appointments_today,
    // The waiting-for-reply rows Act II renders (human only, Phase 2-3b) -
    // not dailyBriefing.aiEscalationsCount (open conversations with AI off).
    conversationsWaiting: conversationsWaitingCount(decisions.attention),
  });

  const stages = pipelineStages(
    summary.data,
    {
      openLeads: formatCurrency(summary.data.pipeline_value),
      quotesOut: formatCurrency(summary.data.quotes_out_value),
      readyToSchedule: formatCurrency(summary.data.ready_to_schedule_value),
      inProgress: formatCurrency(summary.data.won_not_finished_value),
      readyToInvoice: formatMoney(invoiceSummary.notYetInvoicedKnownValue),
      outstanding: formatMoney(invoiceSummary.outstanding),
    },
    { count: invoiceSummary.overdueCount, value: formatMoney(invoiceSummary.overdue) },
  );

  // Final redesign: the KPI row is today's three figures plus, for a
  // contractor, the one money-owed figure (the existing Unpaid stage -
  // same value, detail, link and tone); the pipeline tiles keep the work
  // stages before it, so nothing is shown twice.
  const unpaidStage = stages.find((stage) => stage.key === "unpaid");
  const workStages = stages.filter((stage) => stage.key !== "unpaid");

  // Estimates, jobs and invoices are contractor workflows - the same
  // vertical rule navigation uses (nav-items.ts) - so the pipeline flow
  // only renders for a contractor organization.
  const showPipeline = membership.vertical === "contractor";
  const kpis = showPipeline && unpaidStage ? [...figures, unpaidStage] : figures;

  return (
    <PageContainer>
      {/* A failed read is disclosed, never rendered as a confidently clean
          page: the SQL dashboard data, the summary that carries every money
          figure, today's AI metrics, the briefing and the end-of-day counts. */}
      {data.partialData || summary.failed || aiHandled.failed || dailyBriefing.partialData || endOfDaySummary.partialData || moneyDataFailed ? (
        <div role="status" className="flex items-start gap-2.5 rounded-xl border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            Some information is temporarily unavailable.{" "}
            <Link href="/today" className="font-medium underline decoration-warning-text/40 underline-offset-2 hover:decoration-warning-text">
              Refresh to try again
            </Link>
            .
          </p>
        </div>
      ) : null}

      {/* Phase 3 (W5): a new workspace says it isn't live yet, instead of only "all caught up". */}
      {!isLive ? (
        <div role="status" className="flex items-start gap-2.5 rounded-xl border border-info-border bg-info-muted px-4 py-2.5 text-sm text-info-text">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            Trackpr isn&apos;t live yet - automated texts and follow-ups stay off until setup is finished.{" "}
            {canFinishSetup ? (
              <Link href="/onboarding" className="font-medium underline decoration-info-text/40 underline-offset-2 hover:decoration-info-text">
                Finish setup
              </Link>
            ) : (
              "Your workspace owner can finish it."
            )}
          </p>
        </div>
      ) : null}

      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className={`mb-2 ${pageEyebrowClass}`}>{todayEyebrow(briefingNow, timeZone ?? null)}</p>
          <h1 className={pageTitleClass}>{greeting}</h1>
          <p className={`mt-1.5 ${pageDescriptionClass}`}>{attentionLine(totalNeedingAttention)}</p>
        </div>
        {contacts.length > 0 ? (
          <div className="shrink-0">
            <AddLeadButton contacts={contacts} />
          </div>
        ) : null}
      </header>

      {/* Act I - what happened: the KPI row (today's figures, plus the one
          money-owed figure for a contractor). Its follow-ups render as
          "Today's activity" in the work column below. */}
      <DashboardSection id="today" title="What happened today" hideTitle>
        <TodayKpis figures={kpis} />
      </DashboardSection>

      {/* Final redesign: one responsive grid. Source order is the approved
          act order (and the mobile stacking order); at lg+ the work column
          (where the work stands, opportunities, today's activity) sits
          left and Act II takes the narrow right column as the page's one
          dark focal panel. The trailing 1fr row absorbs the panel's extra
          height, so the left cards stack tightly instead of spreading. */}
      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)] lg:grid-rows-[auto_auto_auto_1fr] lg:items-start xl:grid-cols-[minmax(0,1fr)_440px]">
        {/* Act II - what needs attention. */}
        <AttentionPanel
          id="needs-attention"
          count={totalNeedingAttention}
          className="lg:col-start-2 lg:row-span-4 lg:row-start-1"
          footer={hiddenCount > 0 ? <ShowAllLink href="/today?all=1" count={totalNeedingAttention} inverse /> : null}
        >
          {totalNeedingAttention === 0 ? (
            <div className="rounded-lg bg-dark-fill px-5 py-10 text-center inset-ring inset-ring-dark-line">
              <p className="text-sm font-medium text-on-dark">You&apos;re all caught up.</p>
              <p className="mt-1 text-[13px] text-on-dark-3">Anything new that needs you will appear here first.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {operationalExceptions.map((item) => (
                <li key={item.key}>
                  <DecisionRow item={item} inverse />
                </li>
              ))}
              {visibleQueue.map((item) => (
                <li key={item.key}>
                  <DecisionRow item={item} inverse />
                </li>
              ))}
            </ul>
          )}
        </AttentionPanel>

        {/* Act III - what opportunity exists. */}
        <DashboardSection
          id="opportunities"
          title="Opportunities"
          variant="card"
          className={`lg:col-start-1 ${showPipeline ? "lg:row-start-2" : "lg:row-start-1"}`}
          action={<TodayViewTabs active={view} opportunityCount={openOpportunities.length} />}
        >
          <ScrollToAnchorOnLoad id="opportunities" />
          {view === "priority" ? (
            <div className="border-t border-line">
              {opportunityQueue.length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <p className="text-sm font-medium text-ink">Nothing else to pursue right now.</p>
                  <p className="mt-1 text-[13px] text-ink-3">Customers to win back and reviews or referrals to ask for will appear here.</p>
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {visibleOpportunityQueue.map((item) => (
                    <li key={item.key}>
                      <DecisionRow item={item} />
                    </li>
                  ))}
                </ul>
              )}
              {opportunityQueue.length > visibleOpportunityQueue.length ? <ShowAllLink href="/today?view=by-type#opportunities" count={openOpportunities.length} /> : null}
            </div>
          ) : (
            <div className="border-t border-line px-4 py-4 sm:px-5 sm:py-5">
              <OpportunitiesList opportunities={openOpportunities} failed={opportunitiesResult.failed} />
            </div>
          )}
        </DashboardSection>

        {showPipeline ? (
          <DashboardSection id="pipeline" title="Where the work stands" variant="card" className="lg:col-start-1 lg:row-start-1" action={<SectionLink href="/money">Open Money</SectionLink>}>
            <PipelineFlow stages={workStages} />
          </DashboardSection>
        ) : null}

        <TodayActivity
          briefing={dailyBriefing}
          handled={handledLine(aiHandled.aiMetrics)}
          handling={handlingLine(decisions.trackprHandling.length)}
          className={`lg:col-start-1 ${showPipeline ? "lg:row-start-3" : "lg:row-start-2"}`}
        />
      </div>
    </PageContainer>
  );
}

/** One decision row - the same QueueRow for operational exceptions, the attention list and the opportunity preview (`inverse` inside the dark attention panel). */
function DecisionRow({ item, inverse = false }: { item: DecisionItem; inverse?: boolean }) {
  return (
    <QueueRow
      tone={item.tone}
      problemLabel={item.problemLabel}
      age={item.age}
      personName={item.subject.name}
      personHref={item.subject.href}
      money={item.money}
      sentence={item.sentence}
      phone={item.phone}
      secondaryHref={item.nextAction.href}
      secondaryLabel={item.nextAction.label}
      variant={inverse ? "inverse" : "default"}
    />
  );
}
