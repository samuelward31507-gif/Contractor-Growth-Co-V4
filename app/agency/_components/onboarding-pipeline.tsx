import Link from "next/link";
import { ONBOARDING_STAGE_LABEL, type OnboardingStage } from "@/lib/onboarding/checklist";
import { metaClass } from "@/lib/ui/typography";
import { formatCount } from "./format";

const STAGE_ORDER: OnboardingStage[] = ["new", "configuring", "testing", "ready", "live"];

export type PipelineClient = { organizationId: string; organizationName: string };

/**
 * Agency Command Center 2.0, Section 5.G - shows where every non-live
 * client actually is in onboarding, grouped by real
 * computeSetupChecklist() stage (the same stage already shown per-row in
 * Client Operations) rather than duplicating per-client detail already
 * shown elsewhere. Live clients are summarized as a single count, not
 * listed here, since "onboarding pipeline" is specifically about clients
 * still in progress.
 */
export function OnboardingPipeline({ byStage }: { byStage: Record<OnboardingStage, PipelineClient[]> }) {
  const inProgressStages = STAGE_ORDER.filter((stage) => stage !== "live");
  const inProgressCount = inProgressStages.reduce((sum, stage) => sum + byStage[stage].length, 0);
  const liveCount = byStage.live.length;

  if (inProgressCount === 0) {
    return (
      <p className="mt-3 text-sm text-slate-500">
        No clients currently in onboarding — all {formatCount(liveCount)} client{liveCount === 1 ? " is" : "s are"} live.
      </p>
    );
  }

  return (
    <div className="mt-3 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
      {inProgressStages.map((stage) => {
        const clients = byStage[stage];
        if (clients.length === 0) return null;
        return (
          <div key={stage}>
            <div className="flex items-baseline justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{ONBOARDING_STAGE_LABEL[stage]}</p>
              <span className={metaClass}>{clients.length}</span>
            </div>
            <ul className="mt-1.5 divide-y divide-slate-100">
              {clients.map((client) => (
                <li key={client.organizationId}>
                  <Link
                    href={`/agency/organizations/${client.organizationId}`}
                    className="block truncate py-1.5 text-sm text-slate-700 hover:text-slate-900"
                  >
                    {client.organizationName}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
