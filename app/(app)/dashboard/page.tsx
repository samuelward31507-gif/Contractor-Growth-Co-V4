import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardData } from "@/lib/dashboard/queries";
import { getDashboardBusinessMetrics, getCachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import { getLeads, summarizeLeads } from "@/lib/leads/queries";
import { getAppointments, summarizeAppointments } from "@/lib/appointments/queries";
import { getContacts } from "@/lib/contacts/queries";
import { formatCurrency } from "@/lib/dashboard/format";
import { Panel } from "@/lib/ui/section-card";
import { AttentionPanel } from "./_components/attention-panel";
import { PipelineRail } from "./_components/pipeline-rail";
import { RecentActivity } from "./_components/recent-activity";
import { BusinessGlance } from "./_components/business-glance";
import { AiInsightsPanel } from "./_components/ai-insights-panel";
import { UrgentDuo } from "./_components/urgent-duo";
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
      {/*
        Command header - the marketing site's own dark surface (radial
        emerald glow + faint technical grid, see
        app/(marketing)/_components/home/hero.tsx) brought into the product
        itself, so opening the dashboard reads as "the same brand," not a
        recolored admin panel. This is the one dark moment in the workspace
        outside the sidebar - deliberately not repeated on every page.
      */}
      <div className="relative overflow-hidden bg-[#0a120f] px-4 py-10 sm:px-6 sm:py-12 lg:px-10">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_15%_-20%,rgba(16,185,129,0.16),transparent)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(to_right,#fff_1px,transparent_1px),linear-gradient(to_bottom,#fff_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_80%_70%_at_20%_0%,black,transparent)]"
        />
        <div className="relative flex flex-wrap items-end justify-between gap-x-8 gap-y-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-400">Dashboard</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {greeting()}, {businessName}.
            </h1>
            <p className="mt-2 text-[15px] text-slate-300">{statusLine(data.attentionItems.length)}</p>
          </div>
          <div className="flex items-center gap-6">
            <div className="text-right">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Pipeline value</p>
              <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-white sm:text-4xl">
                {formatCurrency(businessMetrics.pipelineMetrics.pipelineValue)}
              </p>
            </div>
            {contacts.length > 0 ? <AddLeadButton contacts={contacts} /> : null}
          </div>
        </div>
      </div>

      {/* Light workspace body. */}
      <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <UrgentDuo hotLeadCount={leadSummary.hotCount} todayAppointmentCount={appointmentSummary.today} />

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
