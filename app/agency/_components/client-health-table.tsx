import Link from "next/link";
import { sectionLabelClass } from "@/lib/ui/typography";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatCount } from "./format";
import type { AgencyOrganizationSnapshot } from "@/lib/agency/queries";
import type { AgencyOrganizationHealth } from "@/lib/agency/health";

/**
 * The attention state shown here is read directly from the backend's own
 * needsAttention field (lib/agency/health.ts) - this component never
 * computes or infers health itself.
 */
export function ClientHealthTable({
  organizations,
  healthByOrg,
}: {
  organizations: AgencyOrganizationSnapshot[];
  healthByOrg: Map<string, AgencyOrganizationHealth>;
}) {
  return (
    <div className="border-t border-slate-200 pt-8">
      <p className={sectionLabelClass}>Client health</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs font-medium uppercase tracking-wide text-slate-400">
              <th className="py-2 pr-4 font-medium">Client</th>
              <th className="py-2 pr-4 font-medium">Leads</th>
              <th className="py-2 pr-4 font-medium">Pipeline value</th>
              <th className="py-2 pr-4 font-medium">Estimates</th>
              <th className="py-2 pr-4 font-medium">Jobs</th>
              <th className="py-2 pr-4 font-medium">Automation</th>
              <th className="py-2 pr-4 font-medium">AI activity</th>
              <th className="py-2 pr-4 font-medium">Attention</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {organizations.map((org) => {
              const health = healthByOrg.get(org.organizationId);
              return (
                <tr key={org.organizationId} className="hover:bg-slate-50">
                  <td className="py-3 pr-4">
                    <Link href={`/agency/organizations/${org.organizationId}`} className="font-medium text-slate-900 hover:underline">
                      {org.organizationName}
                    </Link>
                  </td>
                  <td className="py-3 pr-4 tabular-nums text-slate-700">{formatCount(org.metrics.leadMetrics.totalLeads)}</td>
                  <td className="py-3 pr-4 tabular-nums text-slate-700">{formatCurrency(org.metrics.pipelineMetrics.pipelineValue)}</td>
                  <td className="py-3 pr-4 tabular-nums text-slate-700">{formatCount(org.metrics.estimateMetrics.totalEstimates)}</td>
                  <td className="py-3 pr-4 tabular-nums text-slate-700">{formatCount(org.metrics.jobMetrics.totalJobs)}</td>
                  <td className="py-3 pr-4 text-slate-700">
                    {health ? `${formatCount(health.failedWorkflowExecutions)} failed · ${formatCount(health.runningWorkflowExecutions)} running` : "—"}
                  </td>
                  <td className="py-3 pr-4 tabular-nums text-slate-700">{health ? formatCount(health.aiInteractions) : "—"}</td>
                  <td className="py-3 pr-4">
                    {health?.needsAttention ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
                        Needs attention
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                        Healthy
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
