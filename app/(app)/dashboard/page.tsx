import { redirect } from "next/navigation";
import { getUserOrganization } from "@/lib/auth/organization";
import { createClient } from "@/lib/supabase/server";
import { getDashboardData } from "@/lib/dashboard/queries";
import { OverviewCards } from "./_components/overview-cards";
import { AttentionPanel } from "./_components/attention-panel";
import { PipelineSnapshot } from "./_components/pipeline-snapshot";
import { RecentActivity } from "./_components/recent-activity";
import { QuickActions } from "./_components/quick-actions";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
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

  const data = await getDashboardData(supabase, membership.organizationId);
  const businessName = membership.organizationName ?? "there";

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          {greeting()}, {businessName}.
        </h1>
        <p className="mt-1 text-sm text-slate-500">Here&apos;s what needs your attention today.</p>
      </div>

      <OverviewCards overview={data.overview} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AttentionPanel items={data.attentionItems} />
        </div>
        <QuickActions />
      </div>

      <PipelineSnapshot pipeline={data.pipeline} />

      <RecentActivity items={data.recentActivity} />
    </div>
  );
}
