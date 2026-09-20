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
import type { LucideIcon } from "lucide-react";
import type { BadgeTone } from "./badge";
import { kpiLabelClass, kpiValueClass, kpiDescriptionClass } from "./typography";

const TONE_ICON_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-500",
  info: "bg-blue-50 text-blue-600",
  success: "bg-accent-muted text-accent-text",
  warning: "bg-amber-50 text-amber-600",
  danger: "bg-red-50 text-red-600",
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
  return <div className={`grid grid-cols-1 gap-4 ${COLS[columns]} ${className}`}>{children}</div>;
}

export function StatCard({
  label,
  value,
  description,
  tone = "neutral",
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  description?: ReactNode;
  /** Drives only the small icon chip (see TONE_ICON_CLASS) - the card itself never changes background/border by tone. */
  tone?: BadgeTone;
  icon?: LucideIcon;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <p className={kpiLabelClass}>{label}</p>
        {Icon ? (
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${TONE_ICON_CLASS[tone]}`}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
        ) : null}
      </div>
      <p className={kpiValueClass}>{value}</p>
      {description ? <p className={kpiDescriptionClass}>{description}</p> : null}
    </div>
  );
}
