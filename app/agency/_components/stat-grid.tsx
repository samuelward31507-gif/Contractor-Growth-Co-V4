import type { LucideIcon } from "lucide-react";

export type Stat = { key: string; label: string; value: string; icon?: LucideIcon; tone?: "default" | "danger" | "warning" };

const VALUE_TONE: Record<NonNullable<Stat["tone"]>, string> = {
  default: "text-slate-900",
  danger: "text-red-600",
  warning: "text-amber-600",
};

/**
 * The one metric-card primitive every Agency Command Center section is
 * built from - a real bordered card with a fixed height rhythm, not bare
 * text floating in a grid, so numbers read as a deliberate dashboard rather
 * than a first-pass list of stats.
 */
export function StatGrid({ stats, columns = "sm:grid-cols-4" }: { stats: Stat[]; columns?: string }) {
  return (
    <div className={`grid grid-cols-2 gap-3 ${columns}`}>
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div key={stat.key} className="rounded-lg border border-slate-200 bg-slate-50/60 px-3.5 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{stat.label}</p>
              {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden /> : null}
            </div>
            <p className={`mt-1.5 text-xl font-semibold tracking-tight tabular-nums sm:text-2xl ${VALUE_TONE[stat.tone ?? "default"]}`}>{stat.value}</p>
          </div>
        );
      })}
    </div>
  );
}
