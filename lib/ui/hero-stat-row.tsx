/**
 * The list-page overview primitive that replaced "N identical StatCards in a
 * row" on Leads/Appointments/Estimates/Jobs: one stat - whichever number on
 * that page means "look at this first" - gets pulled out at real size; the
 * rest sit together in a quieter divided strip beside it. A uniform grid of
 * same-sized boxes gives every number identical visual weight regardless of
 * what it means; this primitive exists so each list page can say which
 * number is actually the important one, without every page re-inventing its
 * own bespoke "emphasized" markup.
 *
 * Trackpr 2.0 full redesign: the hero used to sit in a bordered,
 * tone-tinted box - exactly the "giant colored KPI tile" the redesign brief
 * called out to avoid. It's now unboxed: a colored icon mark plus large
 * tabular-numeral type carries the emphasis, matching the rest of the app's
 * "Level 1/2" containment (page canvas, flush groups) rather than a card.
 * The secondary strip keeps its one hairline container, since a row of
 * plain numbers with no edge at all would bleed into the content below it.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { numericDisplayClass } from "./typography";
import { cardClass } from "./surface";

export type HeroStatTone = "danger" | "warning" | "success" | "info" | "neutral";

const HERO_TONE_CLASS: Record<HeroStatTone, { iconBg: string; iconText: string; valueText: string }> = {
  danger: { iconBg: "bg-danger-muted", iconText: "text-danger-text", valueText: "text-ink" },
  warning: { iconBg: "bg-warning-muted", iconText: "text-warning-text", valueText: "text-ink" },
  success: { iconBg: "bg-accent-muted", iconText: "text-accent-text", valueText: "text-ink" },
  info: { iconBg: "bg-info-muted", iconText: "text-info-text", valueText: "text-ink" },
  neutral: { iconBg: "bg-inset", iconText: "text-ink-2", valueText: "text-ink" },
};

// Tailwind needs the full class name present in source to generate it - an
// interpolated `sm:grid-cols-${n}` would be purged. Every list page today
// passes 3 or 4 secondary stats; this covers headroom up to 6 without
// falling back to the inline-style-per-column-count this replaced.
const SECONDARY_SM_COLS: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-5",
  6: "sm:grid-cols-6",
};

export function HeroStatRow({
  hero,
  secondary,
}: {
  hero: { label: string; value: ReactNode; icon: LucideIcon; tone: HeroStatTone };
  secondary: { label: string; value: ReactNode; icon?: LucideIcon }[];
}) {
  const style = HERO_TONE_CLASS[hero.tone];
  const HeroIcon = hero.icon;

  return (
    <div className={`grid grid-cols-1 gap-6 sm:grid-cols-[minmax(0,220px)_1fr] sm:items-center`}>
      <div className="flex items-center gap-4">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${style.iconBg} ${style.iconText}`}>
          <HeroIcon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          {/* Wraps rather than truncates - "Awaiting response" was clipping
              to "AWAITING RESPON…" in the 220px hero column at desktop
              width; a real label losing information reads worse than a
              two-line label. */}
          <p className="text-xs font-medium text-ink-3">{hero.label}</p>
          <p className={`mt-0.5 text-[26px] font-semibold leading-tight tracking-[-0.02em] ${numericDisplayClass} ${style.valueText}`}>{hero.value}</p>
        </div>
      </div>

      {/* Two columns on mobile (each stat gets real width to breathe),
          one row of N on sm+ - a fixed N-wide single row was clipping longer
          labels ("Completed value", "Total estimates") at 390px. */}
      <div
        className={`grid grid-cols-2 divide-x divide-y divide-line overflow-hidden ${cardClass} sm:divide-y-0 ${SECONDARY_SM_COLS[secondary.length] ?? "sm:grid-cols-4"}`}
      >
        {secondary.map((stat) => (
          <div key={stat.label} className="flex min-w-0 flex-col justify-center gap-1 px-4 py-4 sm:px-5">
            <p className="flex items-center gap-1 text-xs font-medium text-ink-3">
              {stat.icon ? <stat.icon className="h-3 w-3 shrink-0" aria-hidden /> : null}
              <span className="truncate">{stat.label}</span>
            </p>
            <p className={`truncate text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink ${numericDisplayClass}`}>{stat.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
