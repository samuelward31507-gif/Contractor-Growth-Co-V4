import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, CheckCheck, ChevronRight, Star, Wrench } from "lucide-react";
import type { OwnerDailyBriefing } from "@/lib/briefing/queries";
import type { PipelineStage, TodayFigure } from "./dashboard-model";
import { cardClass } from "@/lib/ui/surface";
import { kpiDescriptionClass, kpiLabelClass, kpiValueClass, monoCountClass, primarySectionTitleClass } from "@/lib/ui/typography";
import { TRACKPR_HREF } from "@/app/(app)/_components/nav-items";
import type { DecisionItem } from "@/lib/decisions/types";
import { trackprHandlingSentence } from "@/lib/decisions/owner";
import { OwnerChip } from "@/lib/ui/owner-chip";
import { formatTime } from "@/lib/format/datetime";

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
            Needs you
          </h2>
          <p className="mt-0.5 text-xs text-on-dark-3">{count > 0 ? "Only what Trackpr can't do for you · most time-sensitive first" : "Anything that needs you appears here first"}</p>
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
// Happening today
// ---------------------------------------------------------------------------

/**
 * Batch 3: today's appointments, in time order, in the organization's
 * timezone - the briefing's own appointmentsToday (no new read). Every
 * visit is the contractor's to show up for; nothing here claims a reminder
 * or a confirmation the data doesn't record.
 */
export function HappeningToday({
  appointments,
  timeZone,
  className = "",
}: {
  appointments: OwnerDailyBriefing["appointmentsToday"];
  timeZone: string | null;
  className?: string;
}) {
  const ordered = [...appointments].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  return (
    <section aria-labelledby="happening-today" className={`min-w-0 overflow-hidden ${cardClass} ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pb-2 pt-4 sm:px-5 sm:pt-5">
        <h2 id="happening-today" className={primarySectionTitleClass}>
          Happening today
        </h2>
        <SectionLink href="/schedule">Open Schedule</SectionLink>
      </div>
      {ordered.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-ink-3 sm:px-5 sm:pb-5">Nothing on the calendar today.</p>
      ) : (
        <ul className="divide-y divide-line">
          {ordered.map((appointment) => (
            <li key={appointment.id}>
              <Link href={appointment.href} className="flex min-h-11 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover sm:px-5">
                <span className="w-16 shrink-0 text-[12.5px] font-medium tabular-nums text-ink-2">{formatTime(appointment.time, timeZone)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{appointment.contactName ?? appointment.title}</span>
                  <span className="block truncate text-xs text-ink-3">{appointment.contactName ? appointment.title : "Appointment"}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-3">
                  <OwnerChip owner="you" />
                  <span className="hidden sm:inline">You&apos;re meeting them</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Trackpr is handling
// ---------------------------------------------------------------------------

/**
 * Batch 3: what Trackpr is doing right now, item by item - the assembler's
 * own trackprHandling (actor "trackpr", lib/decisions/actor.ts), worded as
 * outcomes (trackprHandlingSentence) - plus what it already handled today.
 * Never counted as attention; never the machinery behind it.
 */
export function TrackprHandling({ items, handled, className = "" }: { items: DecisionItem[]; handled: string; className?: string }) {
  return (
    <section aria-labelledby="trackpr-handling" className={`min-w-0 overflow-hidden ${cardClass} ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pb-2 pt-4 sm:px-5 sm:pt-5">
        <div className="min-w-0">
          <h2 id="trackpr-handling" className={primarySectionTitleClass}>
            Trackpr is handling
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">No action needed from you.</p>
        </div>
        <SectionLink href={TRACKPR_HREF}>Open Trackpr</SectionLink>
      </div>
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <li key={item.key}>
            <Link href={item.subject.href} className="flex min-h-11 items-center gap-2.5 px-4 py-2 transition-colors hover:bg-hover sm:px-5">
              <OwnerChip owner="trackpr" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{trackprHandlingSentence(item)}</span>
              {item.age ? <span className="shrink-0 text-xs text-ink-3">{item.age}</span> : null}
            </Link>
          </li>
        ))}
        <li className="flex items-center gap-2.5 px-4 py-2.5 sm:px-5">
          <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-inset inset-ring inset-ring-line">
            <CheckCheck className="h-3.5 w-3.5 text-ink-3" strokeWidth={1.75} />
          </span>
          <span className="min-w-0 flex-1 text-[13px] text-ink-2">{handled}</span>
        </li>
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recent progress
// ---------------------------------------------------------------------------

/**
 * Recent progress - jobs recently completed and review/referral replies
 * waiting. Batch 3: what Trackpr is handling moved to its own section
 * (TrackprHandling); this is completed work only.
 */
export function TodayActivity({
  briefing,
  className = "",
}: {
  briefing: Pick<OwnerDailyBriefing, "jobsRecentlyCompleted" | "reviewReferralOpportunities">;
  className?: string;
}) {
  const follow = [
    ...briefing.jobsRecentlyCompleted.map((job) => ({ key: `job-${job.id}`, icon: Wrench, text: `${job.contactName ?? job.title} - job completed`, href: job.href, action: "View job" })),
    ...briefing.reviewReferralOpportunities.map((item) => ({ key: `rr-${item.id}`, icon: Star, text: item.kind === "review" ? "A review reply is waiting" : "A referral reply is waiting", href: item.href, action: "View" })),
  ];

  return (
    <section aria-labelledby="today-activity" className={`min-w-0 overflow-hidden ${cardClass} ${className}`}>
      <h2 id="today-activity" className={`px-4 pb-2 pt-4 sm:px-5 sm:pt-5 ${primarySectionTitleClass}`}>
        Recent progress
      </h2>
      {follow.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-ink-3 sm:px-5 sm:pb-5">No completed work to show yet.</p>
      ) : (
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
      )}
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
