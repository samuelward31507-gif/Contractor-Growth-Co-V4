import { History } from "lucide-react";
import { ExecutionRow } from "./execution-row";
import { EmptyState } from "@/lib/ui/empty-state";
import type { AutomationExecutionRow } from "@/lib/automation/queries";

/**
 * Operational execution log - status, trigger source, timing, attempt, and
 * retry. Clicking a row opens the Phase F detail view (sanitized
 * server-side, fetched on demand per row via ExecutionRow - never eagerly for
 * every row up front, and never rendering a raw database column directly).
 *
 * Trackpr 2.0, Phase 3H: rebuilt from a `min-w-[720px]` table wrapped in
 * `overflow-x-auto` - the exact horizontal-scroll-on-mobile anti-pattern
 * incident-list.tsx's own header comment already documents fixing for
 * incidents - into the same stacked row list every other section of this
 * page (AutomationList, AiAgents, IncidentList, ScheduledLivenessList)
 * already uses. Same data, same columns' worth of information, no table.
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
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <ul className="divide-y divide-slate-100">
        {executions.map((execution) => (
          <ExecutionRow key={execution.id} execution={execution} retrySupported={retrySupported} />
        ))}
      </ul>
    </div>
  );
}
