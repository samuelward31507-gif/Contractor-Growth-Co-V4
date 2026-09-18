import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatCount, formatRelativeTime } from "./format";
import { AutomationStatusPill } from "./status-pill";
import type { AutomationSummary } from "@/lib/automation/queries";

/**
 * The primary dense list - one row per catalog automation. Every field
 * (status, execution count, failure count, last activity) is read straight
 * off the AutomationSummary this page already computed server-side; no
 * automation makes its own query.
 */
export function AutomationList({ summaries }: { summaries: AutomationSummary[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <ul className="divide-y divide-slate-100">
        {summaries.map(({ definition, status, failedExecutions, lastExecutionAt }) => {
          const Icon = definition.icon;
          return (
            <li key={definition.id}>
              <Link href={`/automations/${definition.id}`} className="group flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-slate-50 sm:items-center">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100">
                  <Icon className="h-4 w-4 text-slate-500" aria-hidden />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-slate-900">{definition.name}</p>
                    <AutomationStatusPill status={status} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{definition.description}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span>
                      Trigger: <span className="text-slate-700">{definition.trigger}</span>
                    </span>
                    <span>Last activity: {lastExecutionAt ? formatRelativeTime(lastExecutionAt) : "—"}</span>
                    <span className={failedExecutions > 0 ? "font-medium text-red-600" : ""}>{formatCount(failedExecutions)} failures</span>
                  </div>
                </div>

                <ChevronRight className="h-4 w-4 shrink-0 self-center text-slate-300 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
