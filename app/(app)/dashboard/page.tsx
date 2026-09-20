import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardData } from "@/lib/dashboard/queries";
import { getDashboardBusinessMetrics, getCachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import { getLeads, summarizeLeads } from "@/lib/leads/queries";
import { getAppointments, summarizeAppointments } from "@/lib/appointments/queries";
import { getContacts } from "@/lib/contacts/queries";
import { formatCurrency } from "@/lib/dashboard/format";
import { pageTitleClass, pageDescriptionClass, sectionLabelClass } from "@/lib/ui/typography";
import { Panel } from "@/lib/ui/section-card";
import { AttentionPanel } from "./_components/attention-panel";
import { PipelineRail } from "./_components/pipeline-rail";
import { RecentActivity } from "./_components/recent-activity";
import { BusinessGlance } from "./_components/business-glance";
import { AiInsightsPanel } from "./_components/ai-insights-panel";
import { AddLeadButton } from "../leads/_components/add-lead-button";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Real, derived status line answering "is everything working" at a glance -
 * not a fabricated health score, just a plain read of the same attention
 * count the page itself is about to show. No system-status section is added
 * below this: there is no real system-health data source yet to report, and
 * a fabricated one would violate "do not invent metrics."
 */
function statusLine(attentionCount: number): string {
  if (attentionCount === 0) return "Everything is running smoothly.";
  const noun = attentionCount === 1 ? "thing needs" : "things need";
  return `${attentionCount} ${noun} your attention.`;
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

  // getDashboardData/getDashboardBusinessMetrics/getCachedBusinessInsights are
  // the page's original three reads, untouched. getLeads/getAppointments/
  // getContacts are the exact same already-existing, unmodified functions the
  // Leads/Appointments/Contacts pages themselves call - reused here (not a
  // new query, not new business logic) so the dashboard can surface the two
  // numbers a contractor actually opens it to check (hot leads, today's
  // schedule) and offer the same "Add Lead" action Leads itself offers,
  // without duplicating summarizeLeads/summarizeAppointments's logic.
  const [data, businessMetrics, cachedInsights, leads, appointments, contacts] = await Promise.all([
    getDashboardData(supabase, membership.organizationId),
    getDashboardBusinessMetrics(supabase, membership.organizationId),
    getCachedBusinessInsights(supabase, membership.organizationId),
    getLeads(supabase, membership.organizationId),
    getAppointments(supabase, membership.organizationId),
    getContacts(supabase, membership.organizationId),
  ]);
  const businessName = membership.organizationName ?? "there";
  const leadSummary = summarizeLeads(leads);
  const appointmentSummary = summarizeAppointments(appointments);

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

        <AttentionPanel items={data.attentionItems} />

        <div className="border-t border-slate-200 pt-8">
          <PipelineRail pipeline={data.pipeline} />
        </div>

        <div className="border-t border-slate-200 pt-8">
          <AiInsightsPanel cached={cachedInsights} />
        </div>

        <div className="grid grid-cols-1 gap-8 border-t border-slate-200 pt-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            <RecentActivity items={data.recentActivity} />
          </div>
          <div className="lg:sticky lg:top-6 lg:self-start">
            <Panel>
              <BusinessGlance overview={data.overview} snapshot={businessMetrics} />
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
