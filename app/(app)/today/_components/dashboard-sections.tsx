import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, ChevronRight, Star, Wrench } from "lucide-react";
import { formatRelativeTime } from "@/lib/dashboard/format";
import type { CachedBusinessInsights } from "@/lib/dashboard/business-metrics";
import type { OwnerDailyBriefing } from "@/lib/briefing/queries";
import type { InsightType } from "@/lib/bi/insights";
import { StatusDot } from "@/lib/ui/status-dot";
import { GenerateInsightsButton } from "../../dashboard/_components/generate-insights-button";
import type { ActivityItem, HandledItem, PipelineStage } from "./dashboard-model";

/**
 * Trackpr 2.0 (step 2E): the Dashboard's sections. Deliberately few
 * surfaces - the attention list and the revenue figures sit on white
 * panels; everything else is an unboxed section under a hairline, so the
 * page reads as one calm operating surface rather than a wall of cards.
 * Every figure is passed in from data the page already loaded.
 */

const LINK_CLASS =
  "inline-flex min-h-11 items-center gap-1 rounded-md text-[13px] font-medium text-ink-3 transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0";

/** A titled section: an h2, an optional quiet link on the right, and its content. */
export function DashboardSection({ id, title, action, children, className = "" }: { id: string; title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={`min-w-0 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id={id} className="text-sm font-semibold text-ink">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SectionLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={LINK_CLASS}>
      {children}
      <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------

export type RevenueFigure = { key: string; label: string; value: string; detail: string; href: string; tone?: "positive" | "attention" };

/** Four money figures on one 2x2 panel - Collected first: the only one that is money in hand. */
export function RevenuePanel({ figures }: { figures: RevenueFigure[] }) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-surface">
      {figures.map((figure, index) => (
        <Link
          key={figure.key}
          href={figure.href}
          className={`group flex min-h-11 flex-col gap-1 px-4 py-4 transition-colors hover:bg-hover focus:outline-none focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:px-5 ${
            index % 2 === 1 ? "border-l border-line" : ""
          } ${index >= 2 ? "border-t border-line" : ""}`}
        >
          <span className="text-xs font-medium text-ink-3">{figure.label}</span>
          <span className={`text-[22px] font-semibold leading-tight tracking-[-0.02em] tabular-nums ${figure.tone === "positive" ? "text-accent-text" : "text-ink"}`}>{figure.value}</span>
          <span className={`text-xs ${figure.tone === "attention" ? "font-medium text-danger-text" : "text-ink-3"}`}>{figure.detail}</span>
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Briefing
// ---------------------------------------------------------------------------

/**
 * Today's briefing: plain sentences built from uncapped counts, then the
 * two things the rest of the page doesn't already show - jobs recently
 * completed and review/referral replies waiting (both link through).
 */
export function BriefingBody({ lines, briefing }: { lines: string[]; briefing: Pick<OwnerDailyBriefing, "jobsRecentlyCompleted" | "reviewReferralOpportunities"> }) {
  const follow = [
    ...briefing.jobsRecentlyCompleted.map((job) => ({ key: `job-${job.id}`, icon: Wrench, text: `${job.contactName ?? job.title} - job completed`, href: job.href, action: "View job" })),
    ...briefing.reviewReferralOpportunities.map((item) => ({ key: `rr-${item.id}`, icon: Star, text: item.kind === "review" ? "A review reply is waiting" : "A referral reply is waiting", href: item.href, action: "View" })),
  ];

  return (
    <div>
      <ul className="space-y-2">
        {lines.map((line) => (
          <li key={line} className="text-[15px] leading-6 text-ink">
            {line}
          </li>
        ))}
      </ul>
      {follow.length > 0 ? (
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {follow.map((item) => (
            <li key={item.key} className="flex items-center justify-between gap-3 py-1.5">
              <span className="flex min-w-0 items-center gap-2 text-[13px] text-ink-2">
                <item.icon className="h-3.5 w-3.5 shrink-0 text-ink-3" strokeWidth={1.75} aria-hidden />
                <span className="truncate">{item.text}</span>
              </span>
              <Link href={item.href} className={LINK_CLASS}>
                {item.action}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trackpr handled / What happened
// ---------------------------------------------------------------------------

/** Label-value rows - the shared shape of "Trackpr handled" and "Today so far". */
export function FigureList({ items, emptyText }: { items: (HandledItem | ActivityItem)[]; emptyText: string }) {
  if (items.length === 0) return <p className="text-[13px] text-ink-3">{emptyText}</p>;
  return (
    <dl className="divide-y divide-line border-y border-line">
      {items.map((item) => {
        const attention = "tone" in item && item.tone === "attention";
        return (
          <div key={item.label} className="flex items-center justify-between gap-3 py-2">
            <dt className="flex items-center gap-2 text-[13px] text-ink-2">
              {attention ? <StatusDot tone="attention" /> : null}
              {item.label}
            </dt>
            <dd className={`text-sm font-semibold tabular-nums ${attention ? "text-warning-text" : "text-ink"}`}>{item.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Where the work stands: five current-state stages left to right on wide
 * screens, a compact list on phones. Not a funnel chart - the stages are
 * independent counts of what is in each state right now.
 */
export function PipelineFlow({ stages }: { stages: PipelineStage[] }) {
  return (
    <ol className="grid grid-cols-1 overflow-hidden rounded-lg border border-line bg-surface sm:grid-cols-5">
      {stages.map((stage, index) => (
        <li key={stage.key} className={`min-w-0 ${index > 0 ? "border-t border-line sm:border-l sm:border-t-0" : ""}`}>
          <Link
            href={stage.href}
            className="flex min-h-11 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-hover focus:outline-none focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:flex-col sm:items-start sm:justify-start sm:gap-1 sm:py-3.5"
          >
            <span className="text-xs font-medium text-ink-3">{stage.label}</span>
            <span className="flex items-baseline gap-2 sm:flex-col sm:items-start sm:gap-0.5">
              <span className="text-base font-semibold tabular-nums tracking-[-0.01em] text-ink">{stage.value}</span>
              <span className="text-xs text-ink-3">{stage.detail}</span>
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

const INSIGHT_KIND: Record<InsightType, string> = {
  lead_volume: "Leads",
  pipeline: "Pipeline",
  estimates: "Estimates",
  appointments: "Appointments",
  jobs: "Jobs",
  communication: "Communication",
  follow_up: "Follow-up",
  automation: "Automation",
  data_quality: "Data",
};

/**
 * The cached business insights, as plain business observations - no AI
 * branding. Renders only what was already generated and persisted; the
 * one deliberate generate/refresh path is the existing button.
 */
export function InsightsBody({ cached }: { cached: CachedBusinessInsights | null }) {
  if (!cached) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-ink-3">No insights for this period yet.</p>
        <GenerateInsightsButton label="Generate insights" />
      </div>
    );
  }

  const insights = cached.report.insights.slice(0, 3);
  return (
    <div>
      {insights.length === 0 ? (
        <p className="text-[13px] text-ink-3">{cached.report.summary || "Not enough business activity yet for a meaningful observation."}</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {insights.map((insight, index) => (
            <li key={`${insight.type}-${index}`} className="py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
                {insight.severity === "attention" ? <StatusDot tone="attention" /> : null}
                {insight.severity === "attention" ? "Attention" : (INSIGHT_KIND[insight.type] ?? "Observation")}
              </p>
              <p className="mt-0.5 text-[13px] font-medium text-ink">{insight.title}</p>
              <p className="mt-0.5 text-[13px] leading-5 text-ink-2">{insight.description}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-3">
          Updated {formatRelativeTime(cached.generatedAt)}
          {!cached.isFresh ? " · may be out of date" : ""}
        </p>
        <GenerateInsightsButton label="Refresh" />
      </div>
    </div>
  );
}

/** "Show all" for a trimmed list - a real link, so it works without JavaScript. */
export function ShowAllLink({ href, count }: { href: string; count: number }) {
  return (
    <Link href={href} className="flex min-h-11 items-center justify-center gap-1 border-t border-line text-[13px] font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink focus:outline-none focus-visible:bg-hover sm:min-h-10">
      Show all {count}
      <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
    </Link>
  );
}
