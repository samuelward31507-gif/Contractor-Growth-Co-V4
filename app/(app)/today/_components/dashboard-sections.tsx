import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, ChevronRight, Star, Workflow, Wrench } from "lucide-react";
import type { OwnerDailyBriefing } from "@/lib/briefing/queries";
import type { PipelineStage, TodayFigure } from "./dashboard-model";
import { cardClass } from "@/lib/ui/surface";
import { kpiDescriptionClass, kpiLabelClass, kpiValueClass, monoCountClass, primarySectionTitleClass } from "@/lib/ui/typography";

/**
 * Today's sections. Final redesign: Today is composed like an operations
 * console - a row of KPI cards, then a wide work column (where the work
 * stands, opportunities, today's activity) beside one dark focal panel
 * (needs your attention). Still deliberately few surfaces, and every figure
 * is passed in from data the page already loaded. Historical performance
 * lives on Analytics.
 */

const LINK_CLASS =
  "inline-flex min-h-11 items-center gap-1 rounded-md text-[13px] font-medium text-accent transition-colors hover:text-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0";

/**
 * A titled section. `variant="card"` puts the title inside one white card
 * (the title and its surface read as one unit), with the body flush so list
 * rows run edge to edge; the plain variant keeps the title above its
 * content. `hideTitle` keeps the h2 for assistive tech and the page outline
 * while the content (the KPI row) speaks for itself.
 */
export function DashboardSection({
  id,
  title,
  action,
  children,
  className = "",
  variant = "plain",
  hideTitle = false,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  variant?: "plain" | "card";
  hideTitle?: boolean;
}) {
  if (variant === "card") {
    return (
      <section aria-labelledby={id} className={`min-w-0 overflow-hidden ${cardClass} ${className}`}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
          <h2 id={id} className={primarySectionTitleClass}>
            {title}
          </h2>
          {action}
        </div>
        {children}
      </section>
    );
  }
  return (
    <section aria-labelledby={id} className={`min-w-0 ${className}`}>
      <div className={hideTitle ? "sr-only" : "mb-3 flex items-center justify-between gap-3"}>
        <h2 id={id} className={primarySectionTitleClass}>
          {title}
        </h2>
        {hideTitle ? null : action}
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
// KPI row
// ---------------------------------------------------------------------------

const KPI_COLS: Record<number, string> = {
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
};

/**
 * The figures the owner reads first, one card each: a small muted label, a
 * large tabular number, one contextual line (in the warning tone when it is
 * asking for action). Two across on phones - an odd last card spans the
 * row instead of leaving a half-width orphan - four (or three) across on
 * desktop.
 */
export function TodayKpis({ figures }: { figures: TodayFigure[] }) {
  return (
    <div className={`grid grid-cols-2 gap-3 sm:gap-4 [&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1 ${KPI_COLS[figures.length] ?? "lg:grid-cols-4"}`}>
      {figures.map((figure) => (
        <Link
          key={figure.key}
          href={figure.href}
          className={`group flex min-h-11 min-w-0 flex-col ${cardClass} px-4 py-4 transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-[0_1px_2px_rgba(20,23,22,0.06),0_6px_16px_-6px_rgba(20,23,22,0.12)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:px-5 sm:py-5`}
        >
          <span className={`${kpiLabelClass} truncate`}>{figure.label}</span>
          <span className={kpiValueClass}>{figure.value}</span>
          <span className={`${kpiDescriptionClass} flex min-w-0 items-start gap-1.5 ${figure.tone === "attention" ? "font-medium text-warning-text" : ""}`}>
            {figure.tone === "attention" ? <span aria-hidden className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning" /> : null}
            <span className="min-w-0">{figure.detail}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Needs your attention - the one dark focal panel
// ---------------------------------------------------------------------------

/**
 * The dark pine-ink panel that holds Act II. The page passes the existing
 * decision rows in as children; this only frames them - a title with the
 * one attention count, an honest line on the order, and the optional
 * "Show all" footer.
 */
export function AttentionPanel({ id, count, children, footer, className = "" }: { id: string; count: number; children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <section
      aria-labelledby={id}
      className={`min-w-0 overflow-hidden rounded-xl bg-panel-dark text-on-dark shadow-[0_1px_2px_rgba(0,0,0,0.12),0_12px_32px_-12px_rgba(15,31,28,0.45)] inset-ring inset-ring-dark-line ${className}`}
    >
      <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold tracking-[-0.01em] text-on-dark">
            Needs your attention
          </h2>
          <p className="mt-0.5 text-xs text-on-dark-3">{count > 0 ? "Most time-sensitive first" : "Anything that needs you appears here first"}</p>
        </div>
        {count > 0 ? (
          <span className={`mt-0.5 inline-flex shrink-0 items-center rounded-full bg-dark-fill-strong px-2 py-0.5 text-on-dark inset-ring inset-ring-dark-line ${monoCountClass}`}>
            {count}
          </span>
        ) : null}
      </div>
      <div className="px-3 pb-3 sm:px-4 sm:pb-4">{children}</div>
      {footer}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Today's activity
// ---------------------------------------------------------------------------

/**
 * Today's follow-ups - jobs recently completed and review/referral replies
 * waiting - plus what Trackpr is handling and handled, as a compact list.
 */
export function TodayActivity({
  briefing,
  handled,
  handling,
  className = "",
}: {
  briefing: Pick<OwnerDailyBriefing, "jobsRecentlyCompleted" | "reviewReferralOpportunities">;
  handled: string;
  handling?: string | null;
  className?: string;
}) {
  const follow = [
    ...briefing.jobsRecentlyCompleted.map((job) => ({ key: `job-${job.id}`, icon: Wrench, text: `${job.contactName ?? job.title} - job completed`, href: job.href, action: "View job" })),
    ...briefing.reviewReferralOpportunities.map((item) => ({ key: `rr-${item.id}`, icon: Star, text: item.kind === "review" ? "A review reply is waiting" : "A referral reply is waiting", href: item.href, action: "View" })),
    // Phase 2-3c: work Trackpr is handling right now - only when there is some.
    ...(handling ? [{ key: "handling", icon: Workflow, text: handling, href: "/automations", action: "View automations" }] : []),
    { key: "handled", icon: Workflow, text: handled, href: "/automations", action: "View automations" },
  ];

  return (
    <section aria-labelledby="today-activity" className={`min-w-0 overflow-hidden ${cardClass} ${className}`}>
      <h2 id="today-activity" className={`px-4 pb-2 pt-4 sm:px-5 sm:pt-5 ${primarySectionTitleClass}`}>
        Today&apos;s activity
      </h2>
      <ul className="divide-y divide-line">
        {follow.map((item) => (
          <li key={item.key} className="flex items-center justify-between gap-3 px-4 py-2 sm:px-5">
            <span className="flex min-w-0 items-center gap-2.5 text-[13px] text-ink-2">
              <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-inset inset-ring inset-ring-line">
                <item.icon className="h-3.5 w-3.5 text-ink-3" strokeWidth={1.75} />
              </span>
              <span className="truncate">{item.text}</span>
            </span>
            <Link href={item.href} className={`${LINK_CLASS} shrink-0`}>
              {item.action}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Where the work stands: the current-state stages as small inset tiles -
 * label, value, count - five across on wide screens, three on tablets, a
 * compact list on phones. Not a funnel chart - each stage is an independent
 * count of what is in that state right now. Rendered inside the section's
 * card, so the tiles sit on white.
 */
export function PipelineFlow({ stages }: { stages: PipelineStage[] }) {
  const cols = stages.length >= 6 ? "lg:grid-cols-6" : "lg:grid-cols-5";
  return (
    <ol className={`grid grid-cols-1 gap-2 px-4 pb-4 sm:grid-cols-3 sm:px-5 sm:pb-5 ${cols}`}>
      {stages.map((stage) => (
        <li key={stage.key} className="min-w-0">
          <Link
            href={stage.href}
            title={stage.label}
            className="flex min-h-11 items-center justify-between gap-3 px-4 py-3 transition-colors duration-150 h-full rounded-lg bg-inset inset-ring inset-ring-line/70 hover:bg-selected hover:inset-ring-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:flex-col sm:items-start sm:justify-start sm:gap-1 sm:px-3 sm:py-3"
          >
            <span className="min-w-0 max-w-full truncate whitespace-nowrap text-xs font-medium text-ink-3 sm:text-[11.5px]">{stage.label}</span>
            <span className="flex items-baseline gap-2 sm:flex-col sm:items-start sm:gap-0.5">
              <span className="text-lg font-semibold leading-tight tabular-nums tracking-[-0.02em] text-ink">{stage.value}</span>
              <span className={`text-xs ${stage.tone === "attention" ? "font-medium text-danger-text" : "text-ink-3"}`}>{stage.detail}</span>
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

/** "Show all" for a trimmed list - a real link, so it works without JavaScript. `inverse` for the dark attention panel. */
export function ShowAllLink({ href, count, inverse = false }: { href: string; count: number; inverse?: boolean }) {
  return (
    <Link
      href={href}
      className={`flex min-h-11 items-center justify-center gap-1 border-t text-[13px] font-medium transition-colors focus:outline-none sm:min-h-10 ${
        inverse ? "border-dark-line text-on-dark-2 hover:bg-dark-fill hover:text-on-dark focus-visible:bg-dark-fill" : "border-line text-ink-3 hover:bg-hover hover:text-ink focus-visible:bg-hover"
      }`}
    >
      Show all {count}
      <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
    </Link>
  );
}
