import { History } from "lucide-react";
import { ExecutionRow } from "./execution-row";
import { EmptyState } from "@/lib/ui/empty-state";
import type { AutomationExecutionRow } from "@/lib/automation/queries";

/**
 * Operational execution log - workflow name, status, trigger source, timing,
 * attempt, and retry. Clicking a row opens the Phase F detail view (sanitized
 * server-side, fetched on demand per row via ExecutionRow - never eagerly for
 * every row up front, and never rendering a raw database column directly).
 */
export function RecentExecutions({ executions, retrySupported }: { executions: AutomationExecutionRow[]; retrySupported: boolean }) {
  if (executions.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No executions yet"
        description="This automation is configured but hasn't processed any events yet. Activity will show up here as soon as it runs."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-[10.5px] font-medium uppercase tracking-wide text-slate-400">
            <th className="py-2 pl-4 pr-2 font-medium" aria-hidden />
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Trigger</th>
            <th className="py-2 pr-4 font-medium">Started</th>
            <th className="py-2 pr-4 font-medium">Completed</th>
            <th className="py-2 pr-4 font-medium">Duration</th>
            <th className="py-2 pr-4 font-medium">Attempt</th>
            <th className="py-2 pr-4 font-medium">Retry</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {executions.map((execution) => (
            <ExecutionRow key={execution.id} execution={execution} retrySupported={retrySupported} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
