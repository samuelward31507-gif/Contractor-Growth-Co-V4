/**
 * Phase 6 (Trend chart pass): the one genuinely new visual primitive this
 * redesign adds - everywhere else (BarList in the Analytics page, QueueCard,
 * the Money screen) reuses an existing pattern. Still built the same way
 * BarList already established for this app ("simple bar/number comparison
 * beats a fancy chart," one neutral hue, no chart library, no per-item
 * color) - just plotted left-to-right over time instead of ranked by
 * magnitude. Deliberately dependency-free: this repo has no charting library
 * installed (verified directly against package.json), and a handful of
 * scaled <div>s is enough for a day-bucketed count series.
 *
 * When there are more bars than fit legibly, only every Nth x-axis label is
 * shown (never every single one crammed together) - the bar itself is still
 * rendered for every day, only the label beneath it is thinned out.
 */
export function BarSeries({
  data,
  emptyLabel = "No data for this range.",
}: {
  data: { key: string; label: string; value: number }[];
  emptyLabel?: string;
}) {
  if (data.length === 0) {
    return <p className="text-sm text-ink-3">{emptyLabel}</p>;
  }

  const max = Math.max(1, ...data.map((point) => point.value));
  const maxLabels = 10;
  const labelStride = Math.max(1, Math.ceil(data.length / maxLabels));

  return (
    <div>
      <div className="flex h-32 items-end gap-[3px]" role="img" aria-label={`Bar chart: ${data.map((point) => `${point.label} ${point.value}`).join(", ")}`}>
        {data.map((point) => (
          <div key={point.key} className="group/bar relative flex min-w-0 flex-1 flex-col items-center justify-end" aria-hidden>
            <div
              className="w-full rounded-t-sm bg-accent transition-colors group-hover/bar:bg-accent-strong"
              style={{ height: `${(point.value / max) * 100}%`, minHeight: point.value > 0 ? "2px" : "0" }}
            />
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs font-medium text-white opacity-0 shadow-popover transition-opacity group-hover/bar:opacity-100"
            >
              {point.label}: {point.value}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-[3px]">
        {data.map((point, index) => (
          <div key={point.key} className="min-w-0 flex-1 text-center text-[10px] text-ink-3">
            {index % labelStride === 0 ? <span className="truncate">{point.label}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
