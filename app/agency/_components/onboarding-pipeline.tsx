import Link from "next/link";
import { Rocket } from "lucide-react";
import { ONBOARDING_STAGE_LABEL, type OnboardingStage } from "@/lib/onboarding/checklist";
import { EmptyState } from "@/lib/ui/empty-state";
import { formatCount } from "./format";
import { AgencySection } from "./section";

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
 *
 * Agency overview redesign: a card section (AgencySection); each stage with
 * clients is an <h3> group of linked client names. Two honest empty states:
 * no clients at all, and every client already live.
 */
export function OnboardingPipeline({ byStage }: { byStage: Record<OnboardingStage, PipelineClient[]> }) {
  const inProgressStages = STAGE_ORDER.filter((stage) => stage !== "live");
  const inProgressCount = inProgressStages.reduce((sum, stage) => sum + byStage[stage].length, 0);
  const liveCount = byStage.live.length;

  return (
    <AgencySection
      id="onboarding-pipeline"
      title="Onboarding pipeline"
      description={`${formatCount(inProgressCount)} setting up · ${formatCount(liveCount)} live`}
    >
      {inProgressCount === 0 ? (
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          {liveCount === 0 ? (
            <EmptyState icon={Rocket} title="No clients in onboarding." description="When a client organization is connected, its setup progress appears here, stage by stage." />
          ) : (
            <EmptyState
              icon={Rocket}
              title="No clients currently in onboarding."
              description={`All ${formatCount(liveCount)} client${liveCount === 1 ? " is" : "s are"} live.`}
            />
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-x-6 gap-y-5 border-t border-line px-4 pb-4 pt-4 sm:grid-cols-2 sm:px-5 sm:pb-5">
          {inProgressStages.map((stage) => {
            const clients = byStage[stage];
            if (clients.length === 0) return null;
            const headingId = `pipeline-${stage}`;
            return (
              <div key={stage} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 id={headingId} className="text-xs font-medium text-ink-3">
                    {ONBOARDING_STAGE_LABEL[stage]}
                  </h3>
                  <span className="text-xs tabular-nums text-ink-3">{formatCount(clients.length)}</span>
                </div>
                <ul aria-labelledby={headingId} className="mt-1.5 divide-y divide-line">
                  {clients.map((client) => (
                    <li key={client.organizationId}>
                      <Link
                        href={`/agency/organizations/${client.organizationId}`}
                        className="-mx-1.5 block truncate rounded-md px-1.5 py-2 text-sm text-ink-2 transition-colors hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
      )}
    </AgencySection>
  );
}
