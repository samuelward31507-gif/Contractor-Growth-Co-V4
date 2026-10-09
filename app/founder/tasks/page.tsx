import Link from "next/link";
import { ListChecks } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { Panel } from "@/lib/ui/section-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { segmentedItemClass, segmentedTrackClass } from "@/lib/ui/segmented";
import { getFounderDeals, getFounderItems } from "@/lib/founder/queries";
import { ITEM_VIEWS, filterItems, isOpenDeal, isOverdue, type ItemView } from "@/lib/founder/model";
import { requireFounderPage, LoadFailed } from "../_components/page-parts";
import { ItemList } from "../_components/item-list";
import { AddItemButton } from "../_components/add-item-button";

const EMPTY: Record<ItemView, { title: string; description: string }> = {
  today: { title: "Nothing for today", description: "Items due or scheduled today - and anything overdue - appear here." },
  upcoming: { title: "Nothing in the next two weeks", description: "Dated tasks, deadlines and meetings after today appear here." },
  overdue: { title: "Nothing overdue", description: "Open tasks, follow-ups and deadlines past their due time appear here." },
  open: { title: "No open items", description: "Add a task or capture one from Home." },
  done: { title: "Nothing completed in the last 30 days", description: "Completed tasks appear here." },
};

/** Tasks and events: create, edit, complete, delete; day / upcoming / overdue / open / completed views. */
export default async function FounderTasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const view = (ITEM_VIEWS.find((v) => v.id === params.view)?.id ?? "today") as ItemView;
  const { supabase, userId, timeZone, now, today } = await requireFounderPage();
  const since = new Date(today.start.getTime() - 30 * 86_400_000).toISOString();
  const [itemsResult, dealsResult] = await Promise.all([getFounderItems(supabase, userId, since), getFounderDeals(supabase, userId)]);
  const deals = dealsResult.ok ? dealsResult.data.filter(isOpenDeal).map((deal) => ({ id: deal.id, name: deal.name })) : [];
  const items = itemsResult.ok ? filterItems(itemsResult.data, view, now, today) : [];
  const overdueCount = itemsResult.ok ? itemsResult.data.filter((item) => isOverdue(item, now)).length : 0;

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader eyebrow="Founder" title="Tasks & events" description="Everything you've committed to - tasks, follow-ups, deadlines, meetings and events." action={<AddItemButton deals={deals} timeZone={timeZone} />} />
      <nav aria-label="Task views" className={segmentedTrackClass}>
        {ITEM_VIEWS.map((v) => (
          <Link key={v.id} href={`/founder/tasks?view=${v.id}`} aria-current={v.id === view ? "page" : undefined} className={segmentedItemClass(v.id === view)}>
            {v.label}
            {v.id === "overdue" && overdueCount > 0 ? <span className="ml-1.5 rounded-full bg-danger-muted px-1.5 text-[11px] font-semibold text-danger-text">{overdueCount}</span> : null}
          </Link>
        ))}
      </nav>
      {!itemsResult.ok ? (
        <LoadFailed what="Your tasks and events" />
      ) : items.length === 0 ? (
        <EmptyState icon={ListChecks} title={EMPTY[view].title} description={EMPTY[view].description} />
      ) : (
        <Panel>
          <ItemList items={items} deals={deals} timeZone={timeZone} nowIso={now.toISOString()} />
        </Panel>
      )}
    </div>
  );
}
