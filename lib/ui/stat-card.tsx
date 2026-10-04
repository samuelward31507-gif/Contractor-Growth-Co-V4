/**
 * Final visual polish pass: the KPI/stat-card primitive that replaces the
 * old "integrated stat strip" convention (a `dl.flex.flex-wrap` row of
 * label/value pairs, still available via lib/ui/typography.ts's
 * statLabelClass/statValueClass for places a compact strip genuinely reads
 * better) for a page's PRIMARY metrics. The strip pattern read as
 * "restrained," but on a wide desktop viewport it left real business
 * numbers (pipeline value, open estimates, active jobs) clustered in a
 * single left-aligned cluster instead of using the available width - this
 * gives each metric its own bordered container so the page's most
 * important numbers get room to breathe and the grid fills the workspace.
 *
 * Tone reuses lib/ui/badge.tsx's BadgeTone so a StatCard's accent (icon
 * chip only - the card itself always stays neutral white/border, per the
 * "85-90% neutral, 10-15% accent" rule) maps onto the exact same semantic
 * colors as every status badge in the app: success = the app's one emerald
 * accent, warning = amber, danger = red. Never use tone to recolor the
 * card's background or the value text itself - only the small icon chip.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import type { BadgeTone } from "./badge";
import { kpiLabelClass, kpiValueClass, kpiDescriptionClass } from "./typography";
import { cardClass } from "./surface";

const TONE_ICON_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-inset text-ink-3",
  info: "bg-info-muted text-info-text",
  success: "bg-accent-muted text-accent-text",
  warning: "bg-warning-muted text-warning-text",
  danger: "bg-danger-muted text-danger-text",
};

export function StatGrid({
  children,
  columns = 4,
  className = "",
}: {
  children: ReactNode;
  /** How many columns the grid reaches at its widest breakpoint - pick the count that matches how many stats are actually passed in (don't over-request columns for 2-3 stats). */
  columns?: 2 | 3 | 4 | 5;
  className?: string;
}) {
  const COLS: Record<2 | 3 | 4 | 5, string> = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
  };
  // Theme upgrade: two up on a phone (a financial summary reads as a grid, not a scroll of cards).
  return <div className={`grid grid-cols-2 gap-3 sm:gap-4 ${COLS[columns]} ${className}`}>{children}</div>;
}

// A genuine headline figure ("$63,950", "12", "69%") reads fine at
// kpiValueClass's full 28px - a text fallback sentence ("Not enough data
// yet") does not: it wraps inside a StatCard's quarter-width column and, at
// full KPI size, reads as a chunky, mismatched line next to its numeric
// siblings in the same StatGrid row. Long string values step down one size
// instead - still clearly the card's own headline, just sized for prose
// rather than a number.
const LONG_TEXT_VALUE_CLASS = "mt-2 text-base font-semibold leading-snug text-ink-2 sm:text-lg";

export function StatCard({
  label,
  value,
  description,
  tone = "neutral",
  icon: Icon,
  href,
}: {
  label: string;
  value: ReactNode;
  description?: ReactNode;
  /** Drives only the small icon chip (see TONE_ICON_CLASS) - the card itself never changes background/border by tone. */
  tone?: BadgeTone;
  icon?: LucideIcon;
  /** Nav-restructure pass: when present, the whole card becomes a real link to a real filtered destination (e.g. a Dashboard snapshot card linking to /estimates?status=sent) - never a decorative click target with nowhere to go. */
  href?: string;
}) {
  const isLongTextValue = typeof value === "string" && value.length > 10;

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className={kpiLabelClass}>{label}</p>
        {Icon ? (
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${TONE_ICON_CLASS[tone]}`}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
        ) : null}
      </div>
      <p className={isLongTextValue ? LONG_TEXT_VALUE_CLASS : kpiValueClass}>{value}</p>
      {description ? <p className={kpiDescriptionClass}>{description}</p> : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={`block ${cardClass} p-4 transition-colors duration-150 sm:p-5 hover:border-line-strong hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
      >
        {content}
      </Link>
    );
  }

  return <div className={`${cardClass} p-4 sm:p-5`}>{content}</div>;
}
