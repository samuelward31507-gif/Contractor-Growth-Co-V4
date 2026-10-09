import Link from "next/link";
import { NotebookPen } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { SectionCard } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { inputClass, secondaryButtonAutoClass } from "@/lib/ui/form";
import { getFounderDeals, getFounderItems, getFounderReviews } from "@/lib/founder/queries";
import { dayRange, filterItems, toDealOptions } from "@/lib/founder/model";
import { formatDateKey } from "@/lib/founder/format";
import { requireFounderPage, LoadFailed } from "../_components/page-parts";
import { ReviewForm } from "../_components/review-form";
import { ItemList } from "../_components/item-list";

/**
 * The daily review: what got done, what's stuck, tomorrow's priorities -
 * one saved review per day, with that day's completed items and anything
 * still overdue alongside for reference.
 */
export default async function FounderReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { supabase, userId, timeZone, now, todayKey, today } = await requireFounderPage();
  const requested = typeof params.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.date) && !Number.isNaN(Date.parse(`${params.date}T00:00:00Z`)) && params.date <= todayKey ? params.date : todayKey;
  const day = dayRange(requested, timeZone);
  const since = new Date(Math.min(day.start.getTime(), today.start.getTime() - 30 * 86_400_000)).toISOString();

  const [reviewsResult, itemsResult, dealsResult] = await Promise.all([getFounderReviews(supabase, userId, 60), getFounderItems(supabase, userId, since), getFounderDeals(supabase, userId)]);
  const reviews = reviewsResult.ok ? reviewsResult.data : [];
  const review = reviews.find((r) => r.reviewDate === requested) ?? null;
  const items = itemsResult.ok ? itemsResult.data : [];
  const completedThatDay = items.filter((item) => item.completedAt != null && new Date(item.completedAt) >= day.start && new Date(item.completedAt) < day.end);
  const overdue = filterItems(items, "overdue", now, today);
  const deals = dealsResult.ok ? toDealOptions(dealsResult.data) : [];

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader eyebrow="Founder" title="Daily review" description="Close the day: wins, blockers and tomorrow's priorities." />
      <form action="/founder/review" className="flex items-end gap-2">
        <div className="space-y-1.5">
          <label htmlFor="review-date" className="text-sm font-medium text-ink-2">Day</label>
          <input id="review-date" name="date" type="date" max={todayKey} defaultValue={requested} className={inputClass} />
        </div>
        <button type="submit" className={secondaryButtonAutoClass}>Open</button>
      </form>

      {!reviewsResult.ok ? (
        <LoadFailed what="Your reviews" />
      ) : (
        <SectionCard title={formatDateKey(requested)} description={review ? "Saved - edit and save again to update." : "Not reviewed yet."}>
          <ReviewForm reviewDate={requested} review={review} />
        </SectionCard>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard title="Completed that day">
          {!itemsResult.ok ? (
            <LoadFailed what="Your tasks" />
          ) : completedThatDay.length ? (
            <ItemList items={completedThatDay} deals={deals} timeZone={timeZone} nowIso={now.toISOString()} />
          ) : (
            <p className="text-sm text-ink-3">Nothing was marked complete that day.</p>
          )}
        </SectionCard>
        <SectionCard title="Still overdue">
          {!itemsResult.ok ? null : overdue.length ? <ItemList items={overdue} deals={deals} timeZone={timeZone} nowIso={now.toISOString()} /> : <p className="text-sm text-ink-3">Nothing overdue.</p>}
        </SectionCard>
      </div>

      {reviewsResult.ok ? (
        <SectionCard title="Past reviews">
          {reviews.length ? (
            <ul className="divide-y divide-line">
              {reviews.map((r) => (
                <li key={r.id} className="py-2.5">
                  <Link href={`/founder/review?date=${r.reviewDate}`} className="text-sm font-medium text-ink hover:underline">
                    {formatDateKey(r.reviewDate, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                  </Link>
                  {r.wins ? <p className="mt-0.5 line-clamp-1 text-xs text-ink-3">Wins: {r.wins}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={NotebookPen} title="No reviews yet" description="Your saved daily reviews will be listed here." />
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
