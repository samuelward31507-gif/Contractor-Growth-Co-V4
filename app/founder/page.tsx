import Link from "next/link";
import { AlertTriangle, CalendarRange, Clock, Handshake } from "lucide-react";
import { PageHeader } from "@/lib/ui/page-header";
import { PAGE_CONTAINER_CLASS, PAGE_MAX_WIDTH_CLASS } from "@/lib/ui/page";
import { SectionCard } from "@/lib/ui/section-card";
import { secondaryButtonAutoClass } from "@/lib/ui/form";
import { getFounderDeals, getFounderFocus, getFounderItems, getFounderMrrEntries } from "@/lib/founder/queries";
import { SCHEDULED_KINDS, mrrSnapshot, pipelineSummary, sortByTimeThenPriority, toDealOptions } from "@/lib/founder/model";
import { DEADLINE_WINDOW_DAYS, buildFounderBriefing, type AttentionEntry } from "@/lib/founder/intelligence";
import { formatDateKey, formatMoney } from "@/lib/founder/format";
import { calendarHref } from "@/lib/founder/calendar";
import { requireFounderPage, LoadFailed } from "./_components/page-parts";
import { ItemList } from "./_components/item-list";
import { AddItemButton } from "./_components/add-item-button";
import { QuickCapture } from "./_components/quick-capture";
import { DailyPriorities } from "./_components/daily-priorities";
import { NextBestAction, RecommendationList } from "./_components/recommendations";

const LINK = "inline-flex min-h-11 items-center text-xs font-medium text-ink-2 hover:text-ink sm:min-h-0";
const SUBHEAD = "text-xs font-semibold uppercase tracking-wide text-ink-3";

const ITEM_SECTIONS: { kind: AttentionEntry["kind"]; label: string }[] = [
  { kind: "overdue", label: "Overdue" },
  { kind: "follow_up_today", label: "Follow-ups due today" },
  { kind: "deadline_soon", label: `Deadlines in the next ${DEADLINE_WINDOW_DAYS} days` },
];
const DEAL_KINDS: AttentionEntry["kind"][] = ["deal_follow_up", "deal_no_next_action", "stale_deal"];

/**
 * Founder home - the daily operating system. One deterministic briefing
 * (lib/founder/intelligence.ts) decides every section, so each record shows
 * up in exactly one place: a greeting and honest workload line, the single
 * next best action, the day's three priorities, what's on today, the other
 * ranked recommendations (each with its reason), whatever else needs
 * attention, anything that looks inconsistent, and the next few days.
 * Nothing here completes, moves or edits a record on its own; every write is
 * a button the founder presses.
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
  const briefing = buildFounderBriefing({ items, deals, focus, now, timeZone, todayKey, prioritiesAvailable: focusResult.ok && focusResult.data.available, generatedAt: now.toISOString() });
  const priorities = briefing.top_priorities.items;
  const dealOptions = toDealOptions(deals);
  const candidates = sortByTimeThenPriority(items.filter((item) => item.completedAt == null && !SCHEDULED_KINDS.includes(item.kind) && !priorities.includes(item)));
  const pipeline = pipelineSummary(deals, monthKey);
  const snapshot = mrrResult.ok ? mrrSnapshot(mrrResult.data, monthKey) : null;
  const nowIso = now.toISOString();
  const todayDefaults = { date: todayKey };
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const { schedule, due } = briefing.today;
  const nothingToday = schedule.length === 0 && due.length === 0;
  const otherRecommendations = briefing.recommended_actions.slice(1);
  const attentionDeals = briefing.needs_attention.filter((entry) => DEAL_KINDS.includes(entry.kind));
  // Loaded data only: a section whose data failed shows its error, never "all clear".
  const briefingReady = itemsResult.ok && dealsResult.ok;

  return (
    <div className={`${PAGE_CONTAINER_CLASS} gap-6 ${PAGE_MAX_WIDTH_CLASS}`}>
      <PageHeader eyebrow={formatDateKey(todayKey)} title={briefing.greeting} description={itemsResult.ok ? briefing.workload.summary : "What matters today, and what to do next."} />

      {!itemsResult.ok ? <LoadFailed what="Your tasks and events" /> : null}
      {!dealsResult.ok ? <LoadFailed what="Your deals" /> : null}
      {briefingReady ? <NextBestAction action={briefing.best_next_action} /> : null}

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
          <dd className="font-semibold tabular-nums text-ink">{itemsResult.ok ? `${briefing.progress.done} of ${briefing.progress.total} done` : "—"}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-ink-3">Overdue</dt>
          <dd>
            <Link href="/founder/tasks?view=overdue" className={`font-semibold tabular-nums hover:underline ${briefing.workload.overdue ? "text-danger-text" : "text-ink"}`}>
              {itemsResult.ok ? briefing.workload.overdue : "—"}
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-6">
          <div id="priorities" className="scroll-mt-20">
            <SectionCard title="Today's priorities">
              {!focusResult.ok ? (
                <LoadFailed what="Today's priorities" />
              ) : (
                <DailyPriorities dateKey={todayKey} dayLabel="today" priorities={priorities} candidates={candidates} available={focusResult.data.available} />
              )}
            </SectionCard>
          </div>

          <SectionCard title="Today" action={<Link href={calendarHref("day", todayKey)} className={LINK}>Day view</Link>}>
            {!itemsResult.ok ? null : nothingToday ? (
              <p className="text-sm text-ink-3">No meetings, events or tasks due today. Your priorities are above; use the quick actions to add more.</p>
            ) : (
              <div className="space-y-5">
                {schedule.length ? (
                  <section aria-labelledby="today-schedule">
                    <h3 id="today-schedule" className={SUBHEAD}>Meetings & events</h3>
                    <ItemList items={schedule} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} timeOnly />
                  </section>
                ) : null}
                {due.length ? (
                  <section aria-labelledby="today-due">
                    <h3 id="today-due" className={SUBHEAD}>Due today, not done</h3>
                    <ItemList items={due} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} timeOnly />
                  </section>
                ) : null}
              </div>
            )}
          </SectionCard>
        </div>

        <div className="flex flex-col gap-6">
          {briefingReady && otherRecommendations.length ? (
            <SectionCard title="Recommended next" description="Ranked by fixed rules; each shows the record that triggered it.">
              <RecommendationList recommendations={otherRecommendations} />
            </SectionCard>
          ) : null}

          <SectionCard title="Needs attention" action={briefing.needs_attention.length ? <span className="text-xs tabular-nums text-ink-3">{briefing.needs_attention.length}</span> : undefined}>
            {!briefingReady ? null : briefing.needs_attention.length === 0 ? (
              <p className="text-sm text-ink-3">
                {briefing.attention_total === 0 ? "Nothing overdue, no follow-ups due, and every open deal has a next action." : "Everything that needs attention is in the recommendations above."}
              </p>
            ) : (
              <div className="space-y-4">
                {ITEM_SECTIONS.map(({ kind, label }) => {
                  const list = briefing.needs_attention.filter((entry) => entry.kind === kind).map((entry) => itemsById.get(entry.record.id)).filter((item) => item != null);
                  return list.length ? (
                    <section key={kind} aria-label={label}>
                      <h3 className={SUBHEAD}>{label}</h3>
                      <ItemList items={list.slice(0, 6)} deals={dealOptions} timeZone={timeZone} nowIso={nowIso} timeOnly={kind === "follow_up_today"} />
                      {kind === "overdue" && list.length > 6 ? (
                        <Link href="/founder/tasks?view=overdue" className={LINK}>All {list.length} overdue</Link>
                      ) : null}
                    </section>
                  ) : null;
                })}
                {attentionDeals.length ? (
                  <section aria-labelledby="attention-deals">
                    <h3 id="attention-deals" className={SUBHEAD}>Deals</h3>
                    <ul className="divide-y divide-line">
                      {attentionDeals.map((entry) => (
                        <li key={entry.id} className="py-2.5">
                          <Link href={entry.href} className="block min-w-0 hover:underline">
                            <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                              {entry.kind === "deal_follow_up" ? <Handshake className="h-3.5 w-3.5 text-ink-3" aria-hidden /> : entry.kind === "stale_deal" ? <Clock className="h-3.5 w-3.5 text-ink-3" aria-hidden /> : <AlertTriangle className="h-3.5 w-3.5 text-warning-text" aria-hidden />}
                              {entry.title}
                            </span>
                            <span className="mt-0.5 block text-xs text-ink-3">
                              {entry.detail}
                              {entry.suggestion ? <span className="text-ink-2"> · Suggestion: {entry.suggestion.toLowerCase()}</span> : null}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            )}
          </SectionCard>

          {briefingReady && briefing.review_needed.length ? (
            <SectionCard title="Worth checking" description="Records that conflict or look incomplete. Nothing is changed automatically.">
              <ul className="divide-y divide-line">
                {briefing.review_needed.map((flag) => (
                  <li key={flag.id} className="py-2.5" data-kind={flag.kind}>
                    <Link href={flag.href} className="block min-w-0 hover:underline">
                      <span className="block text-sm font-medium text-ink">{flag.title}</span>
                      <span className="mt-0.5 block text-xs text-ink-3">{flag.detail}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          <SectionCard title="Coming up" action={<Link href={calendarHref("week", todayKey)} className={LINK}>Week</Link>}>
            {!itemsResult.ok ? null : briefing.coming_up.every((day) => day.items.length === 0) ? (
              <p className="text-sm text-ink-3">Nothing scheduled for the next three days.</p>
            ) : (
              <div className="space-y-4">
                {briefing.coming_up.map((day) =>
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
