import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardData } from "@/lib/dashboard/queries";
import { getDashboardBusinessMetrics, getCachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import { pageTitleClass, pageDescriptionClass } from "@/lib/ui/typography";
import { OverviewStrip } from "./_components/overview-strip";
import { AttentionPanel } from "./_components/attention-panel";
import { PipelineSnapshot } from "./_components/pipeline-snapshot";
import { RecentActivity } from "./_components/recent-activity";
import { KeyMetrics } from "./_components/key-metrics";
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

  // getDashboardData's existing overview/pipeline/attention/activity
  // calculations are untouched by this phase (see lib/dashboard/business-metrics.ts's
  // header comment) - the two new BI-sourced reads below are simply additional,
  // independent queries alongside it, not a replacement for it.
  const [data, businessMetrics, cachedInsights] = await Promise.all([
    getDashboardData(supabase, membership.organizationId),
    getDashboardBusinessMetrics(supabase, membership.organizationId),
    getCachedBusinessInsights(supabase, membership.organizationId),
  ]);
  const businessName = membership.organizationName ?? "there";

  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <div>
        <h1 className={pageTitleClass}>
          {greeting()}, {businessName}.
        </h1>
        <p className={`mt-1.5 ${pageDescriptionClass}`}>{statusLine(data.attentionItems.length)}</p>
      </div>

      <AttentionPanel items={data.attentionItems} />

      <OverviewStrip overview={data.overview} />

      <KeyMetrics snapshot={businessMetrics} />

      <AiInsightsPanel cached={cachedInsights} />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <PipelineSnapshot pipeline={data.pipeline} />
        <RecentActivity items={data.recentActivity} />
      </div>
    </div>
  );
}
