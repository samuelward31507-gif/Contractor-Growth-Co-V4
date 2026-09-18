import Link from "next/link";
import { Users2, ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/dashboard/format";
import { formatCount } from "./format";
import { SectionCard } from "./section-card";
import { StatusPill } from "./status-pill";
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
    <SectionCard title="Client health" description={`${organizations.length} client organization${organizations.length === 1 ? "" : "s"}`} icon={Users2}>
      <div className="-mx-4 overflow-x-auto sm:-mx-5">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-[10.5px] font-medium uppercase tracking-wide text-slate-400">
              <th className="py-1.5 pl-4 pr-4 font-medium sm:pl-5">Client</th>
              <th className="py-1.5 pr-4 font-medium">Leads</th>
              <th className="py-1.5 pr-4 font-medium">Pipeline</th>
              <th className="py-1.5 pr-4 font-medium">Estimates</th>
              <th className="py-1.5 pr-4 font-medium">Jobs</th>
              <th className="py-1.5 pr-4 font-medium">Automation</th>
              <th className="py-1.5 pr-4 font-medium">AI activity</th>
              <th className="py-1.5 pr-4 font-medium sm:pr-5">Attention</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {organizations.map((org) => {
              const health = healthByOrg.get(org.organizationId);
              return (
                <tr key={org.organizationId} className="group">
                  <td className="py-2 pl-4 pr-4 sm:pl-5">
                    <Link
                      href={`/agency/organizations/${org.organizationId}`}
                      className="flex items-center gap-1 font-semibold text-slate-900 group-hover:text-slate-700"
                    >
                      {org.organizationName}
                      <ChevronRight className="h-3.5 w-3.5 text-slate-300 transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </Link>
                  </td>
                  <td className="py-2 pr-4 tabular-nums text-slate-700">{formatCount(org.metrics.leadMetrics.totalLeads)}</td>
                  <td className="py-2 pr-4 tabular-nums font-medium text-slate-900">{formatCurrency(org.metrics.pipelineMetrics.pipelineValue)}</td>
                  <td className="py-2 pr-4 tabular-nums text-slate-700">{formatCount(org.metrics.estimateMetrics.totalEstimates)}</td>
                  <td className="py-2 pr-4 tabular-nums text-slate-700">{formatCount(org.metrics.jobMetrics.totalJobs)}</td>
                  <td className="py-2 pr-4 text-slate-700">
                    {health ? (
                      <span className="tabular-nums">
                        {health.failedWorkflowExecutions > 0 ? <span className="font-medium text-red-600">{formatCount(health.failedWorkflowExecutions)} failed</span> : "0 failed"}
                        <span className="text-slate-300"> · </span>
                        {formatCount(health.runningWorkflowExecutions)} running
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 pr-4 tabular-nums text-slate-700">{health ? formatCount(health.aiInteractions) : "—"}</td>
                  <td className="py-2 pr-4 sm:pr-5">
                    {health?.needsAttention ? <StatusPill tone="attention" label="Needs attention" /> : <StatusPill tone="healthy" label="Healthy" />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
