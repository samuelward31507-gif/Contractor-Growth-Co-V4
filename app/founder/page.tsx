import Link from "next/link";
import { AlertTriangle, CalendarRange, Handshake } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { SectionCard } from "@/lib/ui/section-card";
import { Badge } from "@/lib/ui/badge";
import { secondaryButtonAutoClass } from "@/lib/ui/form";
import { getFounderDeals, getFounderFocus, getFounderItems, getFounderMrrEntries } from "@/lib/founder/queries";
import { SCHEDULED_KINDS, mrrSnapshot, pipelineSummary, sortByTimeThenPriority, toDealOptions } from "@/lib/founder/model";
import { DEADLINE_WINDOW_DAYS, buildDailyPlan } from "@/lib/founder/daily";
import { formatDateKey, formatDateTime, formatMoney } from "@/lib/founder/format";
import { calendarHref } from "@/lib/founder/calendar";
import { requireFounderPage, LoadFailed } from "./_components/page-parts";
import { ItemList } from "./_components/item-list";
import { AddItemButton } from "./_components/add-item-button";
import { QuickCapture } from "./_components/quick-capture";
import { DailyPriorities } from "./_components/daily-priorities";

const LINK = "inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0";
const SUBHEAD = "text-xs font-semibold uppercase tracking-wide text-ink-3";

/**
 * Founder home - the daily command center. It answers "what matters today,
 * and what should I do next?": the day's three priorities, what's happening
 * and due today, what needs attention, and the next few days - each item in
 * exactly one place (lib/founder/daily.ts). Figures are a single compact
 * line linking to their pages; MRR is the actual manually recorded figure.
 */
export default async function FounderHomePage() {
  const { supabase, userId, timeZone, now, todayKey, today, monthKey } = await requireFounderPage();
  const since = new Date(today.start.getTime() - 30 * 86_400_000).toISOString();

  const [itemsResult, dealsResult, mrrResult, focusResult] = await Promise.all([
    getFounderItems(supabase, userId, since),
    getFounderDeals(supabase, userId),
    getFounderMrrEntries(supabase, userId),
    getFounderFocus(supabase, userId, todayKey, todayKey),
  ]);

  const items = itemsResult.ok ? itemsResult.data : [];
  const deals = dealsResult.ok ? dealsResult.data : [];
  const focus = focusResult.ok ? focusResult.data.focus : [];
  const plan = buildDailyPlan({ items, deals, focus, now, timeZone, todayKey });
  const dealOptions = toDealOptions(deals);
  const candidates = sortByTimeThenPriority(items.filter((item) => item.completedAt == null && !SCHEDULED_KINDS.includes(item.kind) && !plan.priorities.includes(item)));
  const pipeline = pipelineSummary(deals, monthKey);
  const snapshot = mrrResult.ok ? mrrSnapshot(mrrResult.data, monthKey) : null;
  const nowIso = now.toISOString();
  const todayDefaults = { date: todayKey };
  const { attention } = plan;
  const nothingToday = plan.schedule.length === 0 && plan.dueToday.length === 0;

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader eyebrow="Founder" title={formatDateKey(todayKey)} description="What matters today, and what to do next." />

      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Quick actions">
          <AddItemButton label="Task" defaultKind="task" defaults={todayDefaults} deals={dealOptions} timeZone={timeZone} variant="secondary" />
          <AddItemButton label="Meeting" defaultKind="meeting" defaults={todayDefaults} deals={dealOptions} timeZone={timeZone} variant="secondary" />
          <AddItemButton label="Event" defaultKind="event" defaults={todayDefaults} deals={dealOptions} timeZone={timeZone} variant="secondary" />
          <AddItemButton label="Follow-up" defaultKind="follow_up" defaults={todayDefaults} deals={dealOptions} timeZone={timeZone} variant="secondary" />
          <Link href={calendarHref("week", todayKey)} className={secondaryButtonAutoClass}>
            <CalendarRange className="h-4 w-4" aria-hidden />
            Calendar
          </Link>
        </div>
        <div className="w-full xl:max-w-lg">
          <QuickCapture />
        </div>
      </div>

      {/* The figures, as one line: each links to the page that explains it. */}
      <dl className="flex flex-wrap gap-x-6 gap-y-2 border-y border-line py-3 text-sm" aria-label="Summary">
        <div className="flex items-baseline gap-1.5">
          <dt className="text-ink-3">Today</dt>
          <dd className="font-semibold tabular-nums text-ink">{itemsResult.ok ? `${plan.progress.done} of ${plan.progress.total} done` : "—"}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-ink-3">Overdue</dt>
          <dd>
            <Link href="/founder/tasks?view=overdue" className={`font-semibold tabular-nums hover:underline ${attention.overdue.length ? "text-danger-text" : "text-ink"}`}>
              {itemsResult.ok ? attention.overdue.length : "—"}
            </Link>
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-ink-3">Open deals</dt>
          <dd>
            <Link href="/founder/deals" className="font-semibold tabular-nums text-ink hover:underline">
              {dealsResult.ok ? pipeline.openCount : "—"}
            </Link>
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-ink-3">MRR (actual, manual)</dt>
          <dd>
            <Link href="/founder/metrics" className="font-semibold tabular-nums text-ink hover:underline">
              {!mrrResult.ok ? "—" : snapshot ? formatMoney(snapshot.mrr) : "Not recorded"}
            </Link>
          </dd>
        </div>
      </dl>

      {!itemsResult.ok ? <LoadFailed what="Your tasks and events" /> : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-6">
          <SectionCard title="Today's priorities">
            {!focusResult.ok ? (
              <LoadFailed what="Today's priorities" />
            ) : (
              <DailyPriorities dateKey={todayKey} dayLabel="today" priorities={plan.priorities} candidates={candidates} available={focusResult.data.available} />
            )}
          </SectionCard>

          <SectionCard title="Today" action={<Link href={calendarHref("day", todayKey)} className={LINK}>Day view</Link>}>
            {!itemsResult.ok ? null : nothingToday ? (
              <p className="text-sm text-ink-3">No meetings, events or tasks due today. Your priorities are above; use the quick actions to add more.</p>
            ) : (
              <div className="space-y-5">
                {plan.schedule.length ? (
                  <section aria-labelledby="today-schedule">
                    <h3 id="today-schedule" className={SUBHEAD}>Meetings & events</h3>
                    <ItemList items={plan.schedule} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} timeOnly />
                  </section>
                ) : null}
                {plan.dueToday.length ? (
                  <section aria-labelledby="today-due">
                    <h3 id="today-due" className={SUBHEAD}>Due today</h3>
                    <ItemList items={plan.dueToday} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} timeOnly />
                  </section>
                ) : null}
              </div>
            )}
          </SectionCard>
        </div>

        <div className="flex flex-col gap-6">
          <SectionCard title="Needs attention" action={plan.attentionCount ? <span className="text-xs tabular-nums text-ink-3">{plan.attentionCount}</span> : undefined}>
            {!itemsResult.ok && !dealsResult.ok ? null : plan.attentionCount === 0 ? (
              <p className="text-sm text-ink-3">Nothing overdue, no follow-ups due, and every open deal has a next action.</p>
            ) : (
              <div className="space-y-4">
                {attention.overdue.length ? (
                  <section aria-labelledby="attention-overdue">
                    <h3 id="attention-overdue" className={SUBHEAD}>Overdue</h3>
                    <ItemList items={attention.overdue.slice(0, 6)} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} />
                    {attention.overdue.length > 6 ? (
                      <Link href="/founder/tasks?view=overdue" className={LINK}>All {attention.overdue.length} overdue</Link>
                    ) : null}
                  </section>
                ) : null}
                {attention.followUpsToday.length ? (
                  <section aria-labelledby="attention-followups">
                    <h3 id="attention-followups" className={SUBHEAD}>Follow-ups due today</h3>
                    <ItemList items={attention.followUpsToday} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} timeOnly />
                  </section>
                ) : null}
                {attention.deadlinesSoon.length ? (
                  <section aria-labelledby="attention-deadlines">
                    <h3 id="attention-deadlines" className={SUBHEAD}>Deadlines in the next {DEADLINE_WINDOW_DAYS} days</h3>
                    <ItemList items={attention.deadlinesSoon} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} />
                  </section>
                ) : null}
                {attention.dealFollowUps.length || attention.dealsWithoutNextAction.length ? (
                  <section aria-labelledby="attention-deals">
                    <h3 id="attention-deals" className={SUBHEAD}>Deals</h3>
                    <ul className="divide-y divide-line">
                      {attention.dealFollowUps.map((deal) => (
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
                      {attention.dealsWithoutNextAction.map((deal) => (
                        <li key={deal.id} className="flex items-start justify-between gap-3 py-2.5">
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                              <AlertTriangle className="h-3.5 w-3.5 text-warning-text" aria-hidden />
                              {deal.name}
                            </p>
                            <p className="mt-0.5 text-xs text-ink-3">No next action set</p>
                          </div>
                          <Link href={`/founder/deals?deal=${deal.id}`} className="shrink-0 text-xs font-medium text-ink-2 underline underline-offset-2 hover:text-ink">
                            Set next action
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {!dealsResult.ok ? <LoadFailed what="Your deals" /> : null}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Coming up" action={<Link href={calendarHref("week", todayKey)} className={LINK}>Week</Link>}>
            {!itemsResult.ok ? null : plan.upcoming.every((day) => day.items.length === 0) ? (
              <p className="text-sm text-ink-3">Nothing scheduled for the next three days.</p>
            ) : (
              <div className="space-y-4">
                {plan.upcoming.map((day) =>
                  day.items.length ? (
                    <section key={day.day} aria-label={formatDateKey(day.day)}>
                      <h3 className={SUBHEAD}>{formatDateKey(day.day, { weekday: "short", month: "short", day: "numeric" })}</h3>
                      <ItemList items={day.items} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} timeOnly />
                    </section>
                  ) : null,
                )}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
