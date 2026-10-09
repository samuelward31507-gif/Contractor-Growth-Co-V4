import Link from "next/link";
import { AlarmClock, CalendarDays, Handshake, LineChart, ListChecks, Sun } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { SectionCard } from "@/lib/ui/section-card";
import { StatCard, StatGrid } from "@/lib/ui/stat-card";
import { EmptyState } from "@/lib/ui/empty-state";
import { Badge } from "@/lib/ui/badge";
import { getFounderDeals, getFounderItems, getFounderMrrEntries } from "@/lib/founder/queries";
import {
  DEAL_STAGE_LABELS,
  MRR_KIND_LABELS,
  SCHEDULED_KINDS,
  dealsNeedingFollowUp,
  isOpenDeal,
  isOverdue,
  itemTime,
  mrrSnapshot,
  pipelineSummary,
  sortByTimeThenPriority,
} from "@/lib/founder/model";
import { formatDateKey, formatDateTime, formatMoney, formatMonthKey, formatSignedMoney } from "@/lib/founder/format";
import { requireFounderPage, LoadFailed, ManualDataNote } from "./_components/page-parts";
import { ItemList } from "./_components/item-list";
import { AddItemButton } from "./_components/add-item-button";
import { QuickCapture } from "./_components/quick-capture";

const LINK = "inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0";

/**
 * Founder home: the day at a glance. Everything here is the founder's own
 * data (founder_* tables) - today's schedule, priorities, follow-ups, open
 * deals, MRR and recent changes (manual), deadlines and overdue items - plus
 * quick capture. Each section reads independently; a failed read says so.
 */
export default async function FounderHomePage() {
  const ctx = await requireFounderPage();
  const { supabase, userId, timeZone, now, todayKey, today, monthKey } = ctx;
  const since = new Date(today.start.getTime() - 30 * 86_400_000).toISOString();

  const [itemsResult, dealsResult, mrrResult] = await Promise.all([
    getFounderItems(supabase, userId, since),
    getFounderDeals(supabase, userId),
    getFounderMrrEntries(supabase, userId),
  ]);

  const items = itemsResult.ok ? itemsResult.data : [];
  const open = items.filter((item) => item.completedAt == null);
  const inToday = (iso: string | null) => iso != null && new Date(iso) >= today.start && new Date(iso) < today.end;
  const schedule = sortByTimeThenPriority(open.filter((item) => SCHEDULED_KINDS.includes(item.kind) && inToday(item.startsAt)));
  const overdue = sortByTimeThenPriority(open.filter((item) => isOverdue(item, now)));
  const priorities = sortByTimeThenPriority(open.filter((item) => !SCHEDULED_KINDS.includes(item.kind) && !isOverdue(item, now) && (inToday(item.dueAt) || (item.priority === "high" && item.dueAt == null))));
  const weekEnd = new Date(today.end.getTime() + 7 * 86_400_000);
  const deadlines = sortByTimeThenPriority(open.filter((item) => item.kind === "deadline" && item.dueAt != null && new Date(item.dueAt) >= today.end && new Date(item.dueAt) < weekEnd));
  const followUpItems = open.filter((item) => item.kind === "follow_up" && (inToday(itemTime(item)) || isOverdue(item, now)));

  const deals = dealsResult.ok ? dealsResult.data : [];
  const dealOptions = deals.filter(isOpenDeal).map((deal) => ({ id: deal.id, name: deal.name }));
  const followUpDeals = dealsNeedingFollowUp(deals, today.end);
  const pipeline = pipelineSummary(deals, monthKey);
  const activeDeals = deals.filter(isOpenDeal).slice(0, 6);

  const snapshot = mrrResult.ok ? mrrSnapshot(mrrResult.data, monthKey) : null;
  const recentMrr = mrrResult.ok ? mrrResult.data.filter((entry) => !entry.isForecast).slice(0, 5) : [];
  const nowIso = now.toISOString();

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-8 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader
        eyebrow="Founder"
        title={formatDateKey(todayKey)}
        description="Your day: schedule, priorities, follow-ups, deals and revenue - only you can see this workspace."
        action={<AddItemButton deals={dealOptions} timeZone={timeZone} />}
      />

      <SectionCard title="Quick capture" description="Get it out of your head - sort it later in Tasks.">
        <QuickCapture />
      </SectionCard>

      <StatGrid>
        <StatCard label="Overdue" value={itemsResult.ok ? overdue.length : "—"} description={itemsResult.ok ? (overdue.length ? "Open items past due" : "Nothing overdue") : "Couldn't load"} tone={overdue.length ? "danger" : "neutral"} icon={AlarmClock} href="/founder/tasks?view=overdue" />
        <StatCard label="Today's schedule" value={itemsResult.ok ? schedule.length : "—"} description={itemsResult.ok ? "Events and meetings today" : "Couldn't load"} icon={CalendarDays} href="/founder/tasks?view=today" />
        <StatCard
          label="Open deals"
          value={dealsResult.ok ? pipeline.openCount : "—"}
          description={dealsResult.ok ? (pipeline.openExpectedMrr != null ? `${formatMoney(pipeline.openExpectedMrr)} expected MRR` : "No expected MRR entered") : "Couldn't load"}
          icon={Handshake}
          href="/founder/deals"
        />
        <StatCard
          label="Current MRR"
          value={!mrrResult.ok ? "—" : snapshot ? formatMoney(snapshot.mrr) : "Not set"}
          description={!mrrResult.ok ? "Couldn't load" : snapshot ? `${formatSignedMoney(snapshot.netNew)} net new in ${formatMonthKey(monthKey)} · manual` : "Add your first entry in MRR & metrics"}
          tone="success"
          icon={LineChart}
          href="/founder/metrics"
        />
      </StatGrid>

      {!itemsResult.ok ? <LoadFailed what="Your tasks and events" /> : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard title="Today's schedule" action={<Link href="/founder/tasks?view=today" className={LINK}>All of today</Link>}>
          {itemsResult.ok && schedule.length ? (
            <ItemList items={schedule} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} timeOnly />
          ) : itemsResult.ok ? (
            <EmptyState icon={CalendarDays} title="Nothing scheduled today" description="Meetings and events you add for today appear here." action={<AddItemButton label="Add meeting" defaultKind="meeting" deals={dealOptions} timeZone={timeZone} variant="secondary" />} />
          ) : null}
        </SectionCard>

        <SectionCard title="Priorities" description="Due today, plus high-priority items without a date.">
          {itemsResult.ok && priorities.length ? (
            <ItemList items={priorities} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} />
          ) : itemsResult.ok ? (
            <EmptyState icon={ListChecks} title="No priorities set for today" description="Give a task today's due date or high priority to see it here." />
          ) : null}
        </SectionCard>

        <SectionCard title="Overdue" action={overdue.length ? <Link href="/founder/tasks?view=overdue" className={LINK}>View all</Link> : undefined}>
          {itemsResult.ok && overdue.length ? (
            <ItemList items={overdue.slice(0, 8)} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} />
          ) : itemsResult.ok ? (
            <EmptyState icon={AlarmClock} title="Nothing overdue" description="Tasks, follow-ups and deadlines past their due time show up here." />
          ) : null}
        </SectionCard>

        <SectionCard title="Follow-ups due" description="Follow-up tasks and deals whose next action is due.">
          {!itemsResult.ok && !dealsResult.ok ? null : followUpItems.length === 0 && followUpDeals.length === 0 ? (
            <EmptyState icon={Handshake} title="No follow-ups due" description="Set a follow-up date on a deal, or add a follow-up task." />
          ) : (
            <div className="space-y-4">
              {followUpItems.length ? <ItemList items={followUpItems} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} /> : null}
              {followUpDeals.length ? (
                <ul className="divide-y divide-line">
                  {followUpDeals.map((deal) => (
                    <li key={deal.id} className="flex items-start justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">{deal.name}</p>
                        <p className="mt-0.5 text-xs text-ink-3">
                          {deal.nextAction ?? "Follow up"} · {formatDateTime(deal.nextActionAt as string, timeZone)}
                        </p>
                      </div>
                      {new Date(deal.nextActionAt as string) < now ? <Badge tone="danger">Overdue</Badge> : <Badge tone="info">Today</Badge>}
                    </li>
                  ))}
                </ul>
              ) : null}
              {!dealsResult.ok ? <LoadFailed what="Deal follow-ups" /> : null}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Active deals" action={<Link href="/founder/deals" className={LINK}>Pipeline</Link>}>
          {!dealsResult.ok ? (
            <LoadFailed what="Your deals" />
          ) : activeDeals.length ? (
            <ul className="divide-y divide-line">
              {activeDeals.map((deal) => (
                <li key={deal.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{deal.name}</p>
                    <p className="text-xs text-ink-3">{DEAL_STAGE_LABELS[deal.stage]}</p>
                  </div>
                  <p className="shrink-0 text-sm tabular-nums text-ink-2">{deal.expectedMrr != null ? `${formatMoney(deal.expectedMrr)}/mo` : "—"}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={Handshake} title="No open deals" description="Add a deal to start tracking your pipeline." />
          )}
        </SectionCard>

        <SectionCard title="Deadlines this week" description="The next 7 days.">
          {itemsResult.ok && deadlines.length ? (
            <ItemList items={deadlines} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} />
          ) : itemsResult.ok ? (
            <EmptyState icon={Sun} title="No deadlines this week" description="Add an item with the Deadline type to track it here." />
          ) : null}
        </SectionCard>
      </div>

      <SectionCard title="MRR & revenue" description={`${formatMonthKey(monthKey, true)} · actuals only`} action={<Link href="/founder/metrics" className={LINK}>Metrics</Link>}>
        {!mrrResult.ok ? (
          <LoadFailed what="Your MRR entries" />
        ) : !snapshot ? (
          <EmptyState icon={LineChart} title="No MRR entered yet" description="Record your starting MRR and each month's changes to track it here." />
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
              {(
                [
                  ["MRR", formatMoney(snapshot.mrr)],
                  ["New", formatMoney(snapshot.new)],
                  ["Expansion", formatMoney(snapshot.expansion)],
                  ["Churned + contraction", formatMoney(snapshot.churn + snapshot.contraction)],
                  ["One-time", formatMoney(snapshot.oneTime)],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs font-medium text-ink-3">{label}</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            {recentMrr.length ? (
              <div>
                <p className="text-xs font-medium text-ink-3">Recent changes</p>
                <ul className="mt-1 divide-y divide-line">
                  {recentMrr.map((entry) => (
                    <li key={entry.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0 truncate text-ink-2">
                        {MRR_KIND_LABELS[entry.kind]}
                        {entry.customer ? ` · ${entry.customer}` : ""} <span className="text-ink-3">· {formatMonthKey(entry.month)}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-ink">{entry.kind === "one_time" ? formatMoney(entry.amount) : formatSignedMoney(entry.kind === "churn" || entry.kind === "contraction" ? -entry.amount : entry.amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ManualDataNote />
          </div>
        )}
      </SectionCard>
    </div>
  );
}
