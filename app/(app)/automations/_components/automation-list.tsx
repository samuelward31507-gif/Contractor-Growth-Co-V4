import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatCount, formatRelativeTime, AUTOMATION_STATUS_BADGE } from "./format";
import { Badge } from "@/lib/ui/badge";
import type { AutomationSummary } from "@/lib/automation/queries";
import type { AutomationHealthSummary } from "@/lib/automation-health/types";

/**
 * Grouped by real operational status - "Needs attention" first, "Active"
 * second, everything else (no activity / not configured / disabled) last -
 * instead of one flat list where a failing automation reads with the exact
 * same visual weight as an idle, never-configured one. Groups with zero
 * automations in them are simply omitted, never padded or explained away.
 */
const GROUPS: { statuses: AutomationSummary["status"][]; label: string }[] = [
  { statuses: ["attention"], label: "Needs attention" },
  { statuses: ["active"], label: "Active" },
  { statuses: ["no_activity", "not_configured", "disabled"], label: "Inactive" },
];

function AutomationRow({ summary, activeIncidentCount }: { summary: AutomationSummary; activeIncidentCount: number }) {
  const { definition, status, failedExecutions, lastExecutionAt } = summary;
  const Icon = definition.icon;
  const statusBadge = AUTOMATION_STATUS_BADGE[status];

  return (
    <li>
      <Link
        href={`/automations/${definition.id}`}
        className="group flex items-start gap-3.5 px-4 py-4 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-900/10 sm:items-center"
      >
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
            status === "active" ? "bg-emerald-50 text-emerald-600" : status === "attention" ? "bg-amber-50 text-amber-600" : "bg-slate-100 text-slate-500"
          }`}
        >
          <Icon className="h-[18px] w-[18px]" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[15px] font-semibold text-slate-900">{definition.name}</p>
            <Badge tone={statusBadge.tone} icon={statusBadge.icon}>
              {statusBadge.label}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500">{definition.description}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>
              Trigger: <span className="text-slate-700">{definition.trigger}</span>
            </span>
            <span>Last activity: {lastExecutionAt ? formatRelativeTime(lastExecutionAt) : "—"}</span>
            <span className={failedExecutions > 0 ? "font-medium text-red-600" : ""}>{formatCount(failedExecutions)} failures</span>
            {activeIncidentCount > 0 ? (
              <span className="font-medium text-red-600">
                {formatCount(activeIncidentCount)} active incident{activeIncidentCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        </div>

        <ChevronRight className="h-4 w-4 shrink-0 self-center text-slate-300 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  );
}

/** Trackpr 2.0 Phase 4: keyed by AutomationHealthSummary.automationId - the real, incident-based active count, alongside (not replacing) each row's existing AutomationDisplayStatus badge. */
export function AutomationList({ summaries, healthByAutomationId }: { summaries: AutomationSummary[]; healthByAutomationId: Map<string, AutomationHealthSummary> }) {
  return (
    <div className="flex flex-col gap-6">
      {GROUPS.map((group) => {
        const items = summaries.filter((s) => group.statuses.includes(s.status));
        if (items.length === 0) return null;
        return (
          <div key={group.label}>
            <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {group.label} <span className="text-slate-300">· {items.length}</span>
            </p>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <ul className="divide-y divide-slate-100">
                {items.map((summary) => (
                  <AutomationRow
                    key={summary.definition.id}
                    summary={summary}
                    activeIncidentCount={healthByAutomationId.get(summary.definition.id)?.activeIncidentCount ?? 0}
                  />
                ))}
              </ul>
            </div>
          </div>
        );
      })}
    </div>
  );
}
