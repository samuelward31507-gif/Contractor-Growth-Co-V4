import type { LucideIcon } from "lucide-react";

export type Stat = { key: string; label: string; value: string; icon?: LucideIcon; tone?: "default" | "success" | "danger" | "warning" };

const VALUE_TONE: Record<NonNullable<Stat["tone"]>, string> = {
  default: "text-slate-900",
  // Final visual polish pass: the app's one accent token, restrained to a
  // handful of genuinely-positive counts (see incident-rollup.tsx,
  // automation-activity.tsx) - never the default for every stat.
  success: "text-accent-text",
  danger: "text-red-600",
  warning: "text-amber-600",
};

/** The exact null-rate string every formatRate() call in this app produces (see ./format.ts) - matched here only to mute its color, never its size/weight, so an unavailable rate still reads as a normal metric value rather than a separate alert. */
const UNAVAILABLE_VALUE = "Not enough data yet";

/**
 * The one metric-card primitive every Agency Command Center section is
 * built from - a real bordered card with a fixed height rhythm, not bare
 * text floating in a grid, so numbers read as a deliberate dashboard rather
 * than a first-pass list of stats.
 */
export function StatGrid({ stats, columns = "sm:grid-cols-4" }: { stats: Stat[]; columns?: string }) {
  return (
    <div className={`grid grid-cols-2 gap-2 ${columns}`}>
      {stats.map((stat) => {
        const Icon = stat.icon;
        const valueColor = stat.value === UNAVAILABLE_VALUE ? "text-slate-400" : VALUE_TONE[stat.tone ?? "default"];
        return (
          <div key={stat.key} className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10.5px] font-medium uppercase tracking-wide text-slate-500">{stat.label}</p>
              {Icon ? <Icon className="h-3 w-3 shrink-0 text-slate-300" aria-hidden /> : null}
            </div>
            <p className={`mt-1 text-lg font-semibold tracking-tight tabular-nums sm:text-xl ${valueColor}`}>{stat.value}</p>
          </div>
        );
      })}
    </div>
  );
}
