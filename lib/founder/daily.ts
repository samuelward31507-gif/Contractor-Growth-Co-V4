/**
 * The founder's day - pure logic behind the /founder home page and the
 * end-of-day review. Given the founder's items, deals and daily priorities,
 * it answers "what matters today, and what should I do next?" with every
 * item in exactly ONE section, in this order of precedence:
 *
 *   1. Priorities     - the (up to three) items marked for today
 *   2. Today          - meetings/events happening today; other items due today
 *   3. Needs attention- overdue (due before today), follow-ups due today,
 *                       deadlines in the next few days, open deals with no
 *                       next action or a next action now due
 *   4. Coming up      - everything else dated in the next few days
 *
 * "Today" is the founder's local calendar day (dayRange - DST-safe), never a
 * UTC day or a 24-hour window. Completed items are left out of every list
 * (they only count toward progress).
 */
import { SCHEDULED_KINDS, addDaysKey, dayRange, isOpenDeal, itemTime, localDateKey, sortByTimeThenPriority, type FounderDeal, type FounderItem } from "./model";
import type { DailyFocus } from "./queries";

export const MAX_DAILY_PRIORITIES = 3;
export const UPCOMING_DAYS = 3;
export const DEADLINE_WINDOW_DAYS = 3;

/** The items marked as priorities for `dateKey`, in rank order (missing items skipped). */
export function prioritiesFor(items: FounderItem[], focus: DailyFocus[], dateKey: string): FounderItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return focus
    .filter((f) => f.date === dateKey)
    .sort((a, b) => a.rank - b.rank)
    .map((f) => byId.get(f.itemId))
    .filter((item): item is FounderItem => item != null);
}

export type DayProgress = { done: number; total: number };

export type DailyPlan = {
  priorities: FounderItem[];
  /** Meetings and events happening today (started today, or running into today), by local start time. */
  schedule: FounderItem[];
  /** Open tasks and deadlines due today (not follow-ups - those are under attention). */
  dueToday: FounderItem[];
  attention: {
    /** Open items due before today. */
    overdue: FounderItem[];
    /** Open follow-ups due today. */
    followUpsToday: FounderItem[];
    /** Open deadlines due in the next DEADLINE_WINDOW_DAYS days. */
    deadlinesSoon: FounderItem[];
    /** Open deals whose next action is due by the end of today. */
    dealFollowUps: FounderDeal[];
    /** Open deals with neither a next action nor a follow-up date. */
    dealsWithoutNextAction: FounderDeal[];
  };
  /** The next UPCOMING_DAYS local days, each with its items in time order. */
  upcoming: { day: string; items: FounderItem[] }[];
  /** Today's commitments done: priorities plus items due today (events excluded). */
  progress: DayProgress;
  attentionCount: number;
};

export function buildDailyPlan(input: { items: FounderItem[]; deals: FounderDeal[]; focus: DailyFocus[]; now: Date; timeZone: string; todayKey: string }): DailyPlan {
  const { items, deals, focus, timeZone, todayKey } = input;
  const today = dayRange(todayKey, timeZone);
  const inRange = (iso: string | null, start: Date, end: Date) => iso != null && new Date(iso) >= start && new Date(iso) < end;
  const used = new Set<string>();
  const take = (list: FounderItem[]) => list.filter((item) => (used.has(item.id) ? false : (used.add(item.id), true)));
  const open = items.filter((item) => item.completedAt == null);

  const priorities = prioritiesFor(items, focus, todayKey);
  priorities.forEach((item) => used.add(item.id));

  const schedule = take(
    sortByTimeThenPriority(
      open.filter(
        (item) =>
          SCHEDULED_KINDS.includes(item.kind) &&
          (inRange(item.startsAt, today.start, today.end) || (item.startsAt != null && item.endsAt != null && new Date(item.startsAt) < today.start && new Date(item.endsAt) > today.start)),
      ),
    ),
  );

  const nonScheduledOpen = open.filter((item) => !SCHEDULED_KINDS.includes(item.kind));
  const overdue = take(sortByTimeThenPriority(nonScheduledOpen.filter((item) => item.dueAt != null && new Date(item.dueAt) < today.start)));
  const followUpsToday = take(sortByTimeThenPriority(nonScheduledOpen.filter((item) => item.kind === "follow_up" && inRange(item.dueAt, today.start, today.end))));
  const dueToday = take(sortByTimeThenPriority(nonScheduledOpen.filter((item) => inRange(item.dueAt, today.start, today.end))));
  const deadlineEnd = dayRange(addDaysKey(todayKey, DEADLINE_WINDOW_DAYS), timeZone).end;
  const deadlinesSoon = take(sortByTimeThenPriority(nonScheduledOpen.filter((item) => item.kind === "deadline" && inRange(item.dueAt, today.end, deadlineEnd))));

  const openDeals = deals.filter(isOpenDeal);
  const dealFollowUps = openDeals.filter((deal) => deal.nextActionAt != null && new Date(deal.nextActionAt) < today.end).sort((a, b) => ((a.nextActionAt as string) < (b.nextActionAt as string) ? -1 : 1));
  const dealsWithoutNextAction = openDeals.filter((deal) => !deal.nextAction && !deal.nextActionAt);

  const days = Array.from({ length: UPCOMING_DAYS }, (_, i) => addDaysKey(todayKey, i + 1));
  const upcomingEnd = dayRange(days[days.length - 1], timeZone).end;
  const upcomingItems = take(sortByTimeThenPriority(open.filter((item) => inRange(itemTime(item), today.end, upcomingEnd))));
  const upcoming = days.map((day) => ({ day, items: upcomingItems.filter((item) => localDateKey(new Date(itemTime(item) as string), timeZone) === day) }));

  // Progress: today's priorities plus everything (non-event) due today, done or not.
  const committed = new Map<string, FounderItem>();
  for (const item of priorities) committed.set(item.id, item);
  for (const item of items) if (!SCHEDULED_KINDS.includes(item.kind) && inRange(item.dueAt, today.start, today.end)) committed.set(item.id, item);
  const progress = { done: [...committed.values()].filter((item) => item.completedAt != null).length, total: committed.size };

  return {
    priorities,
    schedule,
    dueToday,
    attention: { overdue, followUpsToday, deadlinesSoon, dealFollowUps, dealsWithoutNextAction },
    upcoming,
    progress,
    attentionCount: overdue.length + followUpsToday.length + deadlinesSoon.length + dealFollowUps.length + dealsWithoutNextAction.length,
  };
}

export type ReviewDay = {
  /** Items completed during the day. */
  completed: FounderItem[];
  /** Open items due during the day - candidates to move to another day. */
  unfinished: FounderItem[];
  /** Open items due before the day - still overdue. */
  stillOverdue: FounderItem[];
  pipeline: { created: FounderDeal[]; won: FounderDeal[]; lost: FounderDeal[]; updated: FounderDeal[] };
};

/**
 * The end-of-day closeout for `dayKey`. Pipeline "changes" are what the
 * data can actually establish: deals created that day, deals won that day
 * (won_on), deals now lost and touched that day, and other deals edited
 * that day. Stage history isn't stored, so a previous stage is never shown.
 */
export function reviewDay(input: { items: FounderItem[]; deals: FounderDeal[]; dayKey: string; timeZone: string }): ReviewDay {
  const day = dayRange(input.dayKey, input.timeZone);
  const within = (iso: string | null) => iso != null && new Date(iso) >= day.start && new Date(iso) < day.end;
  const nonScheduled = input.items.filter((item) => !SCHEDULED_KINDS.includes(item.kind));
  const created = input.deals.filter((deal) => within(deal.createdAt));
  const won = input.deals.filter((deal) => deal.stage === "won" && deal.wonOn === input.dayKey && !created.includes(deal));
  const lost = input.deals.filter((deal) => deal.stage === "lost" && within(deal.updatedAt) && !created.includes(deal));
  const updated = input.deals.filter((deal) => within(deal.updatedAt) && !created.includes(deal) && !won.includes(deal) && !lost.includes(deal));
  return {
    completed: input.items.filter((item) => within(item.completedAt)).sort((a, b) => ((a.completedAt as string) < (b.completedAt as string) ? -1 : 1)),
    unfinished: sortByTimeThenPriority(nonScheduled.filter((item) => item.completedAt == null && within(item.dueAt))),
    stillOverdue: sortByTimeThenPriority(nonScheduled.filter((item) => item.completedAt == null && item.dueAt != null && new Date(item.dueAt) < day.start)),
    pipeline: { created, won, lost, updated },
  };
}
