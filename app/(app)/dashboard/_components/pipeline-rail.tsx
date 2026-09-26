import Link from "next/link";
import { Inbox, PhoneCall, ListChecks, CalendarCheck2, FileCheck2, Trophy, type LucideIcon } from "lucide-react";
import { sectionLabelClass } from "@/lib/ui/typography";
import { PIPELINE_STAGES, type PipelineCounts } from "@/lib/dashboard/queries";

const STAGE_ICON: Record<string, LucideIcon> = {
  new: Inbox,
  contacted: PhoneCall,
  qualified: ListChecks,
  appointment: CalendarCheck2,
  estimate: FileCheck2,
  won: Trophy,
};

/**
 * The dashboard's pipeline, presented as a single connected sequence - the
 * same "line running through opaque-background nodes" construction the
 * Contractor Growth Co. marketing site uses for its own system diagrams
 * (see app/(marketing)/_components/system-rail.tsx) - not six disconnected
 * StatCards. A stage lights up emerald only when it actually holds at least
 * one real lead right now; every count is read straight from PipelineCounts
 * (lib/dashboard/queries.ts), nothing here is estimated or invented.
 */
export function PipelineRail({ pipeline, hasNeverHadLeads }: { pipeline: PipelineCounts; hasNeverHadLeads?: boolean }) {
  const total = PIPELINE_STAGES.reduce((sum, { stage }) => sum + pipeline[stage], 0);

  return (
    <div>
      <h2 className={sectionLabelClass}>Pipeline</h2>
      {total === 0 ? (
        hasNeverHadLeads ? (
          <p className="mt-3 text-sm text-slate-500">
            Your system is ready.{" "}
            <Link href="/onboarding" className="font-medium text-slate-900 hover:underline">
              Send a test lead
            </Link>{" "}
            to see it in action.
          </p>
        ) : (
          <p className="mt-3 text-sm text-slate-500">Your pipeline will appear here once leads start coming in.</p>
        )
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white px-6 py-8 sm:px-10">
          <ol className="relative flex min-w-[560px] items-start justify-between">
            <span aria-hidden className="absolute left-0 right-0 top-[22px] h-px bg-slate-200" />
            {PIPELINE_STAGES.map(({ stage, label }) => {
              const count = pipeline[stage];
              const Icon = STAGE_ICON[stage] ?? Inbox;
              const isPopulated = count > 0;
              return (
                <li key={stage} className="relative flex flex-1 flex-col items-center gap-3 text-center">
                  <span
                    className={`relative z-10 flex h-11 w-11 items-center justify-center rounded-full border bg-white ${
                      isPopulated ? "border-emerald-500/40 bg-emerald-50 text-emerald-600" : "border-slate-200 text-slate-400"
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px]" aria-hidden />
                  </span>
                  <span>
                    <span className={`block text-xl font-bold tabular-nums ${isPopulated ? "text-slate-900" : "text-slate-300"}`}>
                      {count}
                    </span>
                    <span className="mt-0.5 block text-xs font-medium text-slate-500">{label}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
