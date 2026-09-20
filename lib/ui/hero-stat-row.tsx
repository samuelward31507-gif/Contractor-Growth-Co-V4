/**
 * The list-page overview primitive that replaced "N identical StatCards in a
 * row" on Leads/Appointments/Estimates/Jobs: one stat - whichever number on
 * that page means "look at this first" - gets pulled out into an emphasized,
 * tone-tinted callout at real size; the rest sit together in a quieter
 * divided strip beside it. A uniform grid of same-sized boxes gives every
 * number identical visual weight regardless of what it means; this primitive
 * exists so each list page can say which number is actually the important
 * one, without every page re-inventing its own bespoke "emphasized card"
 * markup (the duplication this replaces).
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type HeroStatTone = "danger" | "warning" | "success" | "info" | "neutral";

const HERO_TONE_CLASS: Record<HeroStatTone, { border: string; bg: string; iconBg: string; iconText: string; labelText: string; valueText: string }> = {
  danger: { border: "border-red-100", bg: "bg-red-50/60", iconBg: "bg-red-100", iconText: "text-red-600", labelText: "text-red-700/70", valueText: "text-red-700" },
  warning: { border: "border-amber-100", bg: "bg-amber-50/60", iconBg: "bg-amber-100", iconText: "text-amber-600", labelText: "text-amber-700/70", valueText: "text-amber-700" },
  success: { border: "border-accent-border", bg: "bg-accent-muted/60", iconBg: "bg-accent-muted", iconText: "text-accent-text", labelText: "text-accent-text/70", valueText: "text-accent-text" },
  info: { border: "border-blue-100", bg: "bg-blue-50/60", iconBg: "bg-blue-100", iconText: "text-blue-600", labelText: "text-blue-700/70", valueText: "text-blue-700" },
  neutral: { border: "border-slate-200", bg: "bg-slate-50", iconBg: "bg-slate-100", iconText: "text-slate-600", labelText: "text-slate-500", valueText: "text-slate-900" },
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
    <div className={`grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,220px)_1fr]`}>
      <div className={`flex items-center gap-4 rounded-xl border p-5 ${style.border} ${style.bg}`}>
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${style.iconBg} ${style.iconText}`}>
          <HeroIcon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          {/* Wraps rather than truncates - "Awaiting response" was clipping
              to "AWAITING RESPON…" in the 220px hero column at desktop
              width; a real label losing information reads worse than a
              two-line label. */}
          <p className={`text-[11px] font-semibold uppercase tracking-wider ${style.labelText}`}>{hero.label}</p>
          <p className={`mt-0.5 text-3xl font-bold tracking-tight tabular-nums ${style.valueText}`}>{hero.value}</p>
        </div>
      </div>

      {/* Two columns on mobile (each stat gets real width to breathe),
          one row of N on sm+ - a fixed N-wide single row was clipping longer
          labels ("Completed value", "Total estimates") at 390px. */}
      <div
        className={`grid grid-cols-2 divide-x divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white sm:divide-y-0 ${SECONDARY_SM_COLS[secondary.length] ?? "sm:grid-cols-4"}`}
      >
        {secondary.map((stat) => (
          <div key={stat.label} className="flex min-w-0 flex-col justify-center gap-1 px-4 py-4 sm:px-5">
            <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {stat.icon ? <stat.icon className="h-3 w-3 shrink-0" aria-hidden /> : null}
              <span className="truncate">{stat.label}</span>
            </p>
            <p className="truncate text-2xl font-semibold tabular-nums text-slate-900">{stat.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
