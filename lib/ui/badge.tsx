/**
 * The single badge/status-pill primitive for the whole app. Before this,
 * six-plus routes each hand-rolled their own near-identical pill
 * (leads/_components/badges.tsx, appointments/_components/status-badge.tsx,
 * conversations/_components/status-badge.tsx, estimates/.../status-badge.tsx,
 * jobs/.../status-badge.tsx, automations/.../status-pill.tsx,
 * agency/.../status-pill.tsx) - all with the same shape (rounded-full pill,
 * an icon, a tone color) and small, meaningless differences in padding/
 * radius/font-weight. This is the one implementation; every route maps its
 * own status enum to a `tone` here rather than inventing new pill markup.
 */
import type { LucideIcon } from "lucide-react";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-600",
  info: "bg-blue-50 text-blue-700",
  // Final visual polish pass: the app's one accent token set (globals.css)
  // instead of a bare emerald-* pair, so every "success" badge app-wide
  // shares the exact same green with StatCard's success tone and the new
  // accent button.
  success: "bg-accent-muted text-accent-text",
  warning: "bg-amber-50 text-amber-700",
  danger: "bg-red-50 text-red-700",
};

/**
 * A left-edge row-rail color per BadgeTone - a restrained, always-visible
 * status signal for list-page table rows (leads, appointments, estimates,
 * jobs) that doesn't depend on the reader parsing a text badge first.
 * Neutral/info stay a near-invisible slate hairline so the ordinary working
 * pipeline doesn't compete for attention; only a genuinely time-sensitive or
 * resolved state gets real color, so the rail stays meaningful rather than
 * turning into a decorative rainbow down the left edge of every table.
 */
export const RAIL_TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "border-l-slate-200",
  info: "border-l-slate-200",
  success: "border-l-emerald-400",
  warning: "border-l-amber-400",
  danger: "border-l-red-400",
};

export function Badge({
  tone = "neutral",
  icon: Icon,
  children,
  className = "",
}: {
  tone?: BadgeTone;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]} ${className}`}>
      {Icon ? <Icon className="h-3 w-3 shrink-0" aria-hidden /> : null}
      {children}
    </span>
  );
}
