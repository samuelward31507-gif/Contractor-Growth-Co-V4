import { CheckCircle2, AlertTriangle, HelpCircle, type LucideIcon } from "lucide-react";
import { Badge, type BadgeTone } from "@/lib/ui/badge";
import { formatRelativeTime, formatCount } from "./format";
import type { ScheduledAutomationLiveness, ScheduledAutomationLivenessState } from "@/lib/automation-health/scheduled-automation-liveness";

/**
 * Pass 5A, Step 9: per-scheduled-automation liveness, distinct from the
 * incident-based AutomationList above it on this page - this answers "is
 * the underlying n8n Schedule Trigger for THIS specific automation still
 * calling us", which no existing incident/execution view could answer (see
 * scheduled-automation-liveness.ts's own header comment for why). Never
 * claims a workflow "ran" when only the route's own invocation was
 * observed - "last observed" is deliberately the label, not "last run
 * successfully", since a route can execute with zero eligible candidates
 * and that is itself a fully healthy outcome.
 */
const STATE_BADGE: Record<ScheduledAutomationLivenessState, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  healthy: { label: "Observed recently", tone: "success", icon: CheckCircle2 },
  stale: { label: "May be stale", tone: "warning", icon: AlertTriangle },
  unverified: { label: "Not yet observed", tone: "neutral", icon: HelpCircle },
};

export function ScheduledLivenessList({ liveness }: { liveness: ScheduledAutomationLiveness[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <ul className="divide-y divide-slate-100">
        {liveness.map((item) => {
          const badge = STATE_BADGE[item.state];
          return (
            <li key={item.automationId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{item.automationName}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {item.lastRanAt
                    ? `Last observed ${formatRelativeTime(item.lastRanAt)} · ${formatCount(item.lastCandidateCount ?? 0)} candidate${item.lastCandidateCount === 1 ? "" : "s"} that run`
                    : "No scheduled run has been observed yet"}
                </p>
              </div>
              <Badge tone={badge.tone} icon={badge.icon}>
                {badge.label}
              </Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
