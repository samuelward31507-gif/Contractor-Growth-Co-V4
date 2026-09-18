export type Stat = { key: string; label: string; value: string };

/**
 * Shared label/value stat grid - the one layout primitive every agency
 * section (overview, automation activity, and every block on the client
 * detail page) is built from, so the page reads as one consistent system
 * rather than several different card styles.
 */
export function StatGrid({ stats, columns = "sm:grid-cols-4" }: { stats: Stat[]; columns?: string }) {
  return (
    <dl className={`grid grid-cols-2 gap-x-8 gap-y-5 ${columns}`}>
      {stats.map((stat) => (
        <div key={stat.key}>
          <dt className="text-xs text-slate-500">{stat.label}</dt>
          <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-slate-900">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}
