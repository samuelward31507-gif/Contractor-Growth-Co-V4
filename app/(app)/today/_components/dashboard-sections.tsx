import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, ChevronRight, Star, Workflow, Wrench } from "lucide-react";
import type { OwnerDailyBriefing } from "@/lib/briefing/queries";
import type { PipelineStage, TodayFigure } from "./dashboard-model";

/**
 * Today's sections. Deliberately few surfaces - the attention list, the
 * Today panel and the work strip - so the page reads as one calm
 * operating surface, not a dashboard. Historical performance lives on
 * Analytics. Every figure is passed in from data the page already loaded.
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
// Today
// ---------------------------------------------------------------------------

/**
 * Today: three figures (new leads, appointments, conversations waiting on
 * the owner), then compact follow-ups - jobs recently completed and
 * review/referral replies waiting - and one line on what Trackpr handled.
 */
export function TodayPanel({ figures, briefing, handled }: { figures: TodayFigure[]; briefing: Pick<OwnerDailyBriefing, "jobsRecentlyCompleted" | "reviewReferralOpportunities">; handled: string }) {
  const follow = [
    ...briefing.jobsRecentlyCompleted.map((job) => ({ key: `job-${job.id}`, icon: Wrench, text: `${job.contactName ?? job.title} - job completed`, href: job.href, action: "View job" })),
    ...briefing.reviewReferralOpportunities.map((item) => ({ key: `rr-${item.id}`, icon: Star, text: item.kind === "review" ? "A review reply is waiting" : "A referral reply is waiting", href: item.href, action: "View" })),
    { key: "handled", icon: Workflow, text: handled, href: "/automations", action: "View automations" },
  ];

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-3">
        {figures.map((figure) => (
          <Link
            key={figure.key}
            href={figure.href}
            className="flex min-h-11 items-center justify-between gap-3 bg-surface px-4 py-3 transition-colors hover:bg-hover focus:outline-none focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:flex-col sm:items-start sm:justify-start sm:gap-1 sm:px-5 sm:py-4"
          >
            <span className="text-xs font-medium text-ink-3">{figure.label}</span>
            <span className="flex items-baseline gap-2 sm:flex-col sm:items-start sm:gap-0.5">
              <span className={`text-[22px] font-semibold leading-tight tracking-[-0.02em] tabular-nums ${figure.tone === "attention" ? "text-warning-text" : "text-ink"}`}>{figure.value}</span>
              <span className="text-xs text-ink-3">{figure.detail}</span>
            </span>
          </Link>
        ))}
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {follow.map((item) => (
          <li key={item.key} className="flex items-center justify-between gap-3 px-4 py-1.5 sm:px-5">
            <span className="flex min-w-0 items-center gap-2 text-[13px] text-ink-2">
              <item.icon className="h-3.5 w-3.5 shrink-0 text-ink-3" strokeWidth={1.75} aria-hidden />
              <span className="truncate">{item.text}</span>
            </span>
            <Link href={item.href} className={`${LINK_CLASS} shrink-0`}>
              {item.action}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Where the work stands: six current-state stages left to right on wide
 * screens, three across on tablets, a compact list on phones. Not a funnel
 * chart - the stages are independent counts of what is in each state right
 * now. Hairline dividers come from a 1px gap over the line color, so they
 * stay correct at every column count.
 */
export function PipelineFlow({ stages }: { stages: PipelineStage[] }) {
  return (
    <ol className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
      {stages.map((stage) => (
        <li key={stage.key} className="min-w-0 bg-surface">
          <Link
            href={stage.href}
            className="flex min-h-11 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-hover focus:outline-none focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:flex-col sm:items-start sm:justify-start sm:gap-1 sm:py-3.5"
          >
            <span className="text-xs font-medium text-ink-3">{stage.label}</span>
            <span className="flex items-baseline gap-2 sm:flex-col sm:items-start sm:gap-0.5">
              <span className="text-base font-semibold tabular-nums tracking-[-0.01em] text-ink">{stage.value}</span>
              <span className={`text-xs ${stage.tone === "attention" ? "font-medium text-danger-text" : "text-ink-3"}`}>{stage.detail}</span>
            </span>
          </Link>
        </li>
      ))}
    </ol>
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
