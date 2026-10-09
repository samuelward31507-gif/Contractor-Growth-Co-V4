import Link from "next/link";
import { Handshake, NotebookPen } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { SectionCard } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge } from "@/lib/ui/badge";
import { inputClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { getFounderDeals, getFounderFocus, getFounderItems, getFounderReviews } from "@/lib/founder/queries";
import { DEAL_STAGE_LABELS, SCHEDULED_KINDS, addDaysKey, dayRange, isDateKey, sortByTimeThenPriority, toDealOptions, type FounderDeal } from "@/lib/founder/model";
import { prioritiesFor, reviewDay } from "@/lib/founder/daily";
import { formatDateKey, formatMoney } from "@/lib/founder/format";
import { buildEndOfDaySummary } from "@/lib/founder/intelligence";
import { requireFounderPage, LoadFailed } from "../_components/page-parts";
import { ReviewForm } from "../_components/review-form";
import { ItemList } from "../_components/item-list";
import { DailyPriorities } from "../_components/daily-priorities";
import { MoveToDayButton } from "../_components/move-to-day";

const SUBHEAD = "text-xs font-semibold uppercase tracking-wide text-ink-3";

function DealLine({ deal, note }: { deal: FounderDeal; note: string }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <Link href={`/founder/deals?deal=${deal.id}`} className="flex min-w-0 items-center gap-1.5 font-medium text-ink hover:underline">
        <Handshake className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
        <span className="truncate">{deal.name}</span>
      </Link>
      <span className="shrink-0 text-xs text-ink-3">{note}</span>
    </li>
  );
}

/**
 * The end-of-day closeout, in the order it's done: what got finished, what's
 * still open (move each to tomorrow with one click - never automatically),
 * tomorrow's three priorities, what changed in the pipeline, then a few
 * notes. One saved review per day (founder_reviews); past days stay readable.
 */
export default async function FounderReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { supabase, userId, timeZone, now, todayKey, today } = await requireFounderPage();
  const requested = isDateKey(params.date) && params.date <= todayKey ? params.date : todayKey;
  const isToday = requested === todayKey;
  const tomorrowKey = addDaysKey(requested, 1);
  const day = dayRange(requested, timeZone);
  const since = new Date(Math.min(day.start.getTime(), today.start.getTime() - 30 * 86_400_000)).toISOString();

  const [reviewsResult, itemsResult, dealsResult, focusResult] = await Promise.all([
    getFounderReviews(supabase, userId, 60),
    getFounderItems(supabase, userId, since),
    getFounderDeals(supabase, userId),
    getFounderFocus(supabase, userId, requested, tomorrowKey),
  ]);
  const reviews = reviewsResult.ok ? reviewsResult.data : [];
  const review = reviews.find((r) => r.reviewDate === requested) ?? null;
  const items = itemsResult.ok ? itemsResult.data : [];
  const deals = dealsResult.ok ? dealsResult.data : [];
  const dealOptions = toDealOptions(deals);
  const closeout = reviewDay({ items, deals, dayKey: requested, timeZone });
  const tomorrowPriorities = focusResult.ok ? prioritiesFor(items, focusResult.data.focus, tomorrowKey) : [];
  const candidates = sortByTimeThenPriority(items.filter((item) => item.completedAt == null && !SCHEDULED_KINDS.includes(item.kind) && !tomorrowPriorities.includes(item)));
  const summary = buildEndOfDaySummary({ items, deals, focus: focusResult.ok ? focusResult.data.focus : [], dayKey: requested, timeZone });
  const nowIso = now.toISOString();
  const { pipeline } = closeout;
  const pipelineCount = pipeline.created.length + pipeline.won.length + pipeline.lost.length + pipeline.updated.length;
  const dayName = isToday ? "today" : formatDateKey(requested, { weekday: "long", month: "short", day: "numeric" });

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader eyebrow="Founder" title="End-of-day review" description="Close out the day in a few minutes, so tomorrow starts clear." />
      <form action="/founder/review" className="flex items-end gap-2">
        <div className="space-y-1.5">
          <label htmlFor="review-date" className="text-sm font-medium text-ink-2">Day</label>
          <input id="review-date" name="date" type="date" max={todayKey} defaultValue={requested} className={inputClass} />
        </div>
        <button type="submit" className={secondaryButtonAutoClass}>Open</button>
      </form>

      {!itemsResult.ok ? <LoadFailed what="Your tasks" /> : null}

      {/* The day in one line - only what the records confirm (completions stamped that day, items still open, deal edits, priorities as set). */}
      {itemsResult.ok && dealsResult.ok && focusResult.ok ? (
        <section aria-labelledby="day-summary" className="rounded-xl border border-line bg-surface px-4 py-3">
          <h2 id="day-summary" className={SUBHEAD}>{isToday ? "Today so far" : "That day"}</h2>
          <p className="mt-1 text-sm text-ink">{summary.sentence}</p>
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard title={`1. Done ${dayName}`} description={itemsResult.ok ? `${closeout.completed.length} item${closeout.completed.length === 1 ? "" : "s"} completed` : undefined}>
          {!itemsResult.ok ? null : closeout.completed.length ? (
            <ItemList items={closeout.completed} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} />
          ) : (
            <p className="text-sm text-ink-3">Nothing was marked complete {isToday ? "today" : "that day"}.</p>
          )}
        </SectionCard>

        <SectionCard title="2. Still open" description="Move what won't happen to tomorrow - nothing moves unless you choose it.">
          {!itemsResult.ok ? null : closeout.unfinished.length === 0 && closeout.stillOverdue.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing left open from {isToday ? "today" : "that day"}, and nothing overdue.</p>
          ) : (
            <div className="space-y-4">
              {[
                { label: `Due ${dayName}`, list: closeout.unfinished },
                { label: "Overdue from earlier", list: closeout.stillOverdue },
              ].map(({ label, list }) =>
                list.length ? (
                  <section key={label} aria-label={label}>
                    <h3 className={SUBHEAD}>{label}</h3>
                    <ul className="mt-1 divide-y divide-line">
                      {list.map((item) => (
                        <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                          <span className="min-w-0 truncate text-sm text-ink">{item.title}</span>
                          <MoveToDayButton item={item} dateKey={addDaysKey(todayKey, 1)} label="Move to tomorrow" />
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null,
              )}
            </div>
          )}
        </SectionCard>
      </div>

      {isToday ? (
        <SectionCard title="3. Tomorrow's priorities" description={formatDateKey(tomorrowKey)}>
          {!focusResult.ok ? (
            <LoadFailed what="Tomorrow's priorities" />
          ) : (
            <DailyPriorities dateKey={tomorrowKey} dayLabel="tomorrow" priorities={tomorrowPriorities} candidates={candidates} available={focusResult.data.available} />
          )}
        </SectionCard>
      ) : null}

      <SectionCard title={`${isToday ? "4" : "3"}. Pipeline ${dayName}`} description="What the deal records show changed - created, won, lost or edited that day.">
        {!dealsResult.ok ? (
          <LoadFailed what="Your deals" />
        ) : pipelineCount === 0 ? (
          <p className="text-sm text-ink-3">No deal was created, won, lost or edited {isToday ? "today" : "that day"}.</p>
        ) : (
          <ul className="divide-y divide-line">
            {pipeline.won.map((deal) => (
              <DealLine key={deal.id} deal={deal} note={`Won${deal.wonSetupFee != null && deal.wonMonthlyFee != null ? ` · ${formatMoney(deal.wonSetupFee, deal.currency)} setup + ${formatMoney(deal.wonMonthlyFee, deal.currency)}/mo agreed` : ""}`} />
            ))}
            {pipeline.created.map((deal) => (
              <DealLine key={deal.id} deal={deal} note={`New · ${DEAL_STAGE_LABELS[deal.stage]}`} />
            ))}
            {pipeline.lost.map((deal) => (
              <DealLine key={deal.id} deal={deal} note="Lost" />
            ))}
            {pipeline.updated.map((deal) => (
              <DealLine key={deal.id} deal={deal} note={`Updated · now ${DEAL_STAGE_LABELS[deal.stage]}`} />
            ))}
          </ul>
        )}
      </SectionCard>

      {!reviewsResult.ok ? (
        <LoadFailed what="Your reviews" />
      ) : (
        <SectionCard title={`${isToday ? "5" : "4"}. Notes`} description={review ? "Saved - edit and save again to update." : "Wins, blockers and anything to remember."}>
          <ReviewForm reviewDate={requested} review={review} />
        </SectionCard>
      )}

      {reviewsResult.ok ? (
        <SectionCard title="Past reviews">
          {reviews.length ? (
            <ul className="divide-y divide-line">
              {reviews.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                  <Link href={`/founder/review?date=${r.reviewDate}`} className="text-sm font-medium text-ink hover:underline">
                    {formatDateKey(r.reviewDate, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                  </Link>
                  {r.reviewDate === requested ? <Badge tone="neutral">Open</Badge> : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={NotebookPen} title="No reviews yet" description="Your saved end-of-day reviews will be listed here." />
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
