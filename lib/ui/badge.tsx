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
  // Final redesign: every tone carries a faint inset ring of its own
  // border color, so a pill keeps its edge on any row fill - a neutral pill
  // no longer disappears into a hovered row.
  neutral: "bg-inset text-ink-2 inset-ring-line-strong/80",
  // Final visual polish pass: the app's one accent token set (globals.css)
  // instead of a bare emerald-* pair, so every "success" badge app-wide
  // shares the exact same green with StatCard's success tone and the new
  // accent button.
  success: "bg-accent-muted text-accent-text inset-ring-accent-border/70",
  // Trackpr 2.0, Phase 3A: info/warning/danger now reference the same
  // globals.css semantic token families as success (--accent) does, rather
  // than bare Tailwind color literals - identical rendered colors (amber-50/
  // amber-700, red-50/red-700, blue-50/blue-700), now from one named source
  // of truth instead of three scattered literals.
  info: "bg-info-muted text-info-text inset-ring-info-border/70",
  warning: "bg-warning-muted text-warning-text inset-ring-warning-border/70",
  danger: "bg-danger-muted text-danger-text inset-ring-danger-border/70",
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
  neutral: "border-l-line",
  info: "border-l-line",
  success: "border-l-accent",
  warning: "border-l-warning",
  danger: "border-l-danger",
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
  // Trackpr 2.0 (step 2G): the dark-surface tone map that used to live here
  // was removed once its last consumer (the /demo sidebar) moved onto the
  // light system - every badge now sits on a light surface.
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium leading-4 inset-ring ${TONE_CLASS[tone]} ${className}`}>
      {Icon ? <Icon className="h-3 w-3 shrink-0" aria-hidden /> : null}
      {children}
    </span>
  );
}
