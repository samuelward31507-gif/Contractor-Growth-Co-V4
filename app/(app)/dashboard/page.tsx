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
import { getContacts } from "@/lib/contacts/queries";
import { isSameCalendarDay } from "@/lib/appointments/format";
import { syncOpportunities } from "@/lib/opportunities/detect";
import { getOpenOpportunities, summarizeOpportunities } from "@/lib/opportunities/queries";
import { getRepeatCustomerSummaryResult, getDormantCustomersValueSummaryResult } from "@/lib/customers/lifecycle";
import { getOrganizationTimezone } from "@/lib/settings/queries";
import { formatCurrency } from "@/lib/dashboard/format";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass } from "@/lib/ui/typography";
import { Panel } from "@/lib/ui/section-card";
import { AttentionPanel } from "./_components/attention-panel";
import { PipelineRail } from "./_components/pipeline-rail";
import { TodaysSchedule } from "./_components/todays-schedule";
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
  const [data, businessMetrics, cachedInsights, leads, appointments, contacts, organizationTimezone, todaySnapshot, dailyBriefing, endOfDaySummary, openOpportunities] = await Promise.all([
    getDashboardData(supabase, membership.organizationId),
    getDashboardBusinessMetrics(supabase, membership.organizationId),
    getCachedBusinessInsights(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
    getAppointments(supabase, membership.organizationId),
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

        {/* Trackpr 2.0, Phase 3B: the header redesign - same greeting/status
            data as before, now with a real date line (purely presentational,
            formatted from the same `now` already computed below for the
            timezone-aware schedule filter - no new clock, no new data), and
            Pipeline Value promoted from a bare right-aligned number to a
            tone-tinted callout so it reads as the page's one primary
            business metric, not a stat competing quietly with everything
            else. The exact calculation, currency handling, and the two
            hot/today links (same hrefs, same summarize functions) are
            completely unchanged. */}
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className={sectionLabelClass}>Dashboard · {formattedDate(now)}</p>
            <h1 className={`mt-1.5 ${pageTitleClass}`}>
              {greeting()}, {businessName}.
            </h1>
            <p className={`mt-1.5 ${pageDescriptionClass}`}>{statusLine(data.attentionItems.length)}</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="rounded-xl border border-accent-border bg-accent-muted/60 px-5 py-4 sm:min-w-[240px]">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-accent-text/70">Pipeline value</p>
              <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-accent-text">
                {formatCurrency(businessMetrics.pipelineMetrics.pipelineValue)}
              </p>
              {/* Real breakdown, not a fabricated one - the same two counts
                  a contractor opens the dashboard to check, reused from
                  Leads/Appointments' own summarize functions rather than two
                  large cards competing with Needs Attention below. */}
              <p className="mt-2 text-sm text-accent-text/80">
                <Link
                  href="/leads?temperature=hot"
                  className={leadSummary.hotCount > 0 ? "font-semibold text-red-600 hover:underline" : "hover:underline"}
                >
                  {leadSummary.hotCount} hot {leadSummary.hotCount === 1 ? "lead" : "leads"}
                </Link>
                <span className="mx-1.5 text-accent-text/30">·</span>
                <Link href="/appointments?view=today" className={appointmentSummary.today > 0 ? "font-semibold hover:underline" : "hover:underline"}>
                  {appointmentSummary.today} today
                </Link>
              </p>
            </div>
            {contacts.length > 0 ? (
              <div className="shrink-0 sm:pt-1">
                <AddLeadButton contacts={contacts} />
              </div>
            ) : null}
          </div>
        </div>

        {/* Trackpr 2.0, Phase 2A: the locked dashboard hierarchy - Needs Your
            Attention, then Today's Schedule, then Pipeline Snapshot, then
            secondary/More - expressed directly as DOM order, identical on
            every screen width. This replaces the previous mobile-only
            "order" utility class overrides (which put System Status first on
            mobile only, and Pipeline before Schedule everywhere) - a real,
            audited mismatch with this same locked hierarchy. Real DOM order
            needs no override classes to keep mobile and desktop in
            agreement, so none remain. System Status itself is gone from this
            page entirely - the top bar already shows system health globally
            (see system-status.tsx's own header comment). */}
        <div className="border-t border-slate-200 pt-8 lg:border-t-0 lg:pt-0">
          <AttentionPanel items={data.attentionItems} />
        </div>

        <div className="border-t border-slate-200 pt-8">
          <TodaysSchedule appointments={todaysAppointments} timeZone={organizationTimezone} />
        </div>

        <div className="border-t border-slate-200 pt-8">
          <PipelineRail pipeline={data.pipeline} hasNeverHadLeads={leads.length === 0} />
        </div>

        {/* More / secondary information: everything real and useful that
            isn't one of the three priority sections above - composed from
            existing components only, no new visual system. A real <h2> so
            it reads as its own labeled region, not an unlabeled continuation
            of Pipeline Snapshot.
            Trackpr 2.0, Phase 2B: What AI Handled moved to the front of this
            region (previously between Briefing and Recent Activity/Business
            Glance) - the audit's own product-completeness test found it was
            the least likely section to be seen in a quick scan, despite
            being one of the clearest expressions of Trackpr's own AI
            differentiation. Same component, same data, no new query - only
            its position within the unchanged 4-section top-level hierarchy
            (Attention/Schedule/Pipeline/More) changed.
            Trackpr 2.0, Phase 3B: every subsection is now wrapped in the
            same bordered Panel container Business Glance already used on
            its own - previously the only inconsistency in this region (four
            subsections sat flush on the canvas, one sat in a card). Boxing
            all of them gives "More" its own consistent, secondary-tier
            visual identity (quieter, contained) versus Attention/Schedule/
            Pipeline above (dominant, flush-on-canvas) - reinforcing the
            existing primary/secondary hierarchy through container treatment,
            not new sections or reordering. No collapsible interaction was
            added - no existing pattern for it in this codebase, and adding
            new client-side state for a foundation this narrow isn't
            "extremely low-risk" per this phase's own instruction. */}
        <section aria-labelledby="dashboard-more-heading" className="border-t border-slate-200 pt-8">
          <h2 id="dashboard-more-heading" className={sectionLabelClass}>
            More
          </h2>

          <div className="mt-5 flex flex-col gap-6">
            <Panel>
              <WhatAiHandled snapshot={todaySnapshot} />
            </Panel>

            <Panel>
              <BriefingPanel briefing={dailyBriefing} endOfDay={endOfDaySummary} />
            </Panel>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <Panel className="min-w-0">
                <RecentActivity items={data.recentActivity} />
              </Panel>
              <div className="lg:sticky lg:top-6 lg:self-start">
                <Panel>
                  <BusinessGlance
                    overview={data.overview}
                    snapshot={businessMetrics}
                    opportunitySummary={opportunitySummary}
                    repeatCustomerSummary={repeatCustomerSummary}
                    dormantCustomerCount={dormantContactIds.length}
                    dormantCustomersValue={dormantCustomersValue}
                  />
                </Panel>
              </div>
            </div>

            <Panel>
              <AiInsightsPanel cached={cachedInsights} />
            </Panel>
          </div>
        </section>
      </div>
    </div>
  );
}
