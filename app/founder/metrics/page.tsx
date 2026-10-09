import { LineChart } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { SectionCard } from "@/lib/ui/section-card";
import { StatCard, StatGrid } from "@/lib/ui/stat-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge } from "@/lib/ui/badge";
import { getFounderMrrEntries } from "@/lib/founder/queries";
import { MRR_KIND_LABELS, addMonthsKey, mrrHistory, mrrSnapshot } from "@/lib/founder/model";
import { formatMoney, formatMonthKey, formatSignedMoney } from "@/lib/founder/format";
import { requireFounderPage, LoadFailed, ManualDataNote } from "../_components/page-parts";
import { DeleteMrrEntryButton, MrrEntryForm } from "../_components/mrr-controls";

/**
 * MRR & metrics from manual entries: current MRR, this month's new,
 * expansion, churn and contraction, net new, one-time revenue, and a
 * monthly history. Actuals and forecasts are computed and shown apart.
 */
export default async function FounderMetricsPage() {
  const { supabase, userId, monthKey } = await requireFounderPage();
  const result = await getFounderMrrEntries(supabase, userId);
  const entries = result.ok ? result.data : [];
  const snapshot = mrrSnapshot(entries, monthKey);
  const lastForecast = entries.filter((entry) => entry.isForecast).reduce<string | null>((max, entry) => (max == null || entry.month > max ? entry.month : max), null);
  const historyEnd = lastForecast && lastForecast > monthKey ? (lastForecast < addMonthsKey(monthKey, 12) ? lastForecast : addMonthsKey(monthKey, 12)) : monthKey;
  const history = mrrHistory(entries, addMonthsKey(monthKey, -11), historyEnd).reverse();
  const hasForecast = entries.some((entry) => entry.isForecast);

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader eyebrow="Founder" title="MRR & metrics" description="Your company's recurring revenue, from entries you record here." />
      {!result.ok ? (
        <LoadFailed what="Your MRR entries" />
      ) : (
        <>
          <ManualDataNote />
          {snapshot ? (
            <StatGrid>
              <StatCard label="Current MRR" value={formatMoney(snapshot.mrr)} description={`Was ${formatMoney(snapshot.previousMrr)} last month`} tone="success" icon={LineChart} />
              <StatCard label={`Net new · ${formatMonthKey(monthKey)}`} value={formatSignedMoney(snapshot.netNew)} description={`${formatMoney(snapshot.new)} new + ${formatMoney(snapshot.expansion)} expansion`} />
              <StatCard label="Churned + contraction" value={formatMoney(snapshot.churn + snapshot.contraction)} description={`${formatMoney(snapshot.churn)} churned · ${formatMoney(snapshot.contraction)} contraction`} tone={snapshot.churn + snapshot.contraction > 0 ? "danger" : "neutral"} />
              <StatCard label="One-time revenue" value={formatMoney(snapshot.oneTime)} description="This month, not recurring" />
            </StatGrid>
          ) : (
            <EmptyState icon={LineChart} title="No actual MRR recorded" description="Start with a Starting MRR entry for your current month, then record new, expansion, contraction and churn as they happen." />
          )}

          <SectionCard title="Add an entry" description="Amounts are monthly recurring values, except one-time revenue.">
            <MrrEntryForm currentMonth={monthKey} />
          </SectionCard>

          {entries.length ? (
            <SectionCard title="Monthly history" description={hasForecast ? "Actuals, with forecasts in their own columns." : "Last 12 months, actuals."}>
              <div className="-mx-1 overflow-x-auto px-1">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs font-medium text-ink-3">
                      <th scope="col" className="py-2 pr-3 font-medium">Month</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">New</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Expansion</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Churn + contr.</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Net new</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">One-time</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">MRR (actual)</th>
                      {hasForecast ? <th scope="col" className="py-2 text-right font-medium">MRR (with forecast)</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((month) => (
                      <tr key={month.month} className={`border-b border-line/70 ${month.month > monthKey ? "text-ink-3" : ""}`}>
                        <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">
                          {formatMonthKey(month.month)}
                          {month.month > monthKey ? <span className="ml-1.5 text-xs font-normal text-ink-3">future</span> : null}
                        </th>
                        <td className="py-2 pr-3 text-right tabular-nums">{month.hasActuals ? formatMoney(month.new) : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{month.hasActuals ? formatMoney(month.expansion) : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{month.hasActuals ? formatMoney(month.churn + month.contraction) : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{month.hasActuals ? formatSignedMoney(month.netNew) : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{month.hasActuals ? formatMoney(month.oneTime) : "—"}</td>
                        <td className="py-2 pr-3 text-right font-medium tabular-nums text-ink">{month.month > monthKey ? "—" : formatMoney(month.mrr)}</td>
                        {hasForecast ? <td className="py-2 text-right tabular-nums">{month.forecastMrr != null ? formatMoney(month.forecastMrr) : "—"}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ) : null}

          {entries.length ? (
            <SectionCard title="Entries" description="Every figure above comes from these.">
              <ul className="divide-y divide-line">
                {entries.map((entry) => (
                  <li key={entry.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-ink">
                        {MRR_KIND_LABELS[entry.kind]}
                        {entry.customer ? <span className="text-ink-2"> · {entry.customer}</span> : null}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                        {formatMonthKey(entry.month, true)}
                        {entry.description ? ` · ${entry.description}` : ""}
                        <Badge tone="neutral">Manual</Badge>
                        {entry.isForecast ? <Badge tone="info">Forecast</Badge> : <Badge tone="success">Actual</Badge>}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-medium tabular-nums text-ink">{entry.kind === "churn" || entry.kind === "contraction" ? `−${formatMoney(entry.amount)}` : formatMoney(entry.amount)}</p>
                    <DeleteMrrEntryButton id={entry.id} label={`${MRR_KIND_LABELS[entry.kind]} ${formatMonthKey(entry.month)}`} />
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </>
      )}
    </div>
  );
}
