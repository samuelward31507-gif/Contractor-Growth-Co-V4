import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardData } from "@/lib/dashboard/queries";
import { getOwnerDailyBriefing, getEndOfDaySummary } from "@/lib/briefing/queries";
import { getDashboardBusinessMetrics, getCachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import { getBusinessMetricsSnapshot } from "@/lib/bi/metrics";
import { getLeads, summarizeLeads } from "@/lib/leads/queries";
import { getAppointments, summarizeAppointments } from "@/lib/appointments/queries";
import { getJobs } from "@/lib/jobs/queries";
import { getContacts } from "@/lib/contacts/queries";
import { isSameCalendarDay } from "@/lib/appointments/format";
import { syncOpportunities } from "@/lib/opportunities/detect";
import { getOpenOpportunities, summarizeOpportunities } from "@/lib/opportunities/queries";
import { getRepeatCustomerSummaryResult, getDormantCustomersValueSummaryResult } from "@/lib/customers/lifecycle";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { formatCurrency } from "@/lib/dashboard/format";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass, metaClass, numericDisplayClass } from "@/lib/ui/typography";
import { AttentionPanel } from "./_components/attention-panel";
import { PipelineRail } from "./_components/pipeline-rail";
import { TodaysSchedule } from "./_components/todays-schedule";
import { OperationalStrip } from "./_components/operational-strip";
import { RecentActivity } from "./_components/recent-activity";
import { BusinessGlance } from "./_components/business-glance";
import { AiInsightsPanel } from "./_components/ai-insights-panel";
import { BriefingPanel } from "./_components/briefing-panel";
import { WhatAiHandled } from "./_components/what-ai-handled";
import { AddLeadButton } from "../leads/_components/add-lead-button";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Trackpr 2.0, Phase 3B: purely presentational date context for the
 * redesigned header - formats the same `now` the page already computes for
 * the timezone-aware "today" appointment filter (see the org-timezone
 * comment further down), never a second clock or a new data source.
 */
function formattedDate(now: Date): string {
  return now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/**
 * A stable framing line, not a restatement of the exact attention count -
 * AttentionPanel immediately below already shows the specifics (or its own
 * "You're all caught up" empty state), so the header doesn't need to repeat
 * that number a second time.
 */
function statusLine(attentionCount: number): string {
  return attentionCount === 0 ? "You're all caught up." : "Here's what needs your attention today.";
}

export default async function DashboardPage() {
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

  // Pass 3 (Revenue Intelligence Foundation): runs synchronously, before the
  // page's own Promise.all below, because getDashboardData's Attention
  // Engine (stale_estimate/dormant_customer/no_show items) and this page's
  // own opportunity summary both read the opportunities table - running
  // sync in parallel with those reads would race and could momentarily
  // miss a freshly-detected opportunity on its own first render. There is
  // no new cron/scheduled route in this pass - this "compute/refresh on
  // read" shape matches the dashboard's pre-existing attention items.
  await syncOpportunities(supabase, membership.organizationId);

  // getDashboardData/getDashboardBusinessMetrics/getCachedBusinessInsights are
  // the page's original three reads, untouched. getLeads/getAppointments/
  // getContacts are the exact same already-existing, unmodified functions the
  // Leads/Appointments/Contacts pages themselves call - reused here (not a
  // new query, not new business logic) so the dashboard can surface the two
  // numbers a contractor actually opens it to check (hot leads, today's
  // schedule) and offer the same "Add Lead" action Leads itself offers,
  // without duplicating summarizeLeads/summarizeAppointments's logic. The
  // "today" snapshot reuses the exact same getBusinessMetricsSnapshot the
  // rest of this page already calls (with "last30Days"), just a different
  // real date-range preset - not a new metrics engine.
  //
  // Trackpr 2.0, Phase 2A: getOrganizationHealth is no longer called here -
  // its only consumer on this page was the dashboard-body SystemStatus
  // section, now removed (the top bar's own independent getOrganizationHealth
  // call in app/(app)/_components/top-bar.tsx already shows this globally on
  // every page, per the locked Phase 2 decision - see system-status.tsx's own
  // header comment for what happened to that component). This is plain
  // dead-code removal following from the section's removal, not a query
  // architecture change - the audit's other 3 redundant getOrganizationHealth/
  // getDashboardData calls (inside TopBar, getOwnerDailyBriefing,
  // getEndOfDaySummary) are untouched, per this phase's explicit "do not
  // optimize performance" instruction.
  // getOrganizationTimezone is the exact same small, focused read the two
  // Appointments pages already use for display - reused here so "today"
  // below is decided in the organization's own configured timezone rather
  // than the server's, instead of a second, divergent timezone mechanism.
  const [data, businessMetrics, cachedInsights, leads, appointments, jobs, contacts, organizationTimezone, todaySnapshot, dailyBriefing, endOfDaySummary, openOpportunities] = await Promise.all([
    getDashboardData(supabase, membership.organizationId),
    getDashboardBusinessMetrics(supabase, membership.organizationId),
    getCachedBusinessInsights(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
    getAppointments(supabase, membership.organizationId),
    // Usability audit fix (#3, Dashboard operational strip): the exact same
    // getJobs() every other page (Customers, Work) already calls - reused
    // here only to compute a live "active jobs" count (status in
    // scheduled/in_progress), matching the same live-status-count shape
    // OverviewMetrics.pendingEstimates already uses, rather than a 30-day
    // range-scoped BI figure that would undercount an older still-active job.
    getJobs(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getOrganizationTimezone(supabase, membership.organizationId),
    getBusinessMetricsSnapshot(supabase, membership.organizationId, "today"),
    getOwnerDailyBriefing(supabase, membership.organizationId),
    getEndOfDaySummary(supabase, membership.organizationId),
    // Pass 3: the just-synced, all-5-type open opportunity set - read here
    // rather than re-derived, so BusinessGlance's opportunity count and
    // getDashboardData's Attention Engine items above always agree.
    getOpenOpportunities(supabase, membership.organizationId),
  ]);
  const opportunitySummary = summarizeOpportunities(openOpportunities);
  const activeJobsCount = jobs.filter((job) => job.status === "scheduled" || job.status === "in_progress").length;

  // Pass 4 P1-B: dormant contact ids come from the page's own already-fetched
  // openOpportunities - never a second detection pass. Both reads below are
  // single, ungrouped jobs fetches (no join fanout), matching lib/customers/
  // lifecycle.ts's own established "one fetch + in-memory aggregation"
  // shape.
  const dormantContactIds = [...new Set(openOpportunities.filter((o) => o.type === "dormant_customer" && o.contactId != null).map((o) => o.contactId as string))];
  const [repeatCustomerSummary, dormantCustomersValue] = await Promise.all([
    getRepeatCustomerSummaryResult(supabase, membership.organizationId),
    getDormantCustomersValueSummaryResult(supabase, membership.organizationId, dormantContactIds),
  ]);

  const businessName = membership.organizationName ?? "there";
  const leadSummary = summarizeLeads(leads);
  const appointmentSummary = summarizeAppointments(appointments);
  const now = new Date();
  // Trackpr 2.0, Phase 2A: passes the organization's own configured timezone
  // (undefined for an org that hasn't set one - isSameCalendarDay's own
  // documented fallback to runtime-local, unchanged) - previously omitted
  // entirely, so "today" was decided in whatever timezone the server process
  // happened to run in, not the contractor's own. Fixes a real near-midnight
  // boundary mismatch without introducing a second timezone mechanism.
  const todaysAppointments = appointments.filter((appointment) => isSameCalendarDay(new Date(appointment.start_at), now, organizationTimezone));

  return (
    <div className="flex flex-1 flex-col">
      {/* Light workspace body - the dashboard used to open with a separate
          dark command header; it now flows directly into the same light
          page-header convention every other route uses, just with the
          Pipeline Value figure and Add Lead action alongside it. */}
      <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        {/* Trackpr 2.0, Phase 2B: a calm, non-alarming notice for the one
            real trust gap the audit found - a failed read on leads/
            appointments/estimates/audit_log/automation_incidents used to
            silently render as "there's nothing here," including a possible
            false "You're all caught up." This never claims the system is
            down and never shows a raw error - see DashboardData.partialData's
            own doc comment for exactly what it does and doesn't cover.
            Trackpr 2.0, Phase 3B: restyled onto the app's own warning tokens
            (established in Phase 3A, previously unused anywhere) instead of
            a bare slate box - still calm, never red/alarming, just legible
            as a real notice rather than blending into ordinary body text.
            Trackpr 2.0, Phase 4B (P1 #2): also covers businessMetrics'
            (getDashboardBusinessMetrics/getBusinessMetricsSnapshot) own
            partialData - the Pipeline Value figure rendered just below reads
            directly from that snapshot, so a failure there deserves the
            exact same disclosure as a failure on this page's own 5 direct
            reads, not a second, separate banner.
            Trackpr 2.0, Phase 4C (P2 #1): also covers repeatCustomerSummary/
            dormantCustomersValue's own failed signal - a failure there would
            otherwise render as a false "0 repeat customers"/"$0 dormant
            value" in the Customers section below.
            Trackpr 2.0, Phase 4C (P2 #2): also covers dailyBriefing/
            endOfDaySummary's own partialData - a failure there would
            otherwise render as a confidently "clean" briefing sentence built
            on incomplete data. */}
        {data.partialData || businessMetrics.partialData || repeatCustomerSummary.failed || dormantCustomersValue.failed || dailyBriefing.partialData || endOfDaySummary.partialData ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm text-warning-text">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              Some dashboard information may be temporarily unavailable.{" "}
              <Link href="/dashboard" className="font-medium underline decoration-warning-text/40 underline-offset-2 hover:decoration-warning-text">
                Refresh to try again
              </Link>
              .
            </p>
          </div>
        ) : null}

        {/* Trackpr 2.0 full redesign: the approved concept's header - a
            plain date line (no boxed eyebrow), the greeting, and Pipeline
            Value as large typographic display (no bordered/tinted callout
            box - the "giant colored KPI tile" the redesign brief called out
            to avoid) sitting directly above the hot-leads/today line it
            explains, right-aligned so it reads together with the Pipeline
            section below it rather than as a competing card. Exact
            calculation, currency handling, and the two hot/today links
            (same hrefs, same summarize functions) are unchanged - only the
            presentation. */}
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className={metaClass}>{formattedDate(now)}</p>
            <h1 className={`mt-1.5 ${pageTitleClass}`}>
              {greeting()}, {businessName}.
            </h1>
            <p className={`mt-1.5 ${pageDescriptionClass}`}>{statusLine(data.attentionItems.length)}</p>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="sm:text-right">
              <p className="text-[12.5px] font-medium text-slate-500">Pipeline value</p>
              <p className={`mt-1 text-[32px] font-semibold tracking-tight text-slate-900 ${numericDisplayClass}`}>
                {formatCurrency(businessMetrics.pipelineMetrics.pipelineValue)}
              </p>
              {/* Real breakdown, not a fabricated one - the same two counts
                  a contractor opens the dashboard to check, reused from
                  Leads/Appointments' own summarize functions rather than two
                  large cards competing with Needs Attention below. */}
              <p className="mt-1 text-sm text-slate-500">
                <Link
                  href="/leads?temperature=hot"
                  className={leadSummary.hotCount > 0 ? "font-semibold text-danger hover:underline" : "hover:underline"}
                >
                  {leadSummary.hotCount} hot {leadSummary.hotCount === 1 ? "lead" : "leads"}
                </Link>
                <span className="mx-1.5 text-slate-300">·</span>
                <Link href="/appointments?view=today" className={appointmentSummary.today > 0 ? "font-semibold text-slate-900 hover:underline" : "hover:underline"}>
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

        {/* Navigation/dashboard simplification pass: the page now reads as
            three deliberately ordered acts - what needs you, where the
            business is heading, and what Trackpr already handled - instead
            of a flat stack of same-weight sections. Every subcomponent,
            query, and href below is unchanged from the prior structure; only
            the grouping and section framing moved. Act 1 shows at most 3
            attention items open by default (AttentionPanel's own
            `previewCount`) with the rest one click away, never dropped. */}
        <section className="border-t border-slate-200 pt-8">
          <AttentionPanel items={data.attentionItems} heading="What needs you" previewCount={3} />
        </section>

        {/* Act 2, "Where you're going": the forward-looking half of the
            daily story - current pipeline shape, what's on the schedule,
            and the compact operational counts - grouped under one narrative
            heading instead of appearing as disconnected full-width
            sections. Same PipelineRail/OperationalStrip/TodaysSchedule
            components, same data, same hrefs. */}
        <section aria-labelledby="dashboard-heading-heading" className="border-t border-slate-200 pt-8">
          <h2 id="dashboard-heading-heading" className={sectionLabelClass}>
            Where you&apos;re going
          </h2>
          <div className="mt-5">
            <PipelineRail pipeline={data.pipeline} hasNeverHadLeads={leads.length === 0} />
          </div>
          <div className="mt-8 border-t border-slate-200 pt-8">
            <OperationalStrip todayCount={appointmentSummary.today} estimatesAwaitingCount={data.overview.pendingEstimates} activeJobsCount={activeJobsCount} />
            <div className="mt-6">
              <TodaysSchedule appointments={todaysAppointments} timeZone={organizationTimezone} />
            </div>
          </div>
          <div className="mt-8 max-w-2xl border-t border-slate-200 pt-8">
            <BusinessGlance
              overview={data.overview}
              snapshot={businessMetrics}
              opportunitySummary={opportunitySummary}
              repeatCustomerSummary={repeatCustomerSummary}
              dormantCustomerCount={dormantContactIds.length}
              dormantCustomersValue={dormantCustomersValue}
            />
          </div>
        </section>

        {/* Act 3, "What Trackpr did": everything that's a record of work
            already done on the contractor's behalf - AI handling, the daily/
            end-of-day briefing, the activity log, and cached AI insights -
            rather than a generic "More" catch-all. Same components, same
            data, same flush divider convention already used elsewhere on
            this page and across the app (Growth, Analytics section
            groups). */}
        <section aria-labelledby="dashboard-did-heading" className="border-t border-slate-200 pt-8">
          <h2 id="dashboard-did-heading" className={sectionLabelClass}>
            What Trackpr did
          </h2>

          <div className="mt-5 divide-y divide-slate-200">
            <div className="pb-8">
              <WhatAiHandled snapshot={todaySnapshot} />
            </div>

            <div className="py-8">
              <BriefingPanel briefing={dailyBriefing} endOfDay={endOfDaySummary} />
            </div>

            <div className="py-8">
              <RecentActivity items={data.recentActivity} />
            </div>

            <div className="pt-8">
              <AiInsightsPanel cached={cachedInsights} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
