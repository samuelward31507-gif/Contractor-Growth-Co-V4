import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardData } from "@/lib/dashboard/queries";
import { getDashboardBusinessMetrics, getCachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import { formatCurrency } from "@/lib/dashboard/format";
import { pageDescriptionClass } from "@/lib/ui/typography";
import { Panel } from "@/lib/ui/section-card";
import { AttentionPanel } from "./_components/attention-panel";
import { PipelineSnapshot } from "./_components/pipeline-snapshot";
import { RecentActivity } from "./_components/recent-activity";
import { BusinessGlance } from "./_components/business-glance";
import { AiInsightsPanel } from "./_components/ai-insights-panel";

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

  const [data, businessMetrics, cachedInsights] = await Promise.all([
    getDashboardData(supabase, membership.organizationId),
    getDashboardBusinessMetrics(supabase, membership.organizationId),
    getCachedBusinessInsights(supabase, membership.organizationId),
  ]);
  const businessName = membership.organizationName ?? "there";

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      {/*
        Command header - the page's one masthead moment. The greeting sits
        beside the single number that matters most at a glance (pipeline
        value), not buried in a grid of six equally-weighted stat cards
        further down the page. Every other number on the page supports this
        one; nothing here is fabricated - pipelineValue is the same real
        figure the old KeyMetrics grid showed, just promoted to lead the page
        instead of competing inside it.
      */}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-slate-200 pb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
            {greeting()}, {businessName}.
          </h1>
          <p className={`mt-1.5 ${pageDescriptionClass}`}>{statusLine(data.attentionItems.length)}</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Pipeline value</p>
          <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums text-slate-900">
            {formatCurrency(businessMetrics.pipelineMetrics.pipelineValue)}
          </p>
        </div>
      </div>

      {/*
        Asymmetric body, not a stack of full-width sections: a wide main
        column carries what needs a decision (Attention, AI insights, the
        pipeline shape); a narrower, contained rail on the right carries
        reference numbers and the activity feed - the one boxed panel on the
        page, deliberately, so it reads as "look this up" detail rather than
        competing with the main column's flush, flowing content for
        attention.
      */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-8">
          <AttentionPanel items={data.attentionItems} />
          <AiInsightsPanel cached={cachedInsights} />
          <div className="border-t border-slate-200 pt-8">
            <PipelineSnapshot pipeline={data.pipeline} />
          </div>
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          <Panel>
            <BusinessGlance overview={data.overview} snapshot={businessMetrics} />
            <div className="mt-5 border-t border-slate-200 pt-5">
              <RecentActivity items={data.recentActivity} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
