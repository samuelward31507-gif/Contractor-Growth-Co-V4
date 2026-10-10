/**
 * Founder Intelligence - the deterministic briefing engine behind /founder
 * and the end-of-day review. It reads the founder's own records (items,
 * deals, daily priorities, and - when loaded - the recorded sales history and
 * client handoffs, all already owner-scoped by lib/founder/queries.ts) and
 * answers: what matters today, what needs attention and why, which
 * opportunities deserve action, what to do next, and what changed today.
 *
 * Sales work uses the Deals page's own definitions (buildSalesToday in
 * lib/founder/sales.ts) - missing meeting outcomes, stalled deals, cold
 * prospects, proposals waiting - so Home and Deals never disagree about a
 * deal. Only when the sales history can't be read does Home fall back to the
 * older "no change for STALE_DEAL_DAYS" rule, and it says so (`coverage`).
 *
 * Rules, not a model:
 *  - Every observation is computed from stored fields. Anything that goes
 *    beyond a stored fact is carried separately as a `suggestion` and shown
 *    labelled as a suggestion - never mixed into the fact.
 *  - Recommendations are ranked by fixed, named tiers (RECOMMENDATION_TIERS),
 *    then by time, priority, title and id - no opaque score, no predicted
 *    revenue. Identical inputs give identical output (only `generated_at`,
 *    passed in, differs).
 *  - Nothing here writes, completes, reschedules or edits anything.
 *
 * No LLM is used: every requirement is date arithmetic, record state or a
 * ranking rule, which rules do reliably and explainably. (The project's
 * Anthropic key is also Production-only, so a model path could never run
 * on Preview.)
 */
import { DEAL_STAGE_LABELS, ITEM_KIND_LABELS, SCHEDULED_KINDS, addDaysKey, addToTotals, dayRange, isOpenDeal, itemTime, localDateKey, sortByTimeThenPriority, toLocalInputValue, type CurrencyTotals, type DealStage, type FounderDeal, type FounderItem, type Priority } from "./model";
import { buildDailyPlan, DEADLINE_WINDOW_DAYS, MAX_DAILY_PRIORITIES, reviewDay, type DailyPlan } from "./daily";
import { calendarHref, isAllDayEvent, isEndOfDayDue } from "./calendar";
import { formatDateKey, formatDay, formatTime, formatTotals } from "./format";
import { buildSalesToday, type DealActivity, type MeetingEntry } from "./sales";
import { handoffOutOfDate, handoffState, type ClientHandoff } from "./handoff";
import type { DailyFocus } from "./queries";

/**
 * Fallback only (sales history not readable): an open deal with no recorded
 * change for this long, and no future follow-up date, is reported as stale.
 */
export const STALE_DEAL_DAYS = 14;
/** A meeting or event starting within this window is worth preparing for now. */
export const PREP_WINDOW_MINUTES = 120;
export const MAX_RECOMMENDATIONS = 5;
/** Late-stage deals: closest to revenue, so a missing next action matters most. */
export const LATE_DEAL_STAGES: DealStage[] = ["meeting_booked", "meeting_held", "proposal_sent", "negotiation"];

/** The ranking, in order. A recommendation's tier is its rule's position here. */
export const RECOMMENDATION_TIERS = [
  "finish_priority",
  "resolve_overdue",
  "prepare_meeting",
  "follow_up_due",
  "record_meeting_outcome",
  "set_priorities",
  "deal_next_action_late_stage",
  "client_handoff",
  "deadline_soon",
  "deal_next_action",
  "stalled_deal",
  "cold_prospect",
  "stale_deal",
] as const;
export type RecommendationRule = (typeof RECOMMENDATION_TIERS)[number];

export type RecordRef = { type: "item" | "deal"; id: string; label: string };

export type Recommendation = {
  /** Stable: `${rule}:${record id}` (or the rule alone when no record). */
  id: string;
  rule: RecommendationRule;
  title: string;
  /** The factual basis - what the stored records say. */
  why: string;
  /** An inference beyond the facts, shown labelled as a suggestion - or null. */
  suggestion: string | null;
  records: RecordRef[];
  /** Where to act: the item (opened on the calendar), the deal, or the priorities section. */
  href: string;
};

export type AttentionKind =
  | "overdue"
  | "follow_up_today"
  | "deadline_soon"
  | "deal_follow_up"
  | "meeting_outcome_missing"
  | "client_handoff"
  | "handoff_waiting"
  | "deal_no_next_action"
  | "stalled_deal"
  | "cold_prospect"
  | "proposal_waiting"
  | "stale_deal";
export type AttentionEntry = { id: string; kind: AttentionKind; title: string; detail: string; suggestion: string | null; href: string; record: RecordRef };

export type ReviewFlagKind = "schedule_conflict" | "follow_up_without_action" | "open_item_on_closed_deal" | "late_deal_without_value" | "handoff_on_reopened_deal";
export type ReviewFlag = { id: string; kind: ReviewFlagKind; title: string; detail: string; href: string; records: RecordRef[] };

/**
 * A supporting source as the page loaded it: read, not on this database yet
 * (its migration isn't applied), or failed to load. Only a loaded source is
 * checked; the briefing says which were not, never implying an all-clear.
 */
export type BriefingSource<T> = { status: "loaded"; data: T } | { status: "unavailable" } | { status: "failed" };
export type SourceStatus = BriefingSource<unknown>["status"];
export type BriefingCoverage = { salesHistory: SourceStatus; handoffs: SourceStatus };

export type Workload = { level: "clear" | "light" | "moderate" | "heavy"; meetings: number; dueToday: number; overdue: number; prioritiesOpen: number; summary: string };

export type FounderBriefing = {
  generated_at: string;
  timezone: string;
  date: string;
  greeting: string;
  workload: Workload;
  best_next_action: Recommendation | null;
  top_priorities: { items: FounderItem[]; done: number; total: number; max: number };
  today: { schedule: FounderItem[]; due: FounderItem[] };
  /** Everything that needs attention, minus the records already in recommended_actions. */
  needs_attention: AttentionEntry[];
  /** How many attention entries exist in total (including those promoted to recommendations). */
  attention_total: number;
  recommended_actions: Recommendation[];
  review_needed: ReviewFlag[];
  coming_up: DailyPlan["upcoming"];
  progress: DailyPlan["progress"];
  /** Which supporting sources were actually checked - empty states only claim what was. */
  coverage: BriefingCoverage;
};

// --- destinations -------------------------------------------------------------

/** An item opens in its calendar day (with its details shown); undated items open from today's view. */
export function itemHref(item: Pick<FounderItem, "id" | "kind" | "dueAt" | "startsAt">, timeZone: string, todayKey: string): string {
  const at = itemTime(item);
  const day = at ? localDateKey(new Date(at), timeZone) : todayKey;
  return `${calendarHref("day", day)}&item=${encodeURIComponent(item.id)}`;
}

export function dealHref(deal: Pick<FounderDeal, "id">): string {
  return `/founder/deals?deal=${encodeURIComponent(deal.id)}`;
}

export const PRIORITIES_HREF = "/founder#priorities";

// --- small helpers ------------------------------------------------------------

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const itemRef = (item: FounderItem): RecordRef => ({ type: "item", id: item.id, label: item.title });
const dealRef = (deal: FounderDeal): RecordRef => ({ type: "deal", id: deal.id, label: deal.name });
const daysBetween = (fromKey: string, toKey: string) => Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86_400_000);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function whenLabel(item: FounderItem, timeZone: string): string {
  const at = itemTime(item);
  if (!at) return "no date";
  if (isAllDayEvent(item, timeZone)) return `${formatDay(at, timeZone)}, all day`;
  if (isEndOfDayDue(item, timeZone)) return `${formatDay(at, timeZone)} (end of day)`;
  return `${formatDay(at, timeZone)}, ${formatTime(at, timeZone)}`;
}

/** Deterministic order inside a tier: time, then priority, then title, then id. */
function compareItems(a: FounderItem, b: FounderItem): number {
  const ta = itemTime(a) ?? "9999";
  const tb = itemTime(b) ?? "9999";
  if (ta !== tb) return ta < tb ? -1 : 1;
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function compareDeals(a: FounderDeal, b: FounderDeal): number {
  const ta = a.nextActionAt ?? a.updatedAt;
  const tb = b.nextActionAt ?? b.updatedAt;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The moment a deal was last touched, as recorded: its latest logged sales
 * activity when there is one, otherwise its last edit (deals from before the
 * sales history existed, or never logged against).
 */
export function lastTouch(deal: Pick<FounderDeal, "lastActivityAt" | "updatedAt">): { at: string; recordedActivity: boolean } {
  return deal.lastActivityAt ? { at: deal.lastActivityAt, recordedActivity: true } : { at: deal.updatedAt, recordedActivity: false };
}

/** Open deals not touched (see lastTouch) for STALE_DEAL_DAYS+ local days, with no future follow-up date. */
export function staleDeals(deals: FounderDeal[], now: Date, timeZone: string): FounderDeal[] {
  const todayKey = localDateKey(now, timeZone);
  return deals
    .filter((deal) => isOpenDeal(deal) && !(deal.nextActionAt && new Date(deal.nextActionAt) >= now))
    .filter((deal) => daysBetween(localDateKey(new Date(lastTouch(deal).at), timeZone), todayKey) >= STALE_DEAL_DAYS)
    .sort(compareDeals);
}

/** Pairs of today's timed meetings/events whose times overlap (all-day events excluded). */
export function scheduleConflicts(schedule: FounderItem[], timeZone: string): [FounderItem, FounderItem][] {
  const timed = schedule.filter((item) => item.startsAt && !isAllDayEvent(item, timeZone)).sort(compareItems);
  const span = (item: FounderItem) => [new Date(item.startsAt as string).getTime(), new Date(item.endsAt ?? (item.startsAt as string)).getTime()] as const;
  const pairs: [FounderItem, FounderItem][] = [];
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      const [as, ae] = span(timed[i]);
      const [bs, be] = span(timed[j]);
      if (as === bs || (as < be && bs < ae)) pairs.push([timed[i], timed[j]]);
    }
  }
  return pairs;
}

/**
 * Tier order (stable within a tier), one recommendation per record - the
 * highest tier wins - then the top `max`. The sections feeding this are
 * already disjoint (lib/founder/daily.ts), so this is the safety net that
 * keeps a record from ever being recommended twice.
 */
export function rankRecommendations(recs: Recommendation[], max = MAX_RECOMMENDATIONS): Recommendation[] {
  const seen = new Set<string>();
  return recs
    .map((rec, order) => ({ rec, order }))
    .sort((a, b) => RECOMMENDATION_TIERS.indexOf(a.rec.rule) - RECOMMENDATION_TIERS.indexOf(b.rec.rule) || a.order - b.order)
    .map(({ rec }) => rec)
    .filter((rec) => {
      const keys = rec.records.length ? rec.records.map((r) => `${r.type}:${r.id}`) : [rec.rule];
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    })
    .slice(0, max);
}

function greetingFor(now: Date, timeZone: string): string {
  const hour = Number(toLocalInputValue(now.toISOString(), timeZone).slice(11, 13));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

// --- the briefing ----------------------------------------------------------------

export function buildFounderBriefing(input: {
  items: FounderItem[];
  deals: FounderDeal[];
  focus: DailyFocus[];
  now: Date;
  timeZone: string;
  todayKey: string;
  /** Daily priorities can be set on this database (the focus columns exist). */
  prioritiesAvailable: boolean;
  generatedAt: string;
  /** The recorded sales history (founder_deal_activities). Omitted = not loaded. */
  salesHistory?: BriefingSource<DealActivity[]>;
  /** The founder's client handoffs (agency_client_handoffs). Omitted = not loaded. */
  handoffs?: BriefingSource<ClientHandoff[]>;
}): FounderBriefing {
  const { items, deals, focus, now, timeZone, todayKey } = input;
  const salesHistory = input.salesHistory ?? { status: "unavailable" };
  const handoffSource = input.handoffs ?? { status: "unavailable" };
  const plan = buildDailyPlan({ items, deals, focus, now, timeZone, todayKey });
  const { attention } = plan;
  const openPriorities = plan.priorities.filter((item) => item.completedAt == null);
  const href = (item: FounderItem) => itemHref(item, timeZone, todayKey);

  // ---- deal signals: the Deals page's definitions when the history is readable ----
  // A deal already covered by a due follow-up or a missing next step isn't
  // reported again as stalled / cold / stale / waiting (one place per record).
  const coveredDeals = new Set([...attention.dealFollowUps, ...attention.dealsWithoutNextAction].map((deal) => deal.id));
  const notCovered = (entry: { deal: FounderDeal }) => !coveredDeals.has(entry.deal.id);
  const sales = salesHistory.status === "loaded" ? buildSalesToday({ deals, activities: salesHistory.data, items, now, timeZone, todayKey }) : null;
  const outcomeMissing = sales ? firstPerDeal(sales.outcomeMissing) : [];
  const stalled = sales ? sales.stalled.filter(notCovered) : [];
  const cold = sales ? sales.cold.filter(notCovered) : [];
  const proposalsWaiting = sales ? sales.proposalsWaiting.filter(notCovered) : [];
  const stale = sales ? [] : staleDeals(deals, now, timeZone).filter((deal) => !coveredDeals.has(deal.id));

  // ---- client handoffs for won deals (and prepared ones whose deal changed) ----
  const handoffs = handoffSource.status === "loaded" ? handoffSignals(deals, handoffSource.data) : { act: [], waiting: [], reopened: [] };

  // ---- recommendations, tier by tier ----
  const recs: Recommendation[] = [];
  const add = (rec: Omit<Recommendation, "id">) => recs.push({ ...rec, id: rec.records.length ? `${rec.rule}:${rec.records.map((r) => r.id).join("+")}` : rec.rule });

  // Only the next open priority: the priorities card already lists all three,
  // so one recommendation (in the founder's own order) is enough.
  const nextPriority = plan.priorities.findIndex((item) => item.completedAt == null);
  if (nextPriority >= 0) {
    const item = plan.priorities[nextPriority];
    add({ rule: "finish_priority", title: `Finish priority ${nextPriority + 1}: ${item.title}`, why: `You set this as priority ${nextPriority + 1} of ${plan.priorities.length} for today, and it isn't complete${openPriorities.length > 1 ? ` (${openPriorities.length} of ${plan.priorities.length} still open)` : ""}.`, suggestion: null, records: [itemRef(item)], href: PRIORITIES_HREF });
  }

  for (const item of [...attention.overdue].sort(compareItems)) {
    const days = daysBetween(localDateKey(new Date(item.dueAt as string), timeZone), todayKey);
    add({ rule: "resolve_overdue", title: `Resolve overdue ${ITEM_KIND_LABELS[item.kind].toLowerCase()}: ${item.title}`, why: `Due ${whenLabel(item, timeZone)} - ${plural(days, "day")} overdue${item.priority === "high" ? ", high priority" : ""}.`, suggestion: "Complete it, or move it to a realistic day.", records: [itemRef(item)], href: href(item) });
  }

  const prepCutoff = now.getTime() + PREP_WINDOW_MINUTES * 60_000;
  for (const item of [...plan.schedule].sort(compareItems)) {
    if (!item.startsAt || isAllDayEvent(item, timeZone)) continue;
    const start = new Date(item.startsAt).getTime();
    if (start < now.getTime() || start > prepCutoff) continue;
    add({ rule: "prepare_meeting", title: `Get ready for ${item.title}`, why: `${ITEM_KIND_LABELS[item.kind]} starts at ${formatTime(item.startsAt, timeZone)} today.`, suggestion: "Review the notes and linked deal before it starts.", records: [itemRef(item)], href: href(item) });
  }

  for (const item of [...attention.followUpsToday].sort(compareItems)) {
    add({ rule: "follow_up_due", title: `Follow up: ${item.title}`, why: `Follow-up due ${whenLabel(item, timeZone)}.`, suggestion: null, records: [itemRef(item)], href: href(item) });
  }
  for (const deal of [...attention.dealFollowUps].sort(compareDeals)) {
    const overdue = new Date(deal.nextActionAt as string) < now;
    add({ rule: "follow_up_due", title: `${deal.nextAction ?? "Follow up"} - ${deal.name}`, why: `Next action ${overdue ? "was due" : "is due"} ${formatDay(deal.nextActionAt as string, timeZone)}, ${formatTime(deal.nextActionAt as string, timeZone)} (deal at ${DEAL_STAGE_LABELS[deal.stage]}).`, suggestion: null, records: [dealRef(deal)], href: dealHref(deal) });
  }

  for (const meeting of outcomeMissing) {
    add({ rule: "record_meeting_outcome", title: `Record how the meeting went - ${meeting.deal.name}`, why: meetingWhy(meeting, timeZone), suggestion: "Log whether it was held, and set the next step while it's fresh.", records: [dealRef(meeting.deal)], href: dealHref(meeting.deal) });
  }

  if (input.prioritiesAvailable && plan.priorities.length === 0) {
    add({ rule: "set_priorities", title: "Choose today's three priorities", why: "No priorities are set for today.", suggestion: "Pick the three outcomes that would make today a success - the rest of the list gets easier to sort.", records: [], href: PRIORITIES_HREF });
  }

  const noNext = [...attention.dealsWithoutNextAction].sort(compareDeals);
  for (const deal of noNext.filter((d) => LATE_DEAL_STAGES.includes(d.stage))) {
    add({ rule: "deal_next_action_late_stage", title: `Set the next step for ${deal.name}`, why: `Deal is at ${DEAL_STAGE_LABELS[deal.stage]} with no next action or follow-up date recorded.`, suggestion: "Late-stage deals without a next step tend to stall.", records: [dealRef(deal)], href: dealHref(deal) });
  }

  for (const h of handoffs.act) {
    add({ rule: "client_handoff", title: h.title, why: h.why, suggestion: h.suggestion, records: [dealRef(h.deal)], href: dealHref(h.deal) });
  }

  for (const item of [...attention.deadlinesSoon].sort(compareItems)) {
    add({ rule: "deadline_soon", title: `Plan for deadline: ${item.title}`, why: `Deadline ${whenLabel(item, timeZone)}.`, suggestion: "Block time for it before the day arrives.", records: [itemRef(item)], href: href(item) });
  }

  for (const deal of noNext.filter((d) => !LATE_DEAL_STAGES.includes(d.stage))) {
    add({ rule: "deal_next_action", title: `Decide the next step for ${deal.name}`, why: `Deal is at ${DEAL_STAGE_LABELS[deal.stage]} with no next action or follow-up date recorded.`, suggestion: null, records: [dealRef(deal)], href: dealHref(deal) });
  }

  for (const entry of stalled) {
    add({ rule: "stalled_deal", title: `Check in on ${entry.deal.name}`, why: `${entry.basis} (deal at ${DEAL_STAGE_LABELS[entry.deal.stage]}).`, suggestion: "It may need a touch - or an update to its stage.", records: [dealRef(entry.deal)], href: dealHref(entry.deal) });
  }
  for (const entry of cold) {
    add({ rule: "cold_prospect", title: `Decide on ${entry.deal.name}`, why: `${entry.basis}.`, suggestion: "Try another channel, or close it as lost with the reason.", records: [dealRef(entry.deal)], href: dealHref(entry.deal) });
  }

  for (const deal of stale) {
    const touch = lastTouch(deal);
    const days = daysBetween(localDateKey(new Date(touch.at), timeZone), todayKey);
    add({ rule: "stale_deal", title: `Check in on ${deal.name}`, why: `${touch.recordedActivity ? "No sales activity recorded" : "No change recorded on this deal"} since ${formatDay(touch.at, timeZone)} (${plural(days, "day")}), and no upcoming follow-up date.`, suggestion: "It may need a touch - or an update to its stage.", records: [dealRef(deal)], href: dealHref(deal) });
  }

  const recommended = rankRecommendations(recs);
  const recommendedKeys = new Set(recommended.flatMap((rec) => rec.records.map((r) => `${r.type}:${r.id}`)));

  // ---- needs attention: everything actionable, minus what's already recommended ----
  const allAttention: AttentionEntry[] = [
    ...[...attention.overdue].sort(compareItems).map((item): AttentionEntry => ({ id: `overdue:${item.id}`, kind: "overdue", title: item.title, detail: `${ITEM_KIND_LABELS[item.kind]} due ${whenLabel(item, timeZone)}`, suggestion: null, href: href(item), record: itemRef(item) })),
    ...[...attention.followUpsToday].sort(compareItems).map((item): AttentionEntry => ({ id: `follow_up_today:${item.id}`, kind: "follow_up_today", title: item.title, detail: `Follow-up due ${whenLabel(item, timeZone)}`, suggestion: null, href: href(item), record: itemRef(item) })),
    ...[...attention.deadlinesSoon].sort(compareItems).map((item): AttentionEntry => ({ id: `deadline_soon:${item.id}`, kind: "deadline_soon", title: item.title, detail: `Deadline ${whenLabel(item, timeZone)}`, suggestion: null, href: href(item), record: itemRef(item) })),
    ...[...attention.dealFollowUps].sort(compareDeals).map((deal): AttentionEntry => ({ id: `deal_follow_up:${deal.id}`, kind: "deal_follow_up", title: deal.name, detail: `${deal.nextAction ?? "Follow up"} - due ${formatDay(deal.nextActionAt as string, timeZone)}`, suggestion: null, href: dealHref(deal), record: dealRef(deal) })),
    ...outcomeMissing.map((m): AttentionEntry => ({ id: `meeting_outcome_missing:${m.deal.id}`, kind: "meeting_outcome_missing", title: m.deal.name, detail: `Meeting ${formatDay(m.startsAt, timeZone)} - no outcome recorded`, suggestion: null, href: dealHref(m.deal), record: dealRef(m.deal) })),
    ...handoffs.act.map((h): AttentionEntry => ({ id: `client_handoff:${h.deal.id}`, kind: "client_handoff", title: h.deal.name, detail: h.detail, suggestion: null, href: dealHref(h.deal), record: dealRef(h.deal) })),
    ...noNext.map((deal): AttentionEntry => ({ id: `deal_no_next_action:${deal.id}`, kind: "deal_no_next_action", title: deal.name, detail: `${DEAL_STAGE_LABELS[deal.stage]} - no next action recorded`, suggestion: null, href: dealHref(deal), record: dealRef(deal) })),
    ...stalled.map((e): AttentionEntry => ({ id: `stalled_deal:${e.deal.id}`, kind: "stalled_deal", title: e.deal.name, detail: e.basis, suggestion: "May need a touch", href: dealHref(e.deal), record: dealRef(e.deal) })),
    ...cold.map((e): AttentionEntry => ({ id: `cold_prospect:${e.deal.id}`, kind: "cold_prospect", title: e.deal.name, detail: e.basis, suggestion: null, href: dealHref(e.deal), record: dealRef(e.deal) })),
    ...proposalsWaiting.map((e): AttentionEntry => ({ id: `proposal_waiting:${e.deal.id}`, kind: "proposal_waiting", title: e.deal.name, detail: e.basis, suggestion: null, href: dealHref(e.deal), record: dealRef(e.deal) })),
    ...handoffs.waiting.map((h): AttentionEntry => ({ id: `handoff_waiting:${h.deal.id}`, kind: "handoff_waiting", title: h.deal.name, detail: `Handoff prepared ${formatDay(h.handoff.preparedAt, timeZone)} - waiting for an agency admin to confirm`, suggestion: null, href: dealHref(h.deal), record: dealRef(h.deal) })),
    ...stale.map((deal): AttentionEntry => ({ id: `stale_deal:${deal.id}`, kind: "stale_deal", title: deal.name, detail: `${lastTouch(deal).recordedActivity ? "No activity recorded" : "No change recorded"} since ${formatDay(lastTouch(deal).at, timeZone)}`, suggestion: "May need a touch", href: dealHref(deal), record: dealRef(deal) })),
  ];

  // One entry per record, in the order above (the most actionable reason wins).
  const attentionSeen = new Set<string>();
  const uniqueAttention = allAttention.filter((entry) => {
    const key = `${entry.record.type}:${entry.record.id}`;
    if (attentionSeen.has(key)) return false;
    attentionSeen.add(key);
    return true;
  });

  // ---- review needed: conflicting or incomplete information ----
  const review: ReviewFlag[] = [];
  for (const [a, b] of scheduleConflicts(plan.schedule, timeZone)) {
    review.push({ id: `schedule_conflict:${a.id}+${b.id}`, kind: "schedule_conflict", title: `${a.title} overlaps ${b.title}`, detail: `${formatTime(a.startsAt as string, timeZone)} and ${formatTime(b.startsAt as string, timeZone)} today overlap.`, href: calendarHref("day", todayKey), records: [itemRef(a), itemRef(b)] });
  }
  const dealsById = new Map(deals.map((deal) => [deal.id, deal]));
  for (const deal of deals.filter(isOpenDeal).sort(compareDeals)) {
    if (deal.nextActionAt && !deal.nextAction) review.push({ id: `follow_up_without_action:${deal.id}`, kind: "follow_up_without_action", title: deal.name, detail: `Has a follow-up date (${formatDay(deal.nextActionAt, timeZone)}) but no action written down.`, href: dealHref(deal), records: [dealRef(deal)] });
    if (LATE_DEAL_STAGES.includes(deal.stage) && deal.expectedMrr == null) review.push({ id: `late_deal_without_value:${deal.id}`, kind: "late_deal_without_value", title: deal.name, detail: `At ${DEAL_STAGE_LABELS[deal.stage]} with no expected monthly fee recorded.`, href: dealHref(deal), records: [dealRef(deal)] });
  }
  for (const item of sortByTimeThenPriority(items.filter((i) => i.completedAt == null && i.dealId))) {
    const deal = dealsById.get(item.dealId as string);
    if (deal && !isOpenDeal(deal)) review.push({ id: `open_item_on_closed_deal:${item.id}`, kind: "open_item_on_closed_deal", title: item.title, detail: `Still open, but its deal ${deal.name} is ${DEAL_STAGE_LABELS[deal.stage].toLowerCase()}.`, href: href(item), records: [itemRef(item), dealRef(deal)] });
  }
  for (const deal of handoffs.reopened) {
    review.push({ id: `handoff_on_reopened_deal:${deal.id}`, kind: "handoff_on_reopened_deal", title: deal.name, detail: `Handed off as a client, but the deal is now ${DEAL_STAGE_LABELS[deal.stage].toLowerCase()}.`, href: dealHref(deal), records: [dealRef(deal)] });
  }

  // ---- workload ----
  const commitments = plan.schedule.length + plan.dueToday.length + attention.followUpsToday.length + openPriorities.length;
  const level: Workload["level"] = commitments === 0 && attention.overdue.length === 0 ? "clear" : commitments <= 3 ? "light" : commitments <= 7 ? "moderate" : "heavy";
  const parts = [plural(plan.schedule.length, "meeting or event", "meetings and events"), plural(plan.dueToday.length + attention.followUpsToday.length, "item due", "items due")];
  if (openPriorities.length) parts.push(plural(openPriorities.length, "open priority", "open priorities"));
  if (attention.overdue.length) parts.push(`${attention.overdue.length} overdue`);
  const summary = level === "clear" ? "A clear day: nothing scheduled, due or overdue." : `${level[0].toUpperCase()}${level.slice(1)} day: ${parts.join(", ")}.`;

  return {
    generated_at: input.generatedAt,
    timezone: timeZone,
    date: todayKey,
    greeting: greetingFor(now, timeZone),
    workload: { level, meetings: plan.schedule.length, dueToday: plan.dueToday.length + attention.followUpsToday.length, overdue: attention.overdue.length, prioritiesOpen: openPriorities.length, summary },
    best_next_action: recommended[0] ?? null,
    top_priorities: { items: plan.priorities, done: plan.priorities.length - openPriorities.length, total: plan.priorities.length, max: MAX_DAILY_PRIORITIES },
    today: { schedule: plan.schedule, due: plan.dueToday },
    needs_attention: uniqueAttention.filter((entry) => !recommendedKeys.has(`${entry.record.type}:${entry.record.id}`)),
    attention_total: uniqueAttention.length,
    recommended_actions: recommended,
    review_needed: review,
    coming_up: plan.upcoming,
    progress: plan.progress,
    coverage: { salesHistory: salesHistory.status, handoffs: handoffSource.status },
  };
}

// --- sales and handoff helpers ---------------------------------------------------------

/** The earliest entry per deal (input is already in Deals' order) - one record, one place. */
function firstPerDeal<T extends { deal: FounderDeal }>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => (seen.has(entry.deal.id) ? false : (seen.add(entry.deal.id), true)));
}

function meetingWhy(meeting: MeetingEntry, timeZone: string): string {
  const source = meeting.source === "calendar" ? "on your calendar" : "logged as booked";
  return `The meeting ${source} for ${formatDay(meeting.startsAt, timeZone)}, ${formatTime(meeting.startsAt, timeZone)} has no held or no-show recorded since.`;
}

type HandoffAct = { deal: FounderDeal; title: string; why: string; detail: string; suggestion: string | null };

/**
 * What the founder's handoffs ask of them, from handoffState (the same rules
 * the Deals page shows): a won deal ready to hand off or missing details, and
 * a prepared handoff the deal no longer matches (it can't be confirmed) -
 * actions. A current prepared handoff only waits on an agency admin, and a
 * confirmed one on a reopened deal is a conflict to check.
 */
function handoffSignals(deals: FounderDeal[], handoffs: ClientHandoff[]): { act: HandoffAct[]; waiting: { deal: FounderDeal; handoff: ClientHandoff }[]; reopened: FounderDeal[] } {
  const act: HandoffAct[] = [];
  const waiting: { deal: FounderDeal; handoff: ClientHandoff }[] = [];
  const reopened: FounderDeal[] = [];
  const withHandoff = new Set(handoffs.map((h) => h.dealId));
  const ordered = deals.filter((deal) => deal.stage === "won" || withHandoff.has(deal.id)).sort((a, b) => (a.wonOn ?? "").localeCompare(b.wonOn ?? "") || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const deal of ordered) {
    const state = handoffState(deal, handoffs);
    if (state.kind === "ready") {
      act.push({ deal, title: `Prepare the client handoff for ${deal.name}`, why: "Won, with the agreed fees and contact details recorded, and no handoff prepared yet.", detail: "Won - client handoff not prepared", suggestion: "Write the agreed scope so an agency admin can confirm the client." });
    } else if (state.kind === "missing_info") {
      act.push({ deal, title: `Complete ${deal.name} for its client handoff`, why: `Won, but the handoff still needs ${state.missing.join(", ")}.`, detail: `Won - handoff needs ${state.missing.join(", ")}`, suggestion: null });
    } else if (state.kind === "prepared") {
      if (handoffOutOfDate(state.handoff, deal)) {
        act.push({ deal, title: `Redo the client handoff for ${deal.name}`, why: "The deal changed after its handoff was prepared, so the handoff can't be confirmed as it stands.", detail: "Handoff out of date with the deal", suggestion: "Cancel it and prepare it again from the deal." });
      } else {
        waiting.push({ deal, handoff: state.handoff });
      }
    } else if (state.kind === "confirmed" && state.dealReopened) {
      reopened.push(deal);
    }
  }
  return { act, waiting, reopened };
}

const SOURCE_NOT_CHECKED: Record<keyof BriefingCoverage, Record<Exclude<SourceStatus, "loaded">, string>> = {
  salesHistory: { unavailable: "sales history isn't enabled on this database, so meeting outcomes, stalled deals and cold prospects weren't checked", failed: "sales history didn't load, so meeting outcomes, stalled deals and cold prospects weren't checked" },
  handoffs: { unavailable: "client handoffs aren't enabled on this database, so won deals weren't checked for a handoff", failed: "client handoffs didn't load, so won deals weren't checked for a handoff" },
};

/** What an empty briefing can honestly claim was checked - and what it couldn't check. */
export type CoverageStatement = { checked: string; notChecked: string[] };
export function coverageStatement(coverage: BriefingCoverage): CoverageStatement {
  // Each phrase is a rule that would have produced a recommendation. Tasks due
  // later today aren't one (they're listed under Today), so they aren't claimed.
  const checked = ["no open priorities", "nothing overdue", "no follow-up due today", `no deadline in the next ${DEADLINE_WINDOW_DAYS} days`, `no meeting in the next ${PREP_WINDOW_MINUTES / 60} hours`, "every open deal has a next step that isn't due yet"];
  if (coverage.salesHistory === "loaded") checked.push("no meeting is missing its outcome", "no deal has stalled or gone cold");
  else checked.push(`no open deal has gone ${STALE_DEAL_DAYS} days without a change`);
  if (coverage.handoffs === "loaded") checked.push("every won deal's client handoff is in hand");
  const notChecked = (Object.keys(SOURCE_NOT_CHECKED) as (keyof BriefingCoverage)[]).flatMap((key) => (coverage[key] === "loaded" ? [] : [SOURCE_NOT_CHECKED[key][coverage[key] as Exclude<SourceStatus, "loaded">]]));
  const last = checked.pop() as string;
  return { checked: `${checked.join(", ")}, and ${last}`, notChecked };
}

// --- end of day --------------------------------------------------------------------

export type EndOfDaySummary = {
  dayKey: string;
  completed: number;
  /** Today's commitments (priorities + items due that day), done or not. */
  committed: number;
  committedDone: number;
  unfinished: number;
  stillOverdue: number;
  dealChanges: number;
  /** Agreed (contracted) terms of deals won that day, per currency - not collected money. */
  wonSetup: CurrencyTotals;
  wonMonthly: CurrencyTotals;
  tomorrowPriorities: number;
  sentence: string;
};

/**
 * The factual close-out line for a day: only what the records confirm -
 * completions with a completed_at that day, items still open, deal records
 * created/won/lost/edited that day, and tomorrow's priorities as set.
 */
export function buildEndOfDaySummary(input: { items: FounderItem[]; deals: FounderDeal[]; focus: DailyFocus[]; dayKey: string; timeZone: string }): EndOfDaySummary {
  const r = reviewDay({ items: input.items, deals: input.deals, dayKey: input.dayKey, timeZone: input.timeZone });
  const day = dayRange(input.dayKey, input.timeZone);
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const committed = new Map<string, FounderItem>();
  for (const f of input.focus) if (f.date === input.dayKey && byId.has(f.itemId)) committed.set(f.itemId, byId.get(f.itemId) as FounderItem);
  for (const item of input.items) if (!SCHEDULED_KINDS.includes(item.kind) && item.dueAt && new Date(item.dueAt) >= day.start && new Date(item.dueAt) < day.end) committed.set(item.id, item);
  const committedDone = [...committed.values()].filter((item) => item.completedAt != null).length;
  const tomorrow = addDaysKey(input.dayKey, 1);
  const tomorrowPriorities = input.focus.filter((f) => f.date === tomorrow && byId.has(f.itemId)).length;
  const dealChanges = r.pipeline.created.length + r.pipeline.won.length + r.pipeline.lost.length + r.pipeline.updated.length;
  const wonSetup: CurrencyTotals = {};
  const wonMonthly: CurrencyTotals = {};
  for (const deal of r.pipeline.won) {
    addToTotals(wonSetup, deal.currency, deal.wonSetupFee ?? 0);
    addToTotals(wonMonthly, deal.currency, deal.wonMonthlyFee ?? 0);
  }
  const wonTerms = r.pipeline.won.length ? `${formatTotals(wonSetup)} setup + ${formatTotals(wonMonthly)}/mo agreed` : null;
  const parts = [
    committed.size ? `${committedDone} of ${committed.size} commitments done` : "no commitments were set",
    plural(r.completed.length, "item completed", "items completed"),
  ];
  if (r.unfinished.length) parts.push(`${r.unfinished.length} still open`);
  if (r.stillOverdue.length) parts.push(`${r.stillOverdue.length} overdue from earlier`);
  parts.push(dealChanges ? `${plural(dealChanges, "deal change")}${wonTerms ? ` (won: ${wonTerms})` : ""}` : "no deal changes");
  parts.push(tomorrowPriorities ? `${tomorrowPriorities} of ${MAX_DAILY_PRIORITIES} priorities set for ${formatDateKey(tomorrow, { weekday: "long" })}` : `no priorities set for ${formatDateKey(tomorrow, { weekday: "long" })} yet`);
  return {
    dayKey: input.dayKey,
    completed: r.completed.length,
    committed: committed.size,
    committedDone,
    unfinished: r.unfinished.length,
    stillOverdue: r.stillOverdue.length,
    dealChanges,
    wonSetup,
    wonMonthly,
    tomorrowPriorities,
    sentence: `${parts[0][0].toUpperCase()}${parts[0].slice(1)}; ${parts.slice(1).join("; ")}.`,
  };
}

export { DEADLINE_WINDOW_DAYS };
