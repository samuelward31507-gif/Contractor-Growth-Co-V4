import Link from "next/link";
import { sectionLabelClass } from "@/lib/ui/typography";
import type { BusinessMetricsSnapshot } from "@/lib/bi/types";

/**
 * Trackpr 2.0 Phase 2: the dashboard already showed AI-generated business
 * commentary (AiInsightsPanel) and a single aggregate "automation activity"
 * count (SystemStatus), but nothing answered "what did the AI actually do
 * today" - the gap this fills. Reuses todaySnapshot.aiMetrics, the exact
 * same BiAiMetrics the Analytics page's AiActivitySection already reads
 * (lib/bi/types.ts) - no new query, no second AI-activity computation.
 * "Recommended sending" (not "sent") matches aiOutboundInteractions' real
 * definition: what the AI recommended, subject to the outbound gate, which
 * this count does not itself reflect - see lib/bi/types.ts's own comment.
 */
function Row({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "attention" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-sm text-slate-600">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${tone === "attention" ? "text-red-600" : "text-slate-900"}`}>{value}</span>
    </div>
  );
}

export function WhatAiHandled({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { aiMetrics } = snapshot;
  const hasActivity = aiMetrics.aiInteractions > 0;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className={sectionLabelClass}>What AI handled today</p>
        <Link href="/automations" className="shrink-0 text-xs font-medium text-slate-500 hover:text-slate-900">
          View
        </Link>
      </div>

      {!hasActivity ? (
        <p className="mt-3 text-sm text-slate-500">No AI activity yet today.</p>
      ) : (
        <div className="mt-3 divide-y divide-slate-100">
          <Row label="Conversations handled" value={aiMetrics.aiInteractions} />
          <Row label="Customer replies answered" value={aiMetrics.customerReplyAiInteractions} />
          <Row label="Recommended sending" value={aiMetrics.aiOutboundInteractions} />
          {aiMetrics.aiNeedsHumanCount > 0 ? (
            <Row label="Flagged for you" value={aiMetrics.aiNeedsHumanCount} tone="attention" />
          ) : null}
        </div>
      )}
    </div>
  );
}
