import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardData } from "@/lib/dashboard/queries";
import { getOwnerDailyBriefing, getEndOfDaySummary } from "@/lib/briefing/queries";
import { getDashboardBusinessMetrics, getCachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import { getBusinessMetricsSnapshot } from "@/lib/bi/metrics";
import { getOrganizationHealth } from "@/lib/automation-health/health";
import { getLeads, summarizeLeads } from "@/lib/leads/queries";
import { getAppointments, summarizeAppointments } from "@/lib/appointments/queries";
import { getContacts } from "@/lib/contacts/queries";
import { isSameCalendarDay } from "@/lib/appointments/format";
import { syncOpportunities } from "@/lib/opportunities/detect";
import { getOpenOpportunities, summarizeOpportunities } from "@/lib/opportunities/queries";
import { formatCurrency } from "@/lib/dashboard/format";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass } from "@/lib/ui/typography";
import { Panel } from "@/lib/ui/section-card";
import { AttentionPanel } from "./_components/attention-panel";
import { PipelineRail } from "./_components/pipeline-rail";
import { TodaysSchedule } from "./_components/todays-schedule";
import { RecentActivity } from "./_components/recent-activity";
import { BusinessGlance } from "./_components/business-glance";
import { AiInsightsPanel } from "./_components/ai-insights-panel";
import { SystemStatus } from "./_components/system-status";
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
  // without duplicating summarizeLeads/summarizeAppointments's logic.
  // getOrganizationHealth is the exact same deterministic health read the
  // Agency Command Center and /automation-health already use - no second
  // health model. The "today" snapshot reuses the exact same
  // getBusinessMetricsSnapshot the rest of this page already calls (with
  // "last30Days"), just a different real date-range preset - not a new
  // metrics engine.
  const [data, businessMetrics, cachedInsights, leads, appointments, contacts, health, todaySnapshot, dailyBriefing, endOfDaySummary, openOpportunities] = await Promise.all([
    getDashboardData(supabase, membership.organizationId),
    getDashboardBusinessMetrics(supabase, membership.organizationId),
    getCachedBusinessInsights(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
    getAppointments(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
    getOrganizationHealth(supabase, membership.organizationId),
    getBusinessMetricsSnapshot(supabase, membership.organizationId, "today"),
    getOwnerDailyBriefing(supabase, membership.organizationId),
    getEndOfDaySummary(supabase, membership.organizationId),
    // Pass 3: the just-synced, all-5-type open opportunity set - read here
    // rather than re-derived, so BusinessGlance's opportunity count and
    // getDashboardData's Attention Engine items above always agree.
    getOpenOpportunities(supabase, membership.organizationId),
  ]);
  const opportunitySummary = summarizeOpportunities(openOpportunities);
  const businessName = membership.organizationName ?? "there";
  const leadSummary = summarizeLeads(leads);
  const appointmentSummary = summarizeAppointments(appointments);
  const now = new Date();
  const todaysAppointments = appointments.filter((appointment) => isSameCalendarDay(new Date(appointment.start_at), now));
  const lastLeadCapturedAt = leads[0]?.created_at ?? null;

  return (
    <div className="flex flex-1 flex-col">
      {/* Light workspace body - the dashboard used to open with a separate
          dark command header; it now flows directly into the same light
          page-header convention every other route uses, just with the
          Pipeline Value figure and Add Lead action alongside it. */}
      <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-6">
          <div>
            <p className={sectionLabelClass}>Dashboard</p>
            <h1 className={`mt-1.5 ${pageTitleClass}`}>
              {greeting()}, {businessName}.
            </h1>
            <p className={`mt-1.5 ${pageDescriptionClass}`}>{statusLine(data.attentionItems.length)}</p>
          </div>
          <div className="flex items-start gap-6">
            <div className="text-right">
              <p className={sectionLabelClass}>Pipeline value</p>
              <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-slate-900">
                {formatCurrency(businessMetrics.pipelineMetrics.pipelineValue)}
              </p>
              {/* Real breakdown, not a fabricated one - the same two counts
                  a contractor opens the dashboard to check, reused from
                  Leads/Appointments' own summarize functions rather than two
                  large cards competing with Needs Attention below. */}
              <p className="mt-1.5 text-sm text-slate-500">
                <Link
                  href="/leads?temperature=hot"
                  className={leadSummary.hotCount > 0 ? "font-medium text-red-600 hover:underline" : "hover:text-slate-900"}
                >
                  {leadSummary.hotCount} hot {leadSummary.hotCount === 1 ? "lead" : "leads"}
                </Link>
                <span className="mx-1.5 text-slate-300">·</span>
                <Link
                  href="/appointments?view=today"
                  className={appointmentSummary.today > 0 ? "font-medium text-accent-text hover:underline" : "hover:text-slate-900"}
                >
                  {appointmentSummary.today} today
                </Link>
              </p>
            </div>
            {contacts.length > 0 ? <AddLeadButton contacts={contacts} /> : null}
          </div>
        </div>

        {/* Section order follows Phase 2's priority (attention, pipeline,
            today, activity, system status, AI) on desktop - the natural DOM
            order below. On mobile, System Status moves to right after the
            greeting (Phase 12) via the order-* overrides, since a contractor
            glancing at their phone wants "is everything working" before
            scrolling into specifics; the AI insights panel stays last at
            every width, since it isn't part of the core priority list. */}
        <div className="order-2 border-t border-slate-200 pt-8 lg:order-none lg:border-t-0 lg:pt-0">
          <AttentionPanel items={data.attentionItems} />
        </div>

        <div className="order-3 border-t border-slate-200 pt-8 lg:order-none">
          <PipelineRail pipeline={data.pipeline} hasNeverHadLeads={leads.length === 0} />
        </div>

        <div className="order-4 border-t border-slate-200 pt-8 lg:order-none">
          <TodaysSchedule appointments={todaysAppointments} />
        </div>

        <div className="order-4 border-t border-slate-200 pt-8 lg:order-none">
          <BriefingPanel briefing={dailyBriefing} endOfDay={endOfDaySummary} />
        </div>

        <div className="order-4 border-t border-slate-200 pt-8 lg:order-none">
          <WhatAiHandled snapshot={todaySnapshot} />
        </div>

        <div className="order-5 grid grid-cols-1 gap-8 border-t border-slate-200 pt-8 lg:order-none lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            <RecentActivity items={data.recentActivity} />
          </div>
          <div className="lg:sticky lg:top-6 lg:self-start">
            <Panel>
              <BusinessGlance overview={data.overview} snapshot={businessMetrics} opportunitySummary={opportunitySummary} />
            </Panel>
          </div>
        </div>

        <div className="order-1 pt-0 lg:order-none lg:border-t lg:border-slate-200 lg:pt-8">
          <SystemStatus
            status={health.status}
            lastLeadCapturedAt={lastLeadCapturedAt}
            automationActivityToday={todaySnapshot.automationMetrics.automationEvents}
            issuesRequiringAttention={health.activeIncidentCount}
          />
        </div>

        <div className="order-6 border-t border-slate-200 pt-8 lg:order-none">
          <AiInsightsPanel cached={cachedInsights} />
        </div>
      </div>
    </div>
  );
}
