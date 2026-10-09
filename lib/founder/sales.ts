/**
 * Founder sales operating system - the pure part: what can be recorded on a
 * deal, input parsing, the "what needs doing" views and the sales metrics.
 * No I/O (queries.ts reads, app/founder/actions.ts writes through the
 * founder_* database functions in supabase/pending/founder_sales_os.sql).
 *
 * Evidence only. Every view and metric is computed from what was recorded:
 * an outreach, reply, meeting, proposal or win counts only if it was logged
 * (or recorded as a stage change). Nothing here infers that something
 * happened, and nothing here is payment data - won terms are contracted,
 * not collected.
 *
 * Two kinds of numbers, kept apart:
 *  - the pipeline snapshot (how many deals sit at each stage right now), and
 *  - measured conversion, which only exists from the first recorded
 *    activity onward (MeasuredWindow.since) - deals created before the
 *    sales history existed carry only their current stage.
 */
import { DEAL_STAGES, OPEN_DEAL_STAGES, addToTotals, dayRange, isDateKey, isOpenDeal, money, parseCurrency, parseLocalDateTime, text, type CurrencyTotals, type DealStage, type FounderDeal, type FounderItem, type Parsed } from "./model";

// --- vocabulary ----------------------------------------------------------------------

/** Things that happened, logged by hand. */
export const EVIDENCE_KINDS = ["outreach", "reply_received", "meeting_booked", "meeting_held", "meeting_no_show", "demo_completed", "audit_completed", "proposal_sent", "note"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
/** Stage history, written only with a stage change. */
export const STAGE_KINDS = ["stage_change", "won", "lost", "reopened"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];
export type DealActivityKind = EvidenceKind | StageKind;

export const ACTIVITY_KIND_LABELS: Record<DealActivityKind, string> = {
  outreach: "Outreach sent",
  reply_received: "Reply received",
  meeting_booked: "Meeting booked",
  meeting_held: "Meeting held",
  meeting_no_show: "No-show",
  demo_completed: "Demo completed",
  audit_completed: "Audit completed",
  proposal_sent: "Proposal sent",
  note: "Note",
  stage_change: "Stage changed",
  won: "Won",
  lost: "Lost",
  reopened: "Reopened",
};

export const ACTIVITY_CHANNELS = ["email", "phone", "text", "social", "in_person", "video", "other"] as const;
export type ActivityChannel = (typeof ACTIVITY_CHANNELS)[number];
export const ACTIVITY_CHANNEL_LABELS: Record<ActivityChannel, string> = { email: "Email", phone: "Phone", text: "Text", social: "Social / DM", in_person: "In person", video: "Video call", other: "Other" };

/** The stage an evidence entry usually moves a deal to - offered, never applied without the founder choosing it. */
export const EVIDENCE_STAGE: Partial<Record<EvidenceKind, DealStage>> = {
  outreach: "outreach",
  reply_received: "replied",
  meeting_booked: "meeting_booked",
  meeting_held: "meeting_held",
  proposal_sent: "proposal_sent",
};

export type DealActivity = {
  id: string;
  dealId: string;
  kind: DealActivityKind;
  occurredAt: string;
  channel: ActivityChannel | null;
  scheduledFor: string | null;
  summary: string | null;
  fromStage: DealStage | null;
  toStage: DealStage | null;
  setupFee: number | null;
  monthlyFee: number | null;
  currency: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  recordedAt: string;
};

export const stageRank = (stage: DealStage): number => DEAL_STAGES.indexOf(stage);
export const isStageKind = (kind: DealActivityKind): kind is StageKind => (STAGE_KINDS as readonly string[]).includes(kind);
const live = (a: DealActivity) => a.voidedAt == null;

/** The forward stage a piece of evidence suggests for this deal (null when it wouldn't move it forward). */
export function suggestedStage(kind: EvidenceKind, current: DealStage): DealStage | null {
  const target = EVIDENCE_STAGE[kind];
  if (!target || !OPEN_DEAL_STAGES.includes(current)) return null;
  return stageRank(target) > stageRank(current) ? target : null;
}

// --- parsing ---------------------------------------------------------------------------

/** How far ahead of the server clock an "already happened" time may be (clock skew). */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;

export type ActivityInput = { kind: EvidenceKind; occurredAt: string; channel: ActivityChannel | null; summary: string | null; scheduledFor: string | null; toStage: DealStage | null };

/**
 * Something that happened on a deal. `occurredAt` (local date-time) is
 * required and can't be in the future - only record what already happened.
 * A booked meeting may carry when the meeting is (`scheduledFor`).
 * `advance` = also move the deal to the stage this evidence suggests.
 */
export function parseActivityInput(raw: Record<string, unknown>, deal: Pick<FounderDeal, "stage">, timeZone: string, now: Date): Parsed<ActivityInput> {
  const kind = String(raw.kind ?? "").trim();
  if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) return { ok: false, error: "Choose what happened." };
  const occurred = parseLocalDateTime(raw.occurredAt, timeZone);
  if (!occurred.ok) return occurred;
  if (!occurred.value) return { ok: false, error: "Enter when it happened." };
  if (new Date(occurred.value).getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return { ok: false, error: "Only record things that have already happened." };
  const channelRaw = String(raw.channel ?? "").trim();
  if (channelRaw && !(ACTIVITY_CHANNELS as readonly string[]).includes(channelRaw)) return { ok: false, error: "Choose a valid channel." };
  const summary = text(raw.summary, 1000, "the summary");
  if (!summary.ok) return summary;
  let scheduledFor: string | null = null;
  if (kind === "meeting_booked") {
    const when = parseLocalDateTime(raw.scheduledFor, timeZone);
    if (!when.ok) return when;
    scheduledFor = when.value;
  }
  const advance = raw.advance === true || raw.advance === "on" || raw.advance === "true";
  return {
    ok: true,
    value: {
      kind: kind as EvidenceKind,
      occurredAt: occurred.value,
      channel: (channelRaw || null) as ActivityChannel | null,
      summary: summary.value,
      scheduledFor,
      toStage: advance ? suggestedStage(kind as EvidenceKind, deal.stage) : null,
    },
  };
}

export type StageChangeInput = {
  toStage: DealStage;
  occurredAt: string | null;
  setupFee: number | null;
  monthlyFee: number | null;
  currency: string | null;
  wonOn: string | null;
  reason: string | null;
};

/**
 * A stage change from `current`. Won needs the agreed setup fee, monthly
 * fee, currency and the date (not in the future); lost needs a reason; a
 * won or lost deal is reopened to an open stage before its outcome changes.
 * The database enforces the same rules again.
 */
export function parseStageChange(raw: Record<string, unknown>, current: DealStage, todayKey: string, timeZone: string, now: Date): Parsed<StageChangeInput> {
  const to = String(raw.toStage ?? "").trim();
  if (!(DEAL_STAGES as readonly string[]).includes(to)) return { ok: false, error: "Choose a valid stage." };
  const toStage = to as DealStage;
  if (toStage === current) return { ok: false, error: "The deal is already at that stage." };
  if (!isOpenDeal({ stage: current }) && !isOpenDeal({ stage: toStage })) return { ok: false, error: "Reopen the deal to an open stage before changing its outcome." };
  let occurredAt: string | null = null;
  if (String(raw.occurredAt ?? "").trim()) {
    const when = parseLocalDateTime(raw.occurredAt, timeZone);
    if (!when.ok) return when;
    occurredAt = when.value;
    if (occurredAt && new Date(occurredAt).getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return { ok: false, error: "A stage change can't be dated in the future." };
  }
  const reason = text(raw.reason, 500, toStage === "lost" ? "why the deal was lost" : "the note", toStage === "lost");
  if (!reason.ok) return reason;
  if (toStage !== "won") return { ok: true, value: { toStage, occurredAt, setupFee: null, monthlyFee: null, currency: null, wonOn: null, reason: reason.value } };

  const setupFee = money(raw.setupFee, "the agreed setup fee", true);
  if (!setupFee.ok) return setupFee;
  const monthlyFee = money(raw.monthlyFee, "the agreed monthly fee", true);
  if (!monthlyFee.ok) return monthlyFee;
  const currency = parseCurrency(raw.currency);
  if (!currency.ok) return currency;
  const wonOn = String(raw.wonOn ?? "").trim();
  if (!isDateKey(wonOn)) return { ok: false, error: "Enter the date the deal was won." };
  if (wonOn > todayKey) return { ok: false, error: "The won date can't be in the future." };
  return { ok: true, value: { toStage, occurredAt, setupFee: setupFee.value, monthlyFee: monthlyFee.value, currency: currency.value, wonOn, reason: reason.value } };
}

// --- what needs doing ---------------------------------------------------------------------

/** No recorded activity for this long on a deal past first reply (and nothing scheduled) = stalled. */
export const STALL_DAYS = 14;
/** Outreach attempts with no recorded reply before a prospect counts as cold. */
export const COLD_ATTEMPTS = 3;
/** ...or days since the last outreach with no recorded reply. */
export const COLD_DAYS = 21;
export const MEETING_LOOKAHEAD_DAYS = 7;
/** Meetings that ended up to this long ago without a recorded outcome are flagged. */
export const OUTCOME_LOOKBACK_DAYS = 14;

const DAY = 86_400_000;
const daysSince = (iso: string, now: Date) => Math.floor((now.getTime() - new Date(iso).getTime()) / DAY);

export type SalesEntry = {
  deal: FounderDeal;
  /** The recorded fact this entry rests on, in words. */
  basis: string;
  /** For ordering and display: the moment the basis refers to. */
  at: string | null;
};
export type MeetingEntry = { deal: FounderDeal; startsAt: string; source: "calendar" | "logged"; itemId: string | null; activityId: string | null };

export type SalesToday = {
  /** Identified / qualified deals whose next action is due today or overdue. */
  outreachDue: SalesEntry[];
  /** Deals already in conversation whose follow-up is due today or overdue. */
  followUpsDue: SalesEntry[];
  /** Meetings in the next MEETING_LOOKAHEAD_DAYS days (calendar meetings linked to a deal, or a logged booking with a time). */
  meetings: MeetingEntry[];
  /** Meetings that should have happened, with no held / no-show recorded since. */
  outcomeMissing: MeetingEntry[];
  /** Proposal sent / negotiation, oldest wait first. */
  proposalsWaiting: SalesEntry[];
  /** Past first reply, no recorded activity for STALL_DAYS+, nothing scheduled. */
  stalled: SalesEntry[];
  /** Open deals with neither a next action nor a follow-up date. */
  noNextAction: SalesEntry[];
  /** At outreach with no recorded reply after COLD_ATTEMPTS attempts or COLD_DAYS days. */
  cold: SalesEntry[];
};

function byDeal(activities: DealActivity[]): Map<string, DealActivity[]> {
  const map = new Map<string, DealActivity[]>();
  for (const a of activities) {
    if (!live(a)) continue;
    const list = map.get(a.dealId) ?? [];
    list.push(a);
    map.set(a.dealId, list);
  }
  for (const list of map.values()) list.sort((x, y) => (x.occurredAt < y.occurredAt ? -1 : x.occurredAt > y.occurredAt ? 1 : x.recordedAt < y.recordedAt ? -1 : 1));
  return map;
}

const compareAt = (a: { at: string | null; deal: FounderDeal }, b: { at: string | null; deal: FounderDeal }) => {
  const x = a.at ?? "9999";
  const y = b.at ?? "9999";
  return x < y ? -1 : x > y ? 1 : a.deal.name.localeCompare(b.deal.name) || (a.deal.id < b.deal.id ? -1 : 1);
};

export function buildSalesToday(input: { deals: FounderDeal[]; activities: DealActivity[]; items: FounderItem[]; now: Date; timeZone: string; todayKey: string }): SalesToday {
  const { deals, now, timeZone, todayKey } = input;
  const todayEnd = dayRange(todayKey, timeZone).end;
  const open = deals.filter(isOpenDeal);
  const history = byDeal(input.activities);
  const dealsById = new Map(deals.map((d) => [d.id, d]));
  const due = (d: FounderDeal) => d.nextActionAt != null && new Date(d.nextActionAt) < todayEnd;
  const dueBasis = (d: FounderDeal) => `${d.nextAction ?? "Follow-up"} - due ${new Date(d.nextActionAt as string) < now ? "and overdue" : "today"}`;

  const outreachDue = open.filter((d) => (d.stage === "identified" || d.stage === "qualified") && due(d)).map((d) => ({ deal: d, basis: dueBasis(d), at: d.nextActionAt }));
  const followUpsDue = open.filter((d) => d.stage !== "identified" && d.stage !== "qualified" && due(d)).map((d) => ({ deal: d, basis: dueBasis(d), at: d.nextActionAt }));

  // Meetings: calendar meetings linked to an open deal, plus logged bookings with a time.
  const horizon = now.getTime() + MEETING_LOOKAHEAD_DAYS * DAY;
  const outcomeFloor = now.getTime() - OUTCOME_LOOKBACK_DAYS * DAY;
  const meetings: MeetingEntry[] = [];
  const outcomeMissing: MeetingEntry[] = [];
  const outcomeAfter = (dealId: string, startIso: string) =>
    (history.get(dealId) ?? []).some((a) => (a.kind === "meeting_held" || a.kind === "meeting_no_show") && new Date(a.occurredAt).getTime() >= new Date(startIso).getTime() - 12 * 3_600_000);
  const seen = new Set<string>();
  for (const item of input.items) {
    if (item.kind !== "meeting" || !item.startsAt || !item.dealId) continue;
    const deal = dealsById.get(item.dealId);
    if (!deal || !isOpenDeal(deal)) continue;
    const start = new Date(item.startsAt).getTime();
    const end = new Date(item.endsAt ?? item.startsAt).getTime();
    const entry: MeetingEntry = { deal, startsAt: item.startsAt, source: "calendar", itemId: item.id, activityId: null };
    if (start >= now.getTime() && start < horizon) meetings.push(entry);
    else if (end < now.getTime() && end >= outcomeFloor && !outcomeAfter(deal.id, item.startsAt)) outcomeMissing.push(entry);
    seen.add(`${deal.id}:${item.startsAt}`);
  }
  for (const [dealId, list] of history) {
    const deal = dealsById.get(dealId);
    if (!deal || !isOpenDeal(deal)) continue;
    for (const a of list) {
      if (a.kind !== "meeting_booked" || !a.scheduledFor || seen.has(`${dealId}:${a.scheduledFor}`)) continue;
      const start = new Date(a.scheduledFor).getTime();
      const entry: MeetingEntry = { deal, startsAt: a.scheduledFor, source: "logged", itemId: null, activityId: a.id };
      if (start >= now.getTime() && start < horizon) meetings.push(entry);
      else if (start < now.getTime() && start >= outcomeFloor && !outcomeAfter(dealId, a.scheduledFor)) outcomeMissing.push(entry);
      seen.add(`${dealId}:${a.scheduledFor}`);
    }
  }
  const byStart = (a: MeetingEntry, b: MeetingEntry) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.deal.id < b.deal.id ? -1 : 1);

  const proposalsWaiting = open
    .filter((d) => d.stage === "proposal_sent" || d.stage === "negotiation")
    .map((d) => {
      const sent = [...(history.get(d.id) ?? [])].reverse().find((a) => a.kind === "proposal_sent");
      const since = sent?.occurredAt ?? d.stageChangedAt ?? d.createdAt;
      const days = Math.max(0, daysSince(since, now));
      return { deal: d, at: since, basis: sent ? `Proposal sent ${days} day${days === 1 ? "" : "s"} ago (recorded)` : `At ${d.stage === "negotiation" ? "negotiation" : "proposal sent"} for ${days} day${days === 1 ? "" : "s"} - no proposal logged` };
    });

  const followUpIds = new Set(followUpsDue.map((e) => e.deal.id));
  const stalled = open
    .filter((d) => stageRank(d.stage) >= stageRank("replied") && !followUpIds.has(d.id) && !(d.nextActionAt && new Date(d.nextActionAt) >= now))
    .map((d) => {
      const last = d.lastActivityAt;
      const since = last ?? d.stageChangedAt ?? d.createdAt;
      return { deal: d, at: since, days: daysSince(since, now), recorded: last != null };
    })
    .filter((e) => e.days >= STALL_DAYS)
    .map((e) => ({ deal: e.deal, at: e.at, basis: e.recorded ? `No activity recorded for ${e.days} days, nothing scheduled` : `No activity recorded; at this stage for ${e.days} days, nothing scheduled` }));

  const noNextAction = open.filter((d) => !d.nextAction && !d.nextActionAt).map((d) => ({ deal: d, at: d.stageChangedAt ?? d.createdAt, basis: "No next action or follow-up date" }));

  const cold: SalesEntry[] = [];
  for (const d of open.filter((x) => x.stage === "outreach")) {
    const list = history.get(d.id) ?? [];
    const lastReply = [...list].reverse().find((a) => a.kind === "reply_received");
    const attempts = list.filter((a) => a.kind === "outreach" && (!lastReply || a.occurredAt > lastReply.occurredAt));
    if (!attempts.length) continue;
    const lastOutreach = attempts[attempts.length - 1];
    const days = daysSince(lastOutreach.occurredAt, now);
    if (attempts.length >= COLD_ATTEMPTS || days >= COLD_DAYS) {
      cold.push({ deal: d, at: lastOutreach.occurredAt, basis: `${attempts.length} outreach attempt${attempts.length === 1 ? "" : "s"} recorded, last ${days} day${days === 1 ? "" : "s"} ago, no reply recorded` });
    }
  }

  return {
    outreachDue: outreachDue.sort(compareAt),
    followUpsDue: followUpsDue.sort(compareAt),
    meetings: meetings.sort(byStart),
    outcomeMissing: outcomeMissing.sort(byStart),
    proposalsWaiting: proposalsWaiting.sort(compareAt),
    stalled: stalled.sort(compareAt),
    noNextAction: noNextAction.sort(compareAt),
    cold: cold.sort(compareAt),
  };
}

// --- metrics -------------------------------------------------------------------------------

export const METRIC_PERIODS = [30, 90, 365] as const;
export type MetricPeriod = (typeof METRIC_PERIODS)[number];

export type SalesMetrics = {
  fromKey: string;
  toKey: string;
  /** The first recorded activity (any time) - conversion is only measured from here. Null = nothing recorded yet. */
  measuredSince: string | null;
  /** Logged evidence in the period (voided entries excluded). */
  activity: Record<EvidenceKind, number>;
  /**
   * Of deals whose first recorded outreach falls in the period, how many
   * have since (any time after) a recorded reply, meeting held, proposal
   * sent, and win. A later stage recorded counts as reaching the earlier one.
   */
  cohort: { outreached: number; replied: number; meetingHeld: number; proposalSent: number; won: number };
  /** Deals currently won with a won date in the period - contracted terms, per currency. Not collected money. */
  won: { count: number; setup: CurrencyTotals; monthly: CurrencyTotals };
  /** Deals currently lost with a lost date in the period, and the stage each was lost from (as recorded). */
  lost: { count: number; fromStage: Partial<Record<DealStage | "not_recorded", number>>; reasons: { reason: string; count: number }[] };
};

/** [fromKey, toKey] inclusive local days: the last `days` days ending today. */
export function periodRange(todayKey: string, days: number): { fromKey: string; toKey: string } {
  const to = new Date(`${todayKey}T00:00:00Z`);
  const from = new Date(to.getTime() - (days - 1) * DAY);
  return { fromKey: from.toISOString().slice(0, 10), toKey: todayKey };
}

export function buildSalesMetrics(input: { deals: FounderDeal[]; activities: DealActivity[]; fromKey: string; toKey: string; timeZone: string }): SalesMetrics {
  const { deals, fromKey, toKey, timeZone } = input;
  const start = dayRange(fromKey, timeZone).start.getTime();
  const end = dayRange(toKey, timeZone).end.getTime();
  const inPeriod = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= start && t < end;
  };
  const liveActs = input.activities.filter(live);
  const history = byDeal(liveActs);
  const measuredSince = liveActs.length ? liveActs.reduce((min, a) => (a.recordedAt < min ? a.recordedAt : min), liveActs[0].recordedAt) : null;

  const activity = Object.fromEntries(EVIDENCE_KINDS.map((k) => [k, 0])) as Record<EvidenceKind, number>;
  for (const a of liveActs) if (!isStageKind(a.kind) && inPeriod(a.occurredAt)) activity[a.kind as EvidenceKind] += 1;

  const reached = (list: DealActivity[], after: string, kind: EvidenceKind, stage: DealStage) =>
    list.some((a) => a.occurredAt >= after && (a.kind === kind || (a.toStage != null && a.toStage !== "lost" && stageRank(a.toStage) >= stageRank(stage))));
  const cohort = { outreached: 0, replied: 0, meetingHeld: 0, proposalSent: 0, won: 0 };
  for (const [, list] of history) {
    const first = list.find((a) => a.kind === "outreach" || (a.toStage === "outreach" && a.kind === "stage_change"));
    if (!first || !inPeriod(first.occurredAt)) continue;
    cohort.outreached += 1;
    if (reached(list, first.occurredAt, "reply_received", "replied")) cohort.replied += 1;
    if (reached(list, first.occurredAt, "meeting_held", "meeting_held")) cohort.meetingHeld += 1;
    if (reached(list, first.occurredAt, "proposal_sent", "proposal_sent")) cohort.proposalSent += 1;
    if (list.some((a) => a.kind === "won" && a.occurredAt >= first.occurredAt)) cohort.won += 1;
  }

  const won = { count: 0, setup: {} as CurrencyTotals, monthly: {} as CurrencyTotals };
  for (const d of deals) {
    if (d.stage !== "won" || !d.wonOn || d.wonOn < fromKey || d.wonOn > toKey) continue;
    won.count += 1;
    addToTotals(won.setup, d.currency, d.wonSetupFee ?? 0);
    addToTotals(won.monthly, d.currency, d.wonMonthlyFee ?? 0);
  }

  const lost: SalesMetrics["lost"] = { count: 0, fromStage: {}, reasons: [] };
  const reasons = new Map<string, number>();
  for (const d of deals) {
    if (d.stage !== "lost" || !d.lostOn || d.lostOn < fromKey || d.lostOn > toKey) continue;
    lost.count += 1;
    const lostEntry = [...(history.get(d.id) ?? [])].reverse().find((a) => a.kind === "lost");
    const key = lostEntry?.fromStage ?? "not_recorded";
    lost.fromStage[key] = (lost.fromStage[key] ?? 0) + 1;
    const reason = (d.lostReason ?? "").trim() || "No reason";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  lost.reasons = [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return { fromKey, toKey, measuredSince, activity, cohort, won, lost };
}

/** "3 of 8" - the honest form of a conversion rate on small numbers. */
export function ofLabel(part: number, whole: number): string {
  return whole ? `${part} of ${whole}` : "—";
}
