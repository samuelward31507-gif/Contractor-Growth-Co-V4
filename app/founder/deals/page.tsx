import Link from "next/link";
import { Handshake, Search } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { StatCard, StatGrid } from "@/lib/ui/stat-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge } from "@/lib/ui/badge";
import { inputClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { getFounderDeals } from "@/lib/founder/queries";
import { DEAL_STAGES, DEAL_STAGE_LABELS, OPEN_DEAL_STAGES, filterDeals, pipelineSummary, type DealStage, type FounderDeal } from "@/lib/founder/model";
import { formatDateKey, formatDateTime, formatMoney } from "@/lib/founder/format";
import { requireFounderPage, LoadFailed } from "../_components/page-parts";
import { AddDealButton, DealControls } from "../_components/deal-controls";

type StageFilter = DealStage | "open" | "all";
const STAGE_FILTERS: { id: StageFilter; label: string }[] = [{ id: "open", label: "Open" }, { id: "all", label: "All" }, ...DEAL_STAGES.map((stage) => ({ id: stage, label: DEAL_STAGE_LABELS[stage] }))];

function DealCard({ deal, timeZone, todayKey, now }: { deal: FounderDeal; timeZone: string; todayKey: string; now: Date }) {
  const followUpOverdue = deal.nextActionAt != null && new Date(deal.nextActionAt) < now && OPEN_DEAL_STAGES.includes(deal.stage);
  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{deal.name}</p>
          {deal.contactName || deal.contactEmail ? <p className="truncate text-xs text-ink-3">{[deal.contactName, deal.contactEmail].filter(Boolean).join(" · ")}</p> : null}
        </div>
        {deal.stage === "won" && deal.wonAmount != null ? (
          <Badge tone="success">{formatMoney(deal.wonAmount)}</Badge>
        ) : deal.expectedMrr != null ? (
          <span className="shrink-0 text-xs font-medium tabular-nums text-ink-2">{formatMoney(deal.expectedMrr)}/mo</span>
        ) : null}
      </div>
      {deal.stage === "won" && deal.wonOn ? <p className="mt-1.5 text-xs text-ink-3">Won {formatDateKey(deal.wonOn, { month: "short", day: "numeric", year: "numeric" })}</p> : null}
      {deal.stage === "lost" && deal.lostReason ? <p className="mt-1.5 text-xs text-ink-3">Lost: {deal.lostReason}</p> : null}
      {deal.nextAction || deal.nextActionAt ? (
        <p className={`mt-1.5 text-xs ${followUpOverdue ? "font-medium text-danger-text" : "text-ink-2"}`}>
          Next: {deal.nextAction ?? "Follow up"}
          {deal.nextActionAt ? ` · ${formatDateTime(deal.nextActionAt, timeZone)}` : ""}
        </p>
      ) : null}
      <div className="mt-2 border-t border-line pt-2">
        <DealControls deal={deal} timeZone={timeZone} todayKey={todayKey} />
      </div>
    </li>
  );
}

/** The sales pipeline: stages Lead → Won/Lost, next actions and follow-ups, search and stage filter. */
export default async function FounderDealsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.slice(0, 200) : "";
  const stage = (STAGE_FILTERS.find((f) => f.id === params.stage)?.id ?? "open") as StageFilter;
  const { supabase, userId, timeZone, now, todayKey, monthKey } = await requireFounderPage();
  const result = await getFounderDeals(supabase, userId);
  const deals = result.ok ? result.data : [];
  const summary = pipelineSummary(deals, monthKey);
  const visible = filterDeals(deals, query, stage);
  const columns = (stage === "open" ? OPEN_DEAL_STAGES : stage === "all" ? [...DEAL_STAGES] : [stage]) as DealStage[];
  const qs = (next: Partial<{ q: string; stage: string }>) => {
    const sp = new URLSearchParams();
    const q = next.q ?? query;
    if (q) sp.set("q", q);
    sp.set("stage", next.stage ?? stage);
    return `/founder/deals?${sp.toString()}`;
  };

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader eyebrow="Founder" title="Deals" description="Your own sales pipeline - separate from your clients' leads in Trackpr." action={<AddDealButton timeZone={timeZone} todayKey={todayKey} />} />

      {!result.ok ? (
        <LoadFailed what="Your deals" />
      ) : (
        <>
          <StatGrid>
            <StatCard label="Open deals" value={summary.openCount} description={summary.openWithoutValue ? `${summary.openWithoutValue} without an expected MRR` : "In Lead through Negotiation"} icon={Handshake} />
            <StatCard label="Open pipeline" value={summary.openExpectedMrr != null ? `${formatMoney(summary.openExpectedMrr)}/mo` : "—"} description="Expected MRR across open deals" />
            <StatCard label="Won this month" value={summary.wonThisMonthCount} description={summary.wonThisMonthCount ? `${formatMoney(summary.wonThisMonthAmount)} won` : "Nothing won yet this month"} tone="success" />
            <StatCard label="Lost" value={summary.byStage.lost} description="All time" />
          </StatGrid>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <form action="/founder/deals" role="search" className="flex w-full gap-2 lg:max-w-sm">
              <input type="hidden" name="stage" value={stage} />
              <label htmlFor="deal-search" className="sr-only">Search deals</label>
              <input id="deal-search" name="q" defaultValue={query} placeholder="Search name, contact, notes…" className={`${inputClass} flex-1`} />
              <button type="submit" className={secondaryButtonAutoClass} aria-label="Search">
                <Search className="h-4 w-4" aria-hidden />
              </button>
            </form>
            <nav aria-label="Stage filter" className="-mx-1 flex gap-1 overflow-x-auto px-1">
              {STAGE_FILTERS.map((f) => (
                <Link
                  key={f.id}
                  href={qs({ stage: f.id })}
                  aria-current={f.id === stage ? "page" : undefined}
                  className={`inline-flex min-h-9 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors ${f.id === stage ? "border-ink bg-ink text-white" : "border-line text-ink-2 hover:border-line-strong"}`}
                >
                  {f.label}
                  {f.id !== "open" && f.id !== "all" ? <span className="ml-1 tabular-nums opacity-70">{summary.byStage[f.id]}</span> : null}
                </Link>
              ))}
            </nav>
          </div>

          {deals.length === 0 ? (
            <EmptyState icon={Handshake} title="No deals yet" description="Add your first deal to start tracking the pipeline, next actions and follow-ups." />
          ) : visible.length === 0 ? (
            <EmptyState icon={Search} title="No deals match" description={query ? `Nothing matches "${query}" in this stage.` : "No deals in this stage."} action={<Link href="/founder/deals" className={secondaryButtonAutoClass}>Clear filters</Link>} />
          ) : (
            <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
              <div className="flex gap-4" style={{ minWidth: columns.length > 1 ? `${columns.length * 272}px` : undefined }}>
                {columns.map((column) => {
                  const inColumn = visible.filter((deal) => deal.stage === column);
                  return (
                    <section key={column} aria-labelledby={`stage-${column}`} className="flex w-full min-w-[256px] flex-1 flex-col rounded-xl bg-inset/60 p-2">
                      <h2 id={`stage-${column}`} className="flex items-center justify-between px-1.5 py-1 text-xs font-semibold text-ink-2">
                        {DEAL_STAGE_LABELS[column]}
                        <span className="tabular-nums text-ink-3">{inColumn.length}</span>
                      </h2>
                      {inColumn.length ? (
                        <ul className="mt-1 space-y-2">
                          {inColumn.map((deal) => (
                            <DealCard key={deal.id} deal={deal} timeZone={timeZone} todayKey={todayKey} now={now} />
                          ))}
                        </ul>
                      ) : (
                        <p className="px-1.5 py-3 text-xs text-ink-3">No deals here.</p>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
