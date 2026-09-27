import { sectionLabelClass, metaClass } from "@/lib/ui/typography";
import { BarSeries } from "@/lib/ui/chart/bar-series";
import type { DailyCount } from "@/lib/bi/series";

function formatDayLabel(dateKey: string): string {
  // dateKey is a plain YYYY-MM-DD (lib/bi/series.ts's own local-day bucket
  // key) - the explicit T00:00:00 forces local-time parsing, matching how
  // the bucket itself was built, rather than letting a bare "YYYY-MM-DD"
  // string parse as UTC midnight and risk shifting a day at some offsets.
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Phase 6 (Trend chart pass): the one new visual - leads created per day
 * over the selected period, so "is this getting better or worse" has a
 * shape to look at instead of only the single current-period number
 * BusinessAtAGlance shows above it. Reads lib/bi/series.ts's
 * getLeadsCreatedPerDay (this whole redesign's only new query) - a separate,
 * smaller read from the main BusinessMetricsSnapshot every other section on
 * this page reads, so it's kept in its own component rather than folded
 * into business-metrics-sections.tsx (whose own header comment specifically
 * scopes it to "reads BusinessMetricsSnapshot and calculates nothing
 * itself").
 */
export function TrendSection({ series, failed }: { series: DailyCount[]; failed: boolean }) {
  const total = series.reduce((sum, point) => sum + point.count, 0);

  return (
    <div className="mt-6">
      <p className={sectionLabelClass}>Leads, day by day</p>
      <div className="mt-3">
        {failed ? (
          <p className="text-sm text-slate-500">Some information is temporarily unavailable. Please try again.</p>
        ) : (
          <BarSeries data={series.map((point) => ({ key: point.date, label: formatDayLabel(point.date), value: point.count }))} emptyLabel="No leads created in this range." />
        )}
      </div>
      <p className={`mt-3 ${metaClass}`}>
        {total} new lead{total === 1 ? "" : "s"} over this period, by the day they were created.
      </p>
    </div>
  );
}
