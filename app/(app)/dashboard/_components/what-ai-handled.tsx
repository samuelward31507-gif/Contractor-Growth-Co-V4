import Link from "next/link";
import { MessageCircle, Reply, Send, AlertTriangle, type LucideIcon } from "lucide-react";
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
 *
 * Trackpr 2.0, Phase 3B: recomposed from plain divide-y label/value rows
 * into a small stat cluster with an icon per figure - the same real numbers,
 * given enough visual weight to read as evidence of work actually done,
 * matching this section's own "Trackpr is doing work for me" brief. Every
 * value below is unchanged; only the container/typography/icon changed.
 */
function Stat({ icon: Icon, label, value, tone = "neutral" }: { icon: LucideIcon; label: string; value: number; tone?: "neutral" | "attention" }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone === "attention" ? "bg-danger-muted text-danger" : "bg-accent-muted text-accent-text"}`}>
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className={`text-xl font-bold tabular-nums leading-tight ${tone === "attention" ? "text-danger-text" : "text-slate-900"}`}>{value}</p>
        <p className="truncate text-xs text-slate-500">{label}</p>
      </div>
    </div>
  );
}

export function WhatAiHandled({ snapshot }: { snapshot: BusinessMetricsSnapshot }) {
  const { aiMetrics } = snapshot;
  const hasActivity = aiMetrics.aiInteractions > 0;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className={sectionLabelClass}>What AI handled today</h3>
        <Link href="/automations" className="shrink-0 text-xs font-medium text-slate-500 hover:text-slate-900">
          View
        </Link>
      </div>

      {!hasActivity ? (
        <p className="mt-3 text-sm text-slate-500">No AI activity yet today.</p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
          <Stat icon={MessageCircle} label="Conversations handled" value={aiMetrics.aiInteractions} />
          <Stat icon={Reply} label="Customer replies answered" value={aiMetrics.customerReplyAiInteractions} />
          <Stat icon={Send} label="Recommended sending" value={aiMetrics.aiOutboundInteractions} />
          {aiMetrics.aiNeedsHumanCount > 0 ? <Stat icon={AlertTriangle} label="Flagged for you" value={aiMetrics.aiNeedsHumanCount} tone="attention" /> : null}
        </div>
      )}
    </div>
  );
}
