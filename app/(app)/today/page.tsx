import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertCircle, Wallet, CalendarClock, Hammer, TrendingUp } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardData } from "@/lib/dashboard/queries";
import { getDashboardBusinessMetrics, getCachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import { getBusinessMetricsSnapshot } from "@/lib/bi/metrics";
import { getOwnerDailyBriefing, getEndOfDaySummary } from "@/lib/briefing/queries";
import { getHotLeadCount } from "@/lib/leads/queries";
import { getAppointments, summarizeAppointments } from "@/lib/appointments/queries";
import { syncOpportunities } from "@/lib/opportunities/detect";
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
import { getEstimatesResult } from "@/lib/estimates/queries";
import { getJobsResult } from "@/lib/jobs/queries";
import { computeMoneySnapshot } from "@/lib/money/snapshot";
import { getCustomerPaymentsResult, getInvoicesResult } from "@/lib/invoices/queries";
import { summarizeInvoiceMoney } from "@/lib/invoices/summary";
import { calendarDateInTimeZone } from "@/lib/invoices/domain";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { InvoiceMoneySummaryCards } from "../invoices/_components/invoice-money-summary";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import { pageTitleClass, pageDescriptionClass, numericDisplayClass, sectionLabelClass } from "@/lib/ui/typography";
import { QueueRow } from "@/lib/ui/queue-row";
import { StatGrid, StatCard } from "@/lib/ui/stat-card";
import { surfaceClass } from "@/lib/ui/surface";
import { ATTENTION_COPY } from "@/lib/today/copy";
import type { StatusTone } from "@/lib/ui/status";
import { AddLeadButton } from "../leads/_components/add-lead-button";
import { OpportunitiesList } from "../opportunities/_components/opportunities-list";
import { AiInsightsPanel } from "../dashboard/_components/ai-insights-panel";
import { BriefingPanel } from "../dashboard/_components/briefing-panel";
import { WhatAiHandled } from "../dashboard/_components/what-ai-handled";
import { TodayViewTabs, type TodayView } from "./_components/today-view-tabs";

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
    secondaryLabel: "View",
  };
}

function normalizeView(value: string | undefined): TodayView {
  return value === "by-type" ? "by-type" : "priority";
}

/**
 * IA consolidation pass: Today is now the app's one daily-action screen -
 * Dashboard's own unique content (the greeting/Pipeline-value header, the
 * daily briefing, what the AI handled, cached AI insights) moved in here
 * rather than staying duplicated on a second page; /dashboard is now a
 * redirect (see its own page.tsx). Dashboard's OTHER sections
 * (PipelineRail's stage breakdown, the "Right now"/"Last 30 days" BI recap,
 * TodaysSchedule, the raw activity feed) were dropped from here, not lost -
 * they're each better represented as their own real page now: Insights
 * (stage breakdown, BI recap, activity timeline), Schedule (today's
 * appointments, and every other day's), Money (estimates/jobs counts).
 * Duplicating them a second time here would recreate the exact "which
 * number do I trust" problem the redesign audit called out.
 *
 * Opportunities is no longer a separate primary nav destination either -
 * "By type" (TodayViewTabs) reuses the Opportunities page's own
 * OpportunitiesList component and query, unmodified, as a real view of this
 * same screen rather than a fourth place to check. /opportunities is now a
 * redirect (see its own page.tsx).
 *
 * Canonical Opportunity Intelligence Layer: the priority queue no longer
 * computes its own ordering here. It calls lib/opportunities/intelligence.ts's
 * getPrioritizedOpportunities (the real, persisted Opportunity rows, tiered
 * and explained) plus getConversationSignals/getOperationalExceptions (which
 * extract, never re-detect, the remaining Attention Engine kinds that aren't
 * revenue opportunities), then buildPriorityQueue merges the first two into
 * one ordered list. Today only renders - see that module's own header
 * comment for the full architecture. getDashboardData is still called (its
 * own AttentionItem output is unchanged and still feeds agency/briefing
 * elsewhere - untouched by this pass), just no longer read here for the 11
 * opportunity-shaped kinds it also produces; those now come from the real,
 * persisted Opportunity rows instead.
 */
export default async function TodayPage({ searchParams }: PageProps<"/today">) {
  const params = await searchParams;
  const view = normalizeView(typeof params.view === "string" ? params.view : undefined);

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

  // Same ordering reason dashboard/page.tsx's own call documented: the
  // Attention Engine and this page's own opportunity read both touch the
  // opportunities table, so this must finish before the Promise.all below
  // to avoid racing a freshly-detected opportunity on first render.
  await syncOpportunities(supabase, membership.organizationId);

  const [
    data,
    businessMetrics,
    cachedInsights,
    hotLeadCount,
    appointments,
    contacts,
    todaySnapshot,
    dailyBriefing,
    endOfDaySummary,
    opportunitiesResult,
    prioritizedOpportunities,
    estimatesResult,
    jobsResult,
    invoicesResult,
    paymentsResult,
    timeZone,
  ] = await Promise.all([
    getDashboardData(supabase, membership.organizationId),
    getDashboardBusinessMetrics(supabase, membership.organizationId),
    getCachedBusinessInsights(supabase, membership.organizationId),
    // Final completion program, Phase 13 (Performance): this used to be a
    // full getLeads() fetch (up to 1000 rows, every column) purely to
    // compute summarizeLeads(leads).hotCount below - see getHotLeadCount's
    // own comment in lib/leads/queries.ts.
    getHotLeadCount(supabase, membership.organizationId),
    getAppointments(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getBusinessMetricsSnapshot(supabase, membership.organizationId, "today"),
    getOwnerDailyBriefing(supabase, membership.organizationId),
    getEndOfDaySummary(supabase, membership.organizationId),
    getOpenOpportunitiesResult(supabase, membership.organizationId),
    // Canonical Opportunity Intelligence Layer: the one prioritized,
    // explained, actionability-checked read every consumer of "what needs
    // attention" now shares - see lib/opportunities/intelligence.ts's own
    // header comment.
    getPrioritizedOpportunities(supabase, membership.organizationId),
    // Nav-restructure pass: Money is no longer its own nav destination -
    // Estimates and Jobs are - so Dashboard now carries the one real
    // cross-entity financial snapshot itself (see lib/money/snapshot.ts's
    // own header comment for why this is the exact same computation Money's
    // own detailed page uses, not a second version of it).
    getEstimatesResult(supabase, membership.organizationId),
    getJobsResult(supabase, membership.organizationId),
    // Phase 1B-4 (Financial Visibility): the invoice/payment ledger for the
    // Collected / Invoiced / Outstanding / Overdue row below - the same
    // reads and the same summarizeInvoiceMoney computation Money's own
    // Invoices tab uses, all-time by design (Money stays all-time; Insights
    // is the period-aware view).
    getInvoicesResult(supabase, membership.organizationId),
    getCustomerPaymentsResult(supabase, membership.organizationId),
    getOrganizationTimezone(supabase, membership.organizationId),
  ]);

  const openOpportunities = opportunitiesResult.data;
  const appointmentSummary = summarizeAppointments(appointments);
  const businessName = membership.organizationName ?? "there";
  const moneySnapshot = computeMoneySnapshot(estimatesResult.data, jobsResult.data);
  const moneyDataFailed = estimatesResult.failed || jobsResult.failed || invoicesResult.failed || paymentsResult.failed;
  // "Overdue" is judged against today's date in the organization's own
  // timezone - the same calendar the issue trigger used for the due date.
  const today = calendarDateInTimeZone(new Date(), timeZone ?? "UTC");
  const invoiceSummary = summarizeInvoiceMoney({ invoices: invoicesResult.data, payments: paymentsResult.data, jobs: jobsResult.data, today });

  // Canonical Opportunity Intelligence Layer: getConversationSignals/
  // getOperationalExceptions extract, never re-detect, the Attention Engine
  // kinds that aren't revenue opportunities (a conversation waiting on a
  // reply, a broken calendar sync) from the same data.attentionItems this
  // page already fetched above - zero new queries. buildPriorityQueue merges
  // the conversation signals with the real, persisted opportunities into one
  // ordered list; operational exceptions render separately, always first,
  // never tiered alongside revenue opportunities (§8/§13 of the approved
  // design).
  const operationalExceptions = getOperationalExceptions(data.attentionItems);
  const conversationSignals = getConversationSignals(data.attentionItems);
  const priorityQueue = buildPriorityQueue(prioritizedOpportunities, conversationSignals);
  const queue: QueueEntry[] = priorityQueue.map(priorityItemToQueueEntry);
  const totalNeedingAttention = operationalExceptions.length + queue.length;

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      {/* Same disclosure discipline dashboard/page.tsx's own partialData
          notice used - a failed read here used to silently render as a
          confidently "clean" page. Covers every read this page performs
          that dashboard/page.tsx also covered (data, businessMetrics,
          dailyBriefing, endOfDaySummary); repeatCustomerSummary/
          dormantCustomersValue aren't read here at all (they fed
          Dashboard's own BusinessGlance, which moved to Insights). */}
      {data.partialData || businessMetrics.partialData || dailyBriefing.partialData || endOfDaySummary.partialData || moneyDataFailed ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
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

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div>
          {/* Nav-restructure pass: this page's own sidebar/nav label is now
              "Dashboard" (see nav-items.ts) - Today's own headline stays the
              dynamic, computed sentence it's always been ("29 things need
              you"), so this eyebrow is the one static anchor tying the two
              together, matching every other page's own eyebrow-over-title
              convention (PageHeader's own "Operate"/"Automate"/etc). */}
          <p className="mb-1.5 text-[12.5px] font-medium text-accent-text">Dashboard</p>
          <h1 className={pageTitleClass}>
            {totalNeedingAttention === 0 ? "Nothing needs you" : `${totalNeedingAttention} thing${totalNeedingAttention === 1 ? "" : "s"} need${totalNeedingAttention === 1 ? "s" : ""} you`}
          </h1>
          <p className={`mt-1.5 ${pageDescriptionClass}`}>
            {totalNeedingAttention === 0 ? `You're clear, ${businessName}.` : "Sorted by what it costs you to ignore it."}
          </p>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="sm:text-right">
            <p className="text-[12.5px] font-medium text-slate-500">Pipeline value</p>
            <p className={`mt-1 text-[32px] font-semibold tracking-tight text-slate-900 ${numericDisplayClass}`}>
              {formatCurrency(businessMetrics.pipelineMetrics.pipelineValue)}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              <Link href="/people?temperature=hot" className={hotLeadCount > 0 ? "font-semibold text-danger hover:underline" : "hover:underline"}>
                {hotLeadCount} hot {hotLeadCount === 1 ? "lead" : "leads"}
              </Link>
              <span className="mx-1.5 text-slate-300">·</span>
              <Link href="/schedule" className={appointmentSummary.today > 0 ? "font-semibold text-slate-900 hover:underline" : "hover:underline"}>
                {appointmentSummary.today} today
              </Link>
            </p>
          </div>
          {contacts.length > 0 ? (
            <div className="shrink-0">
              <AddLeadButton contacts={contacts} />
            </div>
          ) : null}
        </div>
      </div>

      {/* Nav-restructure pass: Money's own real cross-entity snapshot
          (Quotes out / Ready to schedule / Jobs in progress / Known
          opportunity value), relocated here now that Money is no longer its
          own nav destination - Estimates and Jobs are. Every card links to
          the exact real, already-supported filter on the page that owns
          that data; "Known opportunity value" is a pure metric with nowhere
          more precise to send someone, so it stays unlinked. See
          lib/money/snapshot.ts for the shared computation this and Money's
          own detailed page both read from. Moved to the top of the page,
          directly under the greeting header, so the financial snapshot is
          the first thing visible - ahead of the priority queue. */}
      <div className="border-t border-slate-200 pt-8">
        <p className={sectionLabelClass}>Money at a glance</p>
        <div className="mt-3">
          <StatGrid columns={4}>
            <StatCard
              label="Quotes out"
              value={moneySnapshot.quotesOut.length}
              description={moneySnapshot.quotesOut.length > 0 ? "Awaiting a decision" : "Nothing out right now"}
              icon={Wallet}
              href="/estimates?status=sent"
            />
            <StatCard
              label="Ready to schedule"
              value={moneySnapshot.readyToSchedule.length}
              description={moneySnapshot.readyToSchedule.length > 0 ? "Accepted, no job yet" : "Nothing waiting"}
              tone="danger"
              icon={CalendarClock}
              href="/estimates?status=accepted"
            />
            <StatCard
              label="Jobs in progress"
              value={moneySnapshot.wonNotFinished.length}
              description={moneySnapshot.wonNotFinished.length > 0 ? "Scheduled or underway" : "Nothing in progress"}
              tone="success"
              icon={Hammer}
              href="/jobs?status=in_progress"
            />
            <StatCard
              label="Known opportunity value"
              value={formatCurrency(moneySnapshot.knownOpportunityValue)}
              description="Across every quote, accepted job, and job in progress"
              icon={TrendingUp}
            />
          </StatGrid>
        </div>
        {/* Phase 1B-4: the money that was actually asked for and received -
            Collected is the customer_payments ledger net of reversals and
            is the only card in either row that is money in hand. Each card
            links to Money's own Invoices tab filtered to the same rows. */}
        <div className="mt-4">
          <InvoiceMoneySummaryCards summary={invoiceSummary} variant="dashboard" />
        </div>
      </div>

      <div>
        <TodayViewTabs active={view} opportunityCount={openOpportunities.length} />

        {view === "priority" ? (
          <div className="mt-5 flex flex-col gap-6">
            {/* Canonical Opportunity Intelligence Layer: operational
                exceptions (the AI needs a human, the calendar sync broke)
                render first and separately - they are pure safety/system
                issues with no revenue framing, never tiered or scored
                alongside opportunities (§8/§13 of the approved design). */}
            {operationalExceptions.length > 0 ? (
              <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
                {operationalExceptions.map((exception) => (
                  <QueueRow
                    key={exception.incidentId ?? `${exception.kind}-${exception.href}`}
                    tone="urgent"
                    problemLabel={ATTENTION_COPY[exception.kind].label}
                    personName={exception.title}
                    personHref={exception.href}
                    sentence={exception.detail}
                    secondaryHref={exception.href}
                    secondaryLabel="View"
                  />
                ))}
              </div>
            ) : null}

            {totalNeedingAttention === 0 ? (
              <div className={`${surfaceClass} px-6 py-14 text-center`}>
                <p className="text-base font-medium text-slate-900">Nothing needs you.</p>
                <p className="mt-1.5 text-sm text-slate-500">You&apos;re clear.</p>
              </div>
            ) : queue.length > 0 ? (
              <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
                {queue.map((entry) => (
                  <QueueRow
                    key={entry.key}
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
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-5">
            <OpportunitiesList opportunities={openOpportunities} failed={opportunitiesResult.failed} />
          </div>
        )}
      </div>

      {/* What Trackpr did today - Dashboard's own Act 3, moved here
          unchanged (same components, same data, same queries) rather than
          left on a second page nobody would think to check for it. */}
      <div className="border-t border-slate-200 pt-8">
        <div className="divide-y divide-slate-200">
          <div className="pb-8">
            <WhatAiHandled snapshot={todaySnapshot} />
          </div>
          <div className="py-8">
            <BriefingPanel briefing={dailyBriefing} endOfDay={endOfDaySummary} />
          </div>
          <div className="pt-8">
            <AiInsightsPanel cached={cachedInsights} />
          </div>
        </div>
      </div>
    </div>
  );
}
