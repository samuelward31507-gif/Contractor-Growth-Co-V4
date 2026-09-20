import Link from "next/link";
import { AlertTriangle, ChevronRight, Clock } from "lucide-react";
import { surfaceClass } from "@/lib/ui/surface";
import { primarySectionTitleClass, metaClass } from "@/lib/ui/typography";
import { formatCount } from "./format";
import type { AgencyOrganizationHealth, StuckExecution } from "@/lib/agency/health";

/**
 * Agency Command Center UI review: the dominant section on the page, mirroring
 * app/(app)/dashboard/_components/attention-panel.tsx's exact treatment (a
 * real heading, not a receding label; rows flush on the canvas with divider
 * lines, not inside a bordered/tinted card; a confirmed-healthy empty state
 * gets the one distinct surface on the page). Every reason shown here comes
 * directly from lib/agency/health.ts's own needsAttention/stuck fields -
 * nothing is computed, scored, or invented here.
 */
export function NeedsAttention({ organizations, stuck }: { organizations: AgencyOrganizationHealth[]; stuck: StuckExecution[] }) {
  const total = organizations.length + stuck.length;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className={primarySectionTitleClass}>Needs your attention</h2>
        {total > 0 ? <span className={metaClass}>{total}</span> : null}
      </div>

      {total === 0 ? (
        <div className={`${surfaceClass} mt-5 px-6 py-14 text-center`}>
          <p className="text-base font-medium text-slate-900">All clients are operating normally.</p>
          <p className="mt-1.5 text-sm text-slate-500">Nothing needs your attention right now.</p>
        </div>
      ) : (
        <div className="mt-3 divide-y divide-slate-100">
          {organizations.map((org) => (
            <Link
              key={org.organizationId}
              href={`/agency/organizations/${org.organizationId}`}
              className="group -mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-slate-50"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">{org.organizationName}</span>
                <span className="block truncate text-xs text-slate-500">
                  {[
                    org.stuckExecutionCount > 0 ? `${formatCount(org.stuckExecutionCount)} stuck` : null,
                    org.failedWorkflowExecutions > 0 ? `${formatCount(org.failedWorkflowExecutions)} failed automation` : null,
                    org.failedMessages > 0 ? `${formatCount(org.failedMessages)} failed messages` : null,
                    org.undeliveredMessages > 0 ? `${formatCount(org.undeliveredMessages)} undelivered` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden />
            </Link>
          ))}

          {stuck.map((execution) => (
            <Link
              key={execution.id}
              href={`/agency/organizations/${execution.organizationId}`}
              className="group -mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-slate-50"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600">
                <Clock className="h-3.5 w-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">
                  {execution.workflowName} stuck <span className="text-slate-400">— {execution.organizationName}</span>
                </span>
                <span className="block truncate text-xs text-slate-500">
                  Running {formatCount(execution.ageMinutes)} min · attempt {execution.attempt}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
