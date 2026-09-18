import Link from "next/link";
import { AlertTriangle, ShieldCheck, Clock } from "lucide-react";
import { formatCount } from "./format";
import { SectionCard } from "./section-card";
import type { AgencyOrganizationHealth, StuckExecution } from "@/lib/agency/health";

/**
 * Organizations and executions shown here come straight from the backend's
 * own needsAttention/stuck fields - no additional health logic is computed
 * in this component. Never renders message bodies, phone numbers, emails,
 * AI content, or raw automation payloads - the backend shape (StuckExecution,
 * AgencyOrganizationHealth) structurally excludes all of that already.
 */
export function AttentionSection({
  organizations,
  stuck,
}: {
  organizations: AgencyOrganizationHealth[];
  stuck: StuckExecution[];
}) {
  const hasAttentionItems = organizations.length > 0 || stuck.length > 0;

  if (!hasAttentionItems) {
    return (
      <SectionCard title="Attention required" icon={AlertTriangle}>
        <div className="flex items-center gap-3 rounded-lg border border-emerald-100 bg-emerald-50/60 px-4 py-3.5">
          <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
          <div>
            <p className="text-sm font-medium text-emerald-900">No attention required</p>
            <p className="text-xs text-emerald-700">All connected client systems are currently healthy.</p>
          </div>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Attention required" description={`${organizations.length} client${organizations.length === 1 ? "" : "s"} flagged`} icon={AlertTriangle}>
      <div className="space-y-5">
        {organizations.length > 0 ? (
          <ul className="divide-y divide-slate-100 rounded-lg border border-amber-200 bg-amber-50/30">
            {organizations.map((org) => (
              <li key={org.organizationId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <Link href={`/agency/organizations/${org.organizationId}`} className="text-sm font-semibold text-slate-900 hover:underline">
                  {org.organizationName}
                </Link>
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {org.stuckExecutionCount > 0 ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">{formatCount(org.stuckExecutionCount)} stuck</span>
                  ) : null}
                  {org.failedWorkflowExecutions > 0 ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">{formatCount(org.failedWorkflowExecutions)} failed automation</span>
                  ) : null}
                  {org.failedMessages > 0 ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">{formatCount(org.failedMessages)} failed messages</span>
                  ) : null}
                  {org.undeliveredMessages > 0 ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">{formatCount(org.undeliveredMessages)} undelivered</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {stuck.length > 0 ? (
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-500">
              <Clock className="h-3.5 w-3.5" aria-hidden />
              Stuck workflow executions (running longer than expected)
            </p>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {stuck.map((execution) => (
                <li key={execution.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="text-slate-900">
                    {execution.workflowName} <span className="text-slate-300">·</span>{" "}
                    <Link href={`/agency/organizations/${execution.organizationId}`} className="text-slate-600 hover:underline">
                      {execution.organizationName}
                    </Link>
                  </span>
                  <span className="tabular-nums text-xs text-slate-500">
                    {formatCount(execution.ageMinutes)} min · attempt {execution.attempt}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
