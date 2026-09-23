/**
 * A minimal magnitude comparison - one neutral hue, length is the only
 * encoding, every value directly labeled in text. Not a categorical chart
 * (no per-item color assignment, so no palette/colorblind-safety concerns
 * apply): identity comes from the adjacent text label, not from color, per
 * this app's "simple bar/number comparison beats a fancy chart" brief. Used
 * for status/category breakdowns with more than a couple of buckets, where a
 * bare number list would make the relative sizes hard to read at a glance.
 */
export function BarList({ items }: { items: { key: string; label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((item) => item.value));

  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-3">
          <span className="w-32 shrink-0 truncate text-xs text-slate-600 sm:w-40" title={item.label}>
            {item.label}
          </span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden>
            <span className="block h-full rounded-full bg-slate-400" style={{ width: `${(item.value / max) * 100}%` }} />
          </span>
          <span className="w-10 shrink-0 text-right text-xs font-medium tabular-nums text-slate-700">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}
