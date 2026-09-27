import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardData, type AttentionItem } from "@/lib/dashboard/queries";
import { getDashboardBusinessMetrics, getCachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import { getBusinessMetricsSnapshot } from "@/lib/bi/metrics";
import { getOwnerDailyBriefing, getEndOfDaySummary } from "@/lib/briefing/queries";
import { getLeads, summarizeLeads } from "@/lib/leads/queries";
import { getAppointments, summarizeAppointments } from "@/lib/appointments/queries";
import { syncOpportunities } from "@/lib/opportunities/detect";
import { getOpenOpportunitiesResult, type Opportunity } from "@/lib/opportunities/queries";
import { getContacts } from "@/lib/contacts/queries";
import { contactDisplayName } from "@/lib/contacts/format";
import { formatCurrency, formatRelativeTime } from "@/lib/dashboard/format";
import { pageTitleClass, pageDescriptionClass, numericDisplayClass } from "@/lib/ui/typography";
import { QueueCard } from "@/lib/ui/queue-card";
import { surfaceClass } from "@/lib/ui/surface";
import { ATTENTION_COPY, OPPORTUNITY_ONLY_COPY } from "@/lib/today/copy";
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
  sortValue: number;
};

/** Recovers the raw number behind an AttentionItem's already-formatted "$7,200" display string - never a second, independent dollar calculation, just parsing back what formatCurrency already produced. */
function parseDisplayedCurrency(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
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
 * The priority queue itself (the original Phase 2 build) is unchanged: zero
 * new queries for it - getDashboardData().attentionItems and
 * getOpenOpportunities, sorted by cost of ignoring.
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

  const [data, businessMetrics, cachedInsights, leads, appointments, contacts, todaySnapshot, dailyBriefing, endOfDaySummary, opportunitiesResult] = await Promise.all([
    getDashboardData(supabase, membership.organizationId),
    getDashboardBusinessMetrics(supabase, membership.organizationId),
    getCachedBusinessInsights(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
    getAppointments(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getBusinessMetricsSnapshot(supabase, membership.organizationId, "today"),
    getOwnerDailyBriefing(supabase, membership.organizationId),
    getEndOfDaySummary(supabase, membership.organizationId),
    getOpenOpportunitiesResult(supabase, membership.organizationId),
  ]);

  const openOpportunities = opportunitiesResult.data;
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const leadSummary = summarizeLeads(leads);
  const appointmentSummary = summarizeAppointments(appointments);
  const businessName = membership.organizationName ?? "there";

  const attentionEntries: QueueEntry[] = data.attentionItems.map((item: AttentionItem) => {
    const copy = ATTENTION_COPY[item.kind];
    return {
      key: `attention:${item.id}`,
      tone: copy.tone,
      problemLabel: copy.label,
      // No age: AttentionItem carries no structured timestamp (see this
      // file's own header comment) - the band shows the problem alone
      // rather than a guessed or duplicated age. item.detail is still the
      // one real, correct explanation, used as the card's sentence below.
      personName: item.title,
      personHref: item.href,
      money: item.value ?? undefined,
      sentence: item.detail,
      // No contactId/phone on AttentionItem's own shape - the Call action
      // is only available for the two extra opportunity-only cards below,
      // which do carry a real contact reference. Every attention card still
      // gets its one real action (View, promoted to primary by QueueCard
      // itself when no phone is present).
      phone: null,
      secondaryHref: item.href,
      secondaryLabel: "View",
      sortValue: parseDisplayedCurrency(item.value),
    };
  });

  // The two opportunity types with no matching AttentionItem kind at all
  // (see lib/today/copy.ts's own header comment) - real signal that would
  // otherwise never surface anywhere. contactId/phone ARE available here
  // (Opportunity carries contactId; the org's already-fetched contacts
  // list resolves it to a phone), so these get a genuine Call action.
  const opportunityEntries: QueueEntry[] = openOpportunities
    .filter((opportunity: Opportunity) => OPPORTUNITY_ONLY_COPY[opportunity.type])
    .map((opportunity) => {
      const copy = OPPORTUNITY_ONLY_COPY[opportunity.type]!;
      const contact = opportunity.contactId ? contactsById.get(opportunity.contactId) : undefined;
      const personName = contact ? contactDisplayName(contact) : opportunity.title;
      const personHref = opportunity.contactId ? `/people/${opportunity.contactId}` : "/today?view=by-type";
      return {
        key: `opportunity:${opportunity.id}`,
        tone: copy.tone,
        problemLabel: copy.label,
        age: formatRelativeTime(opportunity.createdAt),
        personName,
        personHref,
        money: opportunity.estimatedValue != null ? formatCurrency(opportunity.estimatedValue) : undefined,
        // Real, already-stored description - never invented. Falls back to
        // the copy label itself on the rare row with no description, so
        // the sentence is never blank.
        sentence: opportunity.description ?? copy.label,
        phone: contact?.phone ?? null,
        secondaryHref: personHref,
        secondaryLabel: "View",
        sortValue: parseDisplayedCurrency(opportunity.estimatedValue != null ? formatCurrency(opportunity.estimatedValue) : null),
      };
    });

  const queue = [...attentionEntries, ...opportunityEntries].sort((a, b) => b.sortValue - a.sortValue);

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      {/* Same disclosure discipline dashboard/page.tsx's own partialData
          notice used - a failed read here used to silently render as a
          confidently "clean" page. Covers every read this page performs
          that dashboard/page.tsx also covered (data, businessMetrics,
          dailyBriefing, endOfDaySummary); repeatCustomerSummary/
          dormantCustomersValue aren't read here at all (they fed
          Dashboard's own BusinessGlance, which moved to Insights). */}
      {data.partialData || businessMetrics.partialData || dailyBriefing.partialData || endOfDaySummary.partialData ? (
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
          <h1 className={pageTitleClass}>{queue.length === 0 ? "Nothing needs you" : `${queue.length} thing${queue.length === 1 ? "" : "s"} need${queue.length === 1 ? "s" : ""} you`}</h1>
          <p className={`mt-1.5 ${pageDescriptionClass}`}>
            {queue.length === 0 ? `You're clear, ${businessName}.` : "Sorted by what it costs you to ignore it."}
          </p>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="sm:text-right">
            <p className="text-[12.5px] font-medium text-slate-500">Pipeline value</p>
            <p className={`mt-1 text-[32px] font-semibold tracking-tight text-slate-900 ${numericDisplayClass}`}>
              {formatCurrency(businessMetrics.pipelineMetrics.pipelineValue)}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              <Link href="/people?temperature=hot" className={leadSummary.hotCount > 0 ? "font-semibold text-danger hover:underline" : "hover:underline"}>
                {leadSummary.hotCount} hot {leadSummary.hotCount === 1 ? "lead" : "leads"}
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

      <div>
        <TodayViewTabs active={view} opportunityCount={openOpportunities.length} />

        {view === "priority" ? (
          <div className="mt-5">
            {queue.length === 0 ? (
              <div className={`${surfaceClass} px-6 py-14 text-center`}>
                <p className="text-base font-medium text-slate-900">Nothing needs you.</p>
                <p className="mt-1.5 text-sm text-slate-500">You&apos;re clear.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {queue.map((entry) => (
                  <QueueCard
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
            )}
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
