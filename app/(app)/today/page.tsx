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
import {
  getPrioritizedOpportunities,
  getConversationSignals,
  getOperationalExceptions,
  buildPriorityQueue,
  type PriorityItem,
  type PriorityTier,
  type RecommendedAction,
} from "@/lib/opportunities/intelligence";
import { OPPORTUNITY_TYPE_LABEL, opportunityActionHref, OPPORTUNITY_ACTION_LABEL } from "../opportunities/_components/opportunity-type";
import { getContacts } from "@/lib/contacts/queries";
import { calendarDateInTimeZone, formatMoney } from "@/lib/invoices/domain";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import { pageTitleClass, pageDescriptionClass } from "@/lib/ui/typography";
import { PageContainer } from "@/lib/ui/page";
import { QueueRow } from "@/lib/ui/queue-row";
import { ATTENTION_COPY } from "@/lib/today/copy";
import type { StatusTone } from "@/lib/ui/status";
import { AddLeadButton } from "../leads/_components/add-lead-button";
import { OpportunitiesList } from "../opportunities/_components/opportunities-list";
import { TodayViewTabs, type TodayView } from "./_components/today-view-tabs";
import { attentionLine, conversationsWaitingCount, greetingForHour, handledLine, hourInTimeZone, pipelineStages, todayFigures } from "./_components/dashboard-model";
import { DashboardSection, PipelineFlow, SectionLink, ShowAllLink, TodayPanel } from "./_components/dashboard-sections";

type QueueEntry = {
  key: string;
  tone: StatusTone;
  problemLabel: string;
  age?: string;
  personName: string;
  personHref: string;
  money?: string;
  sentence: string;
  phone?: string | null;
  secondaryHref: string;
  secondaryLabel: string;
};

/** Canonical Opportunity Intelligence Layer: the internal tier is never shown as a number or a tier name - it maps to the same three-tone visual language every other status surface in this app already uses (lib/ui/status.ts). */
const TONE_BY_TIER: Record<PriorityTier, StatusTone> = {
  needs_reply: "urgent",
  committed_revenue_at_risk: "urgent",
  active_pursuit: "soon",
  at_risk: "soon",
  recoverable: "good",
  growth: "good",
};

/**
 * Short imperative phrase appended to the explanation sentence for actions
 * with no dedicated button on the row. "call"/"text" are deliberately
 * omitted - QueueRow already renders a real "Call" button whenever a valid
 * phone is present, and repeating "Give them a call" in the sentence next to
 * that button would be redundant. "monitor"/"no_action" are also omitted -
 * there is nothing to instruct.
 */
const ACTION_SENTENCE: Partial<Record<RecommendedAction, string>> = {
  respond: "Reply to their message.",
  book: "Get it booked.",
  rebook: "Reach out to get it rebooked.",
  send_estimate: "Send an estimate.",
  follow_up_estimate: "Follow up on the estimate.",
  create_job: "Create the job.",
  reactivate: "Reach out to reconnect.",
  request_review: "Ask for a review.",
  request_referral: "Ask for a referral.",
  follow_up: "Follow up.",
  create_invoice: "Create the invoice.",
  collect_payment: "Collect the payment.",
};

function buildSentence(primaryReason: string, supportingSignals: string[], counterSignals: string[], recommendedAction: RecommendedAction): string {
  const actionPhrase = ACTION_SENTENCE[recommendedAction];
  return [primaryReason, ...supportingSignals, ...counterSignals, actionPhrase].filter(Boolean).join(" ");
}

function priorityItemToQueueEntry(item: PriorityItem): QueueEntry {
  if (item.kind === "opportunity") {
    const { opportunity, explanation, recommendedAction, contactPhone } = item.data;
    return {
      key: item.key,
      tone: TONE_BY_TIER[item.tier],
      problemLabel: OPPORTUNITY_TYPE_LABEL[opportunity.type],
      age: formatRelativeTime(opportunity.createdAt),
      personName: opportunity.title,
      personHref: opportunity.contactId ? `/people/${opportunity.contactId}` : "/today?view=by-type",
      money: opportunity.estimatedValue != null ? formatCurrency(opportunity.estimatedValue) : undefined,
      sentence: buildSentence(explanation.primaryReason, explanation.supportingSignals, explanation.counterSignals, recommendedAction),
      phone: contactPhone,
      secondaryHref: opportunityActionHref(opportunity),
      secondaryLabel: OPPORTUNITY_ACTION_LABEL[opportunity.type],
    };
  }

  const { kind, title, href, explanation, recommendedAction } = item.data;
  return {
    key: item.key,
    tone: TONE_BY_TIER[item.tier],
    problemLabel: ATTENTION_COPY[kind].label,
    personName: title,
    personHref: href,
    sentence: buildSentence(explanation.primaryReason, [], [], recommendedAction),
    phone: null,
    secondaryHref: href,
    // A conversation waiting on the contractor opens that conversation -
    // labeled for what the page does (it has no compose box).
    secondaryLabel: kind === "awaiting_reply" ? "Open conversation" : "View",
  };
}

function normalizeView(value: string | undefined): TodayView {
  return value === "by-type" ? "by-type" : "priority";
}

/** How many attention rows show before "Show all" - the top of the priority order is what matters at a glance. */
const ATTENTION_PREVIEW = 6;

/**
 * Today - the "right now" page: what needs me (the priority list, first
 * and widest), what is happening today (new leads, appointments,
 * conversations waiting on a reply, recent follow-ups, what Trackpr
 * handled), and where the work and the money owed stand right now.
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
 * alongside revenue opportunities. "By type" (TodayViewTabs) is the
 * Opportunities nav destination and reuses OpportunitiesList unmodified.
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
  // queries - both come from data.attentionItems, already fetched above.
  const operationalExceptions = getOperationalExceptions(data.attentionItems);
  const conversationSignals = getConversationSignals(data.attentionItems);
  const priorityQueue = buildPriorityQueue(prioritizedOpportunities, conversationSignals);
  const queue: QueueEntry[] = priorityQueue.map(priorityItemToQueueEntry);
  const totalNeedingAttention = operationalExceptions.length + queue.length;
  const visibleQueue = showAllAttention ? queue : queue.slice(0, Math.max(0, ATTENTION_PREVIEW - operationalExceptions.length));
  const hiddenCount = queue.length - visibleQueue.length;

  const greeting = greetingForHour(hourInTimeZone(briefingNow, timeZone ?? null));

  const figures = todayFigures({
    leadsReceivedToday: endOfDaySummary.leadsReceived,
    appointmentsToday: summary.data.appointments_today,
    // The awaiting_reply items the attention list already renders - not
    // dailyBriefing.aiEscalationsCount (open conversations with AI off).
    conversationsWaiting: conversationsWaitingCount(data.attentionItems),
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

  // Estimates, jobs and invoices are contractor workflows - the same
  // vertical rule navigation uses (nav-items.ts) - so the pipeline flow
  // only renders for a contractor organization.
  const showPipeline = membership.vertical === "contractor";

  return (
    <PageContainer>
      {/* A failed read is disclosed, never rendered as a confidently clean
          page: the SQL dashboard data, the summary that carries every money
          figure, today's AI metrics, the briefing and the end-of-day counts. */}
      {data.partialData || summary.failed || aiHandled.failed || dailyBriefing.partialData || endOfDaySummary.partialData || moneyDataFailed ? (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
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

      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className={pageTitleClass}>{greeting}</h1>
          <p className={`mt-1 ${pageDescriptionClass}`}>{attentionLine(totalNeedingAttention)}</p>
        </div>
        {contacts.length > 0 ? (
          <div className="shrink-0">
            <AddLeadButton contacts={contacts} />
          </div>
        ) : null}
      </header>

      <DashboardSection
        id="needs-attention"
        title={view === "by-type" ? "Opportunities" : totalNeedingAttention > 0 ? `Needs your attention · ${totalNeedingAttention}` : "Needs your attention"}
        action={<TodayViewTabs active={view} opportunityCount={openOpportunities.length} />}
      >
        {view === "priority" ? (
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            {totalNeedingAttention === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm font-medium text-ink">You&apos;re all caught up.</p>
                <p className="mt-1 text-[13px] text-ink-3">Anything new that needs you will appear here first.</p>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {operationalExceptions.map((exception) => (
                  <li key={exception.incidentId ?? `${exception.kind}-${exception.href}`}>
                    <QueueRow
                      tone="urgent"
                      problemLabel={ATTENTION_COPY[exception.kind].label}
                      personName={exception.title}
                      personHref={exception.href}
                      sentence={exception.detail}
                      secondaryHref={exception.href}
                      secondaryLabel="Review"
                    />
                  </li>
                ))}
                {visibleQueue.map((entry) => (
                  <li key={entry.key}>
                    <QueueRow
                      tone={entry.tone}
                      problemLabel={entry.problemLabel}
                      age={entry.age}
                      personName={entry.personName}
                      personHref={entry.personHref}
                      money={entry.money}
                      sentence={entry.sentence}
                      phone={entry.phone}
                      secondaryHref={entry.secondaryHref}
                      secondaryLabel={entry.secondaryLabel}
                    />
                  </li>
                ))}
              </ul>
            )}
            {hiddenCount > 0 ? <ShowAllLink href="/today?all=1" count={totalNeedingAttention} /> : null}
          </div>
        ) : (
          <OpportunitiesList opportunities={openOpportunities} failed={opportunitiesResult.failed} />
        )}
      </DashboardSection>

      <DashboardSection id="today" title="Today">
        <TodayPanel figures={figures} briefing={dailyBriefing} handled={handledLine(aiHandled.aiMetrics)} />
      </DashboardSection>

      {showPipeline ? (
        <DashboardSection id="pipeline" title="Where the work stands" action={<SectionLink href="/money">Open Money</SectionLink>}>
          <PipelineFlow stages={stages} />
        </DashboardSection>
      ) : null}
    </PageContainer>
  );
}
