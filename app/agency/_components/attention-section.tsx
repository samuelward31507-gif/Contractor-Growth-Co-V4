import Link from "next/link";
import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { formatCount } from "./format";
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

  return (
    <div className="border-t border-slate-200 pt-8">
      <p className={sectionLabelClass}>Attention required</p>

      {!hasAttentionItems ? (
        <p className="mt-4 text-sm text-slate-500">No client organizations currently need attention.</p>
      ) : (
        <div className="mt-4 space-y-6">
          {organizations.length > 0 ? (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {organizations.map((org) => (
                <li key={org.organizationId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <Link href={`/agency/organizations/${org.organizationId}`} className="text-sm font-medium text-slate-900 hover:underline">
                    {org.organizationName}
                  </Link>
                  <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                    {org.stuckExecutionCount > 0 ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">{formatCount(org.stuckExecutionCount)} stuck</span>
                    ) : null}
                    {org.failedWorkflowExecutions > 0 ? (
                      <span className="rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-700">{formatCount(org.failedWorkflowExecutions)} failed automation</span>
                    ) : null}
                    {org.failedMessages > 0 ? (
                      <span className="rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-700">{formatCount(org.failedMessages)} failed messages</span>
                    ) : null}
                    {org.undeliveredMessages > 0 ? (
                      <span className="rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-700">{formatCount(org.undeliveredMessages)} undelivered</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {stuck.length > 0 ? (
            <div>
              <p className={metaClass}>Stuck workflow executions (running longer than expected)</p>
              <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                {stuck.map((execution) => (
                  <li key={execution.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <span className="text-slate-900">
                      {execution.workflowName} <span className="text-slate-400">·</span>{" "}
                      <Link href={`/agency/organizations/${execution.organizationId}`} className="text-slate-600 hover:underline">
                        {execution.organizationName}
                      </Link>
                    </span>
                    <span className="text-xs text-slate-500">{formatCount(execution.ageMinutes)} min · attempt {execution.attempt}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
