import Link from "next/link";
import { AlarmClock, CalendarDays, CalendarRange, Handshake, LineChart, ListChecks } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { SectionCard } from "@/lib/ui/section-card";
import { StatCard, StatGrid } from "@/lib/ui/stat-card";
import { Badge } from "@/lib/ui/badge";
import { secondaryButtonAutoClass } from "@/lib/ui/form";
import { getFounderDeals, getFounderItems, getFounderMrrEntries } from "@/lib/founder/queries";
import { SCHEDULED_KINDS, addDaysKey, dayRange, localDateKey, dealsNeedingFollowUp, isOverdue, itemTime, mrrSnapshot, pipelineSummary, sortByTimeThenPriority, toDealOptions, type FounderItem } from "@/lib/founder/model";
import { formatDateKey, formatDateTime, formatMoney, formatMonthKey, formatSignedMoney } from "@/lib/founder/format";
import { calendarHref } from "@/lib/founder/calendar";
import { requireFounderPage, LoadFailed } from "./_components/page-parts";
import { ItemList } from "./_components/item-list";
import { AddItemButton } from "./_components/add-item-button";
import { QuickCapture } from "./_components/quick-capture";

const LINK = "inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0";
const SUBHEAD = "text-xs font-semibold uppercase tracking-wide text-ink-3";

/**
 * Founder home - the daily planner. What's on today (meetings and events,
 * then today's unfinished priorities), what needs attention (overdue tasks
 * and follow-ups, deal follow-ups due), and what's coming in the next few
 * days - with quick actions to add a task, a meeting or a follow-up. The
 * full schedule lives in the Calendar; this page doesn't repeat it.
 */
export default async function FounderHomePage() {
  const { supabase, userId, timeZone, now, todayKey, today, monthKey } = await requireFounderPage();
  const since = new Date(today.start.getTime() - 30 * 86_400_000).toISOString();

  const [itemsResult, dealsResult, mrrResult] = await Promise.all([getFounderItems(supabase, userId, since), getFounderDeals(supabase, userId), getFounderMrrEntries(supabase, userId)]);

  const items = itemsResult.ok ? itemsResult.data : [];
  const open = items.filter((item) => item.completedAt == null);
  const within = (iso: string | null, start: Date, end: Date) => iso != null && new Date(iso) >= start && new Date(iso) < end;
  // Meetings and events still running today count too (started earlier, end later).
  const schedule = sortByTimeThenPriority(
    open.filter((item) => SCHEDULED_KINDS.includes(item.kind) && (within(item.startsAt, today.start, today.end) || (item.startsAt != null && item.endsAt != null && new Date(item.startsAt) < today.start && new Date(item.endsAt) > today.start))),
  );
  const overdue = sortByTimeThenPriority(open.filter((item) => isOverdue(item, now)));
  const priorities = sortByTimeThenPriority(open.filter((item) => !SCHEDULED_KINDS.includes(item.kind) && !isOverdue(item, now) && (within(item.dueAt, today.start, today.end) || (item.priority === "high" && item.dueAt == null))));

  // The next three days of commitments, grouped by day; deadlines a week out.
  const comingDays = [1, 2, 3].map((offset) => addDaysKey(todayKey, offset));
  // Local-day boundaries (DST-safe), never 24-hour steps.
  const horizonEnd = dayRange(comingDays[2], timeZone).end;
  const weekEnd = dayRange(addDaysKey(todayKey, 7), timeZone).end;
  const upcoming = sortByTimeThenPriority(open.filter((item) => within(itemTime(item), today.end, horizonEnd)));
  const laterDeadlines = sortByTimeThenPriority(open.filter((item) => item.kind === "deadline" && within(item.dueAt, horizonEnd, weekEnd)));
  const upcomingByDay = new Map<string, FounderItem[]>(comingDays.map((day) => [day, []]));
  for (const item of upcoming) upcomingByDay.get(localDateKey(new Date(itemTime(item) as string), timeZone))?.push(item);

  const deals = dealsResult.ok ? dealsResult.data : [];
  const dealOptions = toDealOptions(deals);
  const followUpDeals = dealsNeedingFollowUp(deals, today.end);
  const pipeline = pipelineSummary(deals, monthKey);
  const snapshot = mrrResult.ok ? mrrSnapshot(mrrResult.data, monthKey) : null;
  const nowIso = now.toISOString();
  const todayDefaults = { date: todayKey };

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader eyebrow="Founder" title={formatDateKey(todayKey)} description="Your day: meetings, priorities and what's next - only you can see this workspace." />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Quick actions">
          <AddItemButton label="New task" defaultKind="task" defaults={todayDefaults} deals={dealOptions} timeZone={timeZone} />
          <AddItemButton label="Schedule meeting" defaultKind="meeting" defaults={todayDefaults} deals={dealOptions} timeZone={timeZone} variant="secondary" />
          <AddItemButton label="Add follow-up" defaultKind="follow_up" defaults={todayDefaults} deals={dealOptions} timeZone={timeZone} variant="secondary" />
          <Link href={calendarHref("week", todayKey)} className={secondaryButtonAutoClass}>
            <CalendarRange className="h-4 w-4" aria-hidden />
            Calendar
          </Link>
        </div>
        <div className="w-full lg:max-w-md">
          <QuickCapture />
        </div>
      </div>

      <StatGrid>
        <StatCard label="Overdue" value={itemsResult.ok ? overdue.length : "—"} description={itemsResult.ok ? (overdue.length ? "Open items past due" : "Nothing overdue") : "Couldn't load"} tone={overdue.length ? "danger" : "neutral"} icon={AlarmClock} href="/founder/tasks?view=overdue" />
        <StatCard label="Today's schedule" value={itemsResult.ok ? schedule.length : "—"} description={itemsResult.ok ? "Meetings and events today" : "Couldn't load"} icon={CalendarDays} href={calendarHref("day", todayKey)} />
        <StatCard label="Open deals" value={dealsResult.ok ? pipeline.openCount : "—"} description={dealsResult.ok ? (pipeline.openExpectedMrr != null ? `${formatMoney(pipeline.openExpectedMrr)} expected MRR` : "No expected MRR entered") : "Couldn't load"} icon={Handshake} href="/founder/deals" />
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SectionCard title="Today" action={<Link href={calendarHref("day", todayKey)} className={LINK}>Day view</Link>}>
          {!itemsResult.ok ? null : (
            <div className="space-y-5">
              <section aria-labelledby="today-schedule">
                <h3 id="today-schedule" className={SUBHEAD}>Meetings & events</h3>
                {schedule.length ? (
                  <ItemList items={schedule} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} timeOnly />
                ) : (
                  <p className="mt-2 text-sm text-ink-3">Nothing scheduled today.</p>
                )}
              </section>
              <section aria-labelledby="today-priorities">
                <h3 id="today-priorities" className={SUBHEAD}>Priorities</h3>
                {priorities.length ? (
                  <ItemList items={priorities} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} />
                ) : (
                  <p className="mt-2 text-sm text-ink-3">No unfinished priorities for today. Give a task today&rsquo;s date or high priority to see it here.</p>
                )}
              </section>
            </div>
          )}
        </SectionCard>

        <div className="flex flex-col gap-6">
          <SectionCard title="Needs attention" action={overdue.length ? <Link href="/founder/tasks?view=overdue" className={LINK}>All overdue</Link> : undefined}>
            {itemsResult.ok && overdue.length === 0 && followUpDeals.length === 0 ? (
              <p className="text-sm text-ink-3">Nothing overdue, and no deal follow-ups due.</p>
            ) : (
              <div className="space-y-3">
                {overdue.length ? <ItemList items={overdue.slice(0, 6)} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} /> : null}
                {followUpDeals.length ? (
                  <ul className="divide-y divide-line border-t border-line">
                    {followUpDeals.slice(0, 5).map((deal) => (
                      <li key={deal.id} className="flex items-start justify-between gap-3 py-2.5">
                        <Link href={`/founder/deals?deal=${deal.id}`} className="min-w-0 hover:underline">
                          <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                            <Handshake className="h-3.5 w-3.5 text-ink-3" aria-hidden />
                            {deal.name}
                          </span>
                          <span className="mt-0.5 block text-xs text-ink-3">
                            {deal.nextAction ?? "Follow up"} · {formatDateTime(deal.nextActionAt as string, timeZone)}
                          </span>
                        </Link>
                        {new Date(deal.nextActionAt as string) < now ? <Badge tone="danger">Overdue</Badge> : <Badge tone="info">Today</Badge>}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {!dealsResult.ok ? <LoadFailed what="Deal follow-ups" /> : null}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Coming up" action={<Link href={calendarHref("week", todayKey)} className={LINK}>Week</Link>}>
            {!itemsResult.ok ? null : upcoming.length === 0 && laterDeadlines.length === 0 ? (
              <p className="text-sm text-ink-3">Nothing in the next three days, and no deadlines this week.</p>
            ) : (
              <div className="space-y-4">
                {comingDays.map((day) =>
                  upcomingByDay.get(day)!.length ? (
                    <section key={day} aria-label={formatDateKey(day)}>
                      <h3 className={SUBHEAD}>{formatDateKey(day, { weekday: "short", month: "short", day: "numeric" })}</h3>
                      <ItemList items={upcomingByDay.get(day)!} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} timeOnly />
                    </section>
                  ) : null,
                )}
                {laterDeadlines.length ? (
                  <section aria-label="Deadlines later this week">
                    <h3 className={SUBHEAD}>Deadlines later this week</h3>
                    <ItemList items={laterDeadlines} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} />
                  </section>
                ) : null}
              </div>
            )}
          </SectionCard>
        </div>
      </div>

      <p className="text-xs text-ink-3">
        <ListChecks className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
        Everything open, including undated captures, is in <Link href="/founder/tasks?view=open" className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink">Tasks</Link> and the <Link href={calendarHref("month", todayKey)} className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink">Calendar</Link>.
      </p>
    </div>
  );
}
