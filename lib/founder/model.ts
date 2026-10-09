/**
 * Founder Command Center - the pure model: vocabularies, input parsing,
 * time-zone-aware day boundaries, the MRR arithmetic and pipeline summaries.
 * No I/O here (queries.ts reads, app/founder/actions.ts writes), so every
 * rule is unit-tested directly (model.test.ts).
 *
 * Nothing here is contractor/organization data. MRR figures are the
 * founder's own manual entries; forecasts are kept apart from actuals and
 * every figure is labelled as manual where it is shown.
 */

export const DEAL_STAGES = ["lead", "contacted", "meeting_booked", "demo_proposal", "negotiation", "won", "lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  lead: "Lead",
  contacted: "Contacted",
  meeting_booked: "Meeting booked",
  demo_proposal: "Demo / proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};
export const OPEN_DEAL_STAGES: DealStage[] = ["lead", "contacted", "meeting_booked", "demo_proposal", "negotiation"];

export const ITEM_KINDS = ["task", "follow_up", "deadline", "event", "meeting"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_KIND_LABELS: Record<ItemKind, string> = { task: "Task", follow_up: "Follow-up", deadline: "Deadline", event: "Event", meeting: "Meeting" };
export const SCHEDULED_KINDS: ItemKind[] = ["event", "meeting"];

export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { high: "High", medium: "Medium", low: "Low" };

export const MRR_KINDS = ["starting", "new", "expansion", "contraction", "churn", "one_time"] as const;
export type MrrKind = (typeof MRR_KINDS)[number];
export const MRR_KIND_LABELS: Record<MrrKind, string> = {
  starting: "Starting MRR",
  new: "New MRR",
  expansion: "Expansion",
  contraction: "Contraction",
  churn: "Churned",
  one_time: "One-time revenue",
};

export type FounderItem = {
  id: string;
  kind: ItemKind;
  title: string;
  notes: string | null;
  priority: Priority;
  dueAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  completedAt: string | null;
  dealId: string | null;
  createdAt: string;
  /** For optimistic concurrency: an edit is saved only if the item hasn't changed since it was loaded. */
  updatedAt: string;
};

export type FounderDeal = {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  stage: DealStage;
  expectedMrr: number | null;
  nextAction: string | null;
  nextActionAt: string | null;
  wonAmount: number | null;
  wonOn: string | null;
  lostReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MrrEntry = {
  id: string;
  /** YYYY-MM-01 */
  month: string;
  kind: MrrKind;
  amount: number;
  isForecast: boolean;
  customer: string | null;
  description: string | null;
  createdAt: string;
};

export type FounderReview = {
  id: string;
  reviewDate: string;
  wins: string | null;
  blockers: string | null;
  prioritiesNext: string | null;
  notes: string | null;
  updatedAt: string;
};

// --- time ---------------------------------------------------------------------

export const DEFAULT_TIMEZONE = "America/Denver";

function zoneParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset of `timeZone` from UTC at `date`, in ms. */
function zoneOffset(date: Date, timeZone: string): number {
  const p = zoneParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** A wall-clock time in `timeZone` as a real instant (DST-correct). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffset(new Date(guess), timeZone);
  const second = guess - zoneOffset(new Date(first), timeZone);
  return new Date(second);
}

/** YYYY-MM-DD of `date` in `timeZone`. */
export function localDateKey(date: Date, timeZone: string): string {
  const p = zoneParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The instant range [start, end) of the local calendar day `key` (YYYY-MM-DD). */
export function dayRange(key: string, timeZone: string): { start: Date; end: Date } {
  const [y, m, d] = key.split("-").map(Number);
  const start = zonedTimeToUtc(y, m, d, 0, 0, timeZone);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const end = zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone);
  return { start, end };
}

export function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/** YYYY-MM-01 of the month containing local day `key`. */
export function monthKeyOf(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

export function addMonthsKey(monthKey: string, months: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1 + months, 1));
  return next.toISOString().slice(0, 10);
}

/** "YYYY-MM-DDTHH:mm" (an <input type="datetime-local">) in the founder's zone -> ISO instant. */
export function parseLocalDateTime(raw: unknown, timeZone: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, value: null };
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  if (!match) return { ok: false, error: "Enter a valid date and time." };
  const [, y, mo, d, h, mi] = match;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, error: "Enter a valid date and time." };
  // A date with no time is a whole-day item: due by the end of that day.
  const instant = h === undefined ? new Date(dayRange(`${y}-${mo}-${d}`, timeZone).end.getTime() - 60_000) : zonedTimeToUtc(Number(y), month, day, Number(h), Number(mi), timeZone);
  if (Number.isNaN(instant.getTime()) || localDateKey(instant, timeZone).slice(0, 7) !== `${y}-${mo}`) return { ok: false, error: "Enter a valid date and time." };
  return { ok: true, value: instant.toISOString() };
}

/** ISO instant -> "YYYY-MM-DDTHH:mm" in the founder's zone (for editing). */
export function toLocalInputValue(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const p = zoneParts(new Date(iso), timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// --- parsing --------------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function text(raw: unknown, max: number, label: string, required = false): Parsed<string | null> {
  const value = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (required && !value) return { ok: false, error: `Enter ${label}.` };
  if (value.length > max) return { ok: false, error: `Keep ${label} under ${max} characters.` };
  return { ok: true, value: value || null };
}

function money(raw: unknown, label: string, required = false): Parsed<number | null> {
  const cleaned = String(raw ?? "").trim().replace(/[$,\s]/g, "");
  if (!cleaned) return required ? { ok: false, error: `Enter ${label}.` } : { ok: true, value: null };
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0 || value > 9_999_999_999.99) return { ok: false, error: `Enter ${label} as an amount of zero or more.` };
  if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) return { ok: false, error: `Use at most two decimal places for ${label}.` };
  return { ok: true, value: Math.round(value * 100) / 100 };
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T | null, label: string): Parsed<T> {
  const value = String(raw ?? "").trim();
  if (!value && fallback) return { ok: true, value: fallback };
  return (allowed as readonly string[]).includes(value) ? { ok: true, value: value as T } : { ok: false, error: `Choose a valid ${label}.` };
}

export type ItemInput = {
  kind: ItemKind;
  title: string;
  notes: string | null;
  priority: Priority;
  dueAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  dealId: string | null;
  /** null when the form had no completion field (create, or an older client) - completion is left as it is. */
  completed: boolean | null;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const truthy = (value: unknown) => value === true || value === "true" || value === "on";

/** A valid calendar date (YYYY-MM-DD) - no rollover (2026-02-31 is invalid). */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Validates a task, follow-up, deadline, event or meeting.
 *   - Tasks, follow-ups and deadlines have an optional due date/time and no
 *     start or end (a date with no time = due by the end of that day).
 *   - Events and meetings need a start; the end is optional and must be
 *     after the start. `allDay` events take dates (YYYY-MM-DD, end
 *     inclusive) and are stored as local midnight to the following local
 *     midnight, which is how the calendar recognizes them as all-day.
 */
export function parseItemInput(raw: Record<string, unknown>, timeZone: string): Parsed<ItemInput> {
  const kind = oneOf(raw.kind, ITEM_KINDS, "task", "type");
  if (!kind.ok) return kind;
  const title = text(raw.title, 300, "a title", true);
  if (!title.ok) return title;
  const notes = text(raw.notes, 5000, "the notes");
  if (!notes.ok) return notes;
  const priority = oneOf(raw.priority, PRIORITIES, "medium", "priority");
  if (!priority.ok) return priority;
  const scheduled = SCHEDULED_KINDS.includes(kind.value);

  let dueAt: string | null = null;
  let startsAt: string | null = null;
  let endsAt: string | null = null;
  if (scheduled && truthy(raw.allDay)) {
    const startDate = String(raw.startDate ?? "").trim();
    if (!isDateKey(startDate)) return { ok: false, error: "Choose the day of this event." };
    const endText = String(raw.endDate ?? "").trim();
    const endDate = endText || startDate;
    if (!isDateKey(endDate)) return { ok: false, error: "Choose a valid end day." };
    if (endDate < startDate) return { ok: false, error: "The end day can't be before the start day." };
    startsAt = dayRange(startDate, timeZone).start.toISOString();
    endsAt = dayRange(endDate, timeZone).end.toISOString();
  } else if (scheduled) {
    const start = parseLocalDateTime(raw.startsAt, timeZone);
    if (!start.ok) return start;
    if (!start.value) return { ok: false, error: "Add a start time for an event or meeting." };
    const end = parseLocalDateTime(raw.endsAt, timeZone);
    if (!end.ok) return end;
    if (end.value && end.value <= start.value) return { ok: false, error: "The end must be after the start." };
    startsAt = start.value;
    endsAt = end.value;
  } else {
    // The dialog sends a due date plus an optional time; older callers send dueAt.
    let dueRaw: unknown = raw.dueAt;
    if (raw.dueDate !== undefined) {
      const dueDate = String(raw.dueDate ?? "").trim();
      const dueTime = String(raw.dueTime ?? "").trim();
      if (dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) return { ok: false, error: "Enter a valid due time." };
      if (dueTime && !dueDate) return { ok: false, error: "Choose a due date for that time." };
      dueRaw = dueDate ? (dueTime ? `${dueDate}T${dueTime}` : dueDate) : "";
    }
    const due = parseLocalDateTime(dueRaw, timeZone);
    if (!due.ok) return due;
    dueAt = due.value;
  }

  const dealId = String(raw.dealId ?? "").trim();
  return {
    ok: true,
    value: {
      kind: kind.value,
      title: title.value as string,
      notes: notes.value,
      priority: priority.value,
      dueAt,
      startsAt,
      endsAt,
      dealId: dealId || null,
      completed: "completed" in raw ? truthy(raw.completed) : null,
    },
  };
}

export type DealInput = {
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  stage: DealStage;
  expectedMrr: number | null;
  nextAction: string | null;
  nextActionAt: string | null;
  wonAmount: number | null;
  wonOn: string | null;
  lostReason: string | null;
  notes: string | null;
};

export function parseDealInput(raw: Record<string, unknown>, timeZone: string): Parsed<DealInput> {
  const name = text(raw.name, 200, "the company or deal name", true);
  if (!name.ok) return name;
  const contactName = text(raw.contactName, 200, "the contact name");
  if (!contactName.ok) return contactName;
  const contactEmail = text(raw.contactEmail, 320, "the email");
  if (!contactEmail.ok) return contactEmail;
  if (contactEmail.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.value)) return { ok: false, error: "Enter a valid email." };
  const stage = oneOf(raw.stage, DEAL_STAGES, "lead", "stage");
  if (!stage.ok) return stage;
  const expectedMrr = money(raw.expectedMrr, "the expected MRR");
  if (!expectedMrr.ok) return expectedMrr;
  const nextAction = text(raw.nextAction, 500, "the next action");
  if (!nextAction.ok) return nextAction;
  const nextActionAt = parseLocalDateTime(raw.nextActionAt, timeZone);
  if (!nextActionAt.ok) return nextActionAt;
  const lostReason = text(raw.lostReason, 500, "the reason");
  if (!lostReason.ok) return lostReason;
  const notes = text(raw.notes, 5000, "the notes");
  if (!notes.ok) return notes;

  let wonAmount: number | null = null;
  let wonOn: string | null = null;
  if (stage.value === "won") {
    const amount = money(raw.wonAmount, "the won amount", true);
    if (!amount.ok) return amount;
    const date = String(raw.wonOn ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { ok: false, error: "Enter the date the deal was won." };
    wonAmount = amount.value;
    wonOn = date;
  }
  return {
    ok: true,
    value: {
      name: name.value as string,
      contactName: contactName.value,
      contactEmail: contactEmail.value,
      stage: stage.value,
      expectedMrr: expectedMrr.value,
      nextAction: nextAction.value,
      nextActionAt: nextActionAt.value,
      wonAmount,
      wonOn,
      lostReason: stage.value === "lost" ? lostReason.value : null,
      notes: notes.value,
    },
  };
}

export type MrrInput = { month: string; kind: MrrKind; amount: number; isForecast: boolean; customer: string | null; description: string | null };

export function parseMrrInput(raw: Record<string, unknown>): Parsed<MrrInput> {
  const monthText = String(raw.month ?? "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthText)) return { ok: false, error: "Choose a month." };
  const kind = oneOf(raw.kind, MRR_KINDS, null, "type");
  if (!kind.ok) return kind;
  const amount = money(raw.amount, "the amount", true);
  if (!amount.ok) return amount;
  const customer = text(raw.customer, 200, "the customer");
  if (!customer.ok) return customer;
  const description = text(raw.description, 500, "the description");
  if (!description.ok) return description;
  const forecast = raw.isForecast === true || raw.isForecast === "true" || raw.isForecast === "on";
  return { ok: true, value: { month: `${monthText}-01`, kind: kind.value, amount: amount.value as number, isForecast: forecast, customer: customer.value, description: description.value } };
}

export type ReviewInput = { reviewDate: string; wins: string | null; blockers: string | null; prioritiesNext: string | null; notes: string | null };

export function parseReviewInput(raw: Record<string, unknown>): Parsed<ReviewInput> {
  const reviewDate = String(raw.reviewDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate) || Number.isNaN(Date.parse(`${reviewDate}T00:00:00Z`))) return { ok: false, error: "Choose the day you're reviewing." };
  const fields = {} as Record<"wins" | "blockers" | "prioritiesNext" | "notes", string | null>;
  for (const [key, label] of [["wins", "wins"], ["blockers", "blockers"], ["prioritiesNext", "tomorrow's priorities"], ["notes", "the notes"]] as const) {
    const parsed = text(raw[key], 5000, label);
    if (!parsed.ok) return parsed;
    fields[key] = parsed.value;
  }
  if (!fields.wins && !fields.blockers && !fields.prioritiesNext && !fields.notes) return { ok: false, error: "Write at least one part of the review." };
  return { ok: true, value: { reviewDate, ...fields } };
}

// --- tasks and events -------------------------------------------------------------

/** The instant an item is "for": its start for an event/meeting, otherwise its due time. */
export function itemTime(item: Pick<FounderItem, "kind" | "dueAt" | "startsAt">): string | null {
  return SCHEDULED_KINDS.includes(item.kind) ? item.startsAt : item.dueAt;
}

/** Open, not an event, and due before now. An event that has passed is simply past, not overdue. */
export function isOverdue(item: Pick<FounderItem, "kind" | "dueAt" | "completedAt">, now: Date): boolean {
  return item.completedAt == null && !SCHEDULED_KINDS.includes(item.kind) && item.dueAt != null && new Date(item.dueAt).getTime() < now.getTime();
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function sortByTimeThenPriority<T extends Pick<FounderItem, "kind" | "dueAt" | "startsAt" | "priority" | "createdAt">>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ta = itemTime(a);
    const tb = itemTime(b);
    if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
    if (ta && !tb) return -1;
    if (!ta && tb) return 1;
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.createdAt < b.createdAt ? -1 : 1);
  });
}

export type ItemView = "today" | "upcoming" | "overdue" | "open" | "done";
export const ITEM_VIEWS: { id: ItemView; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "overdue", label: "Overdue" },
  { id: "open", label: "All open" },
  { id: "done", label: "Completed" },
];

/**
 * Which items a view shows, given the founder's local day [start, end):
 *   today    - open items due or starting today, plus overdue ones (they're today's problem)
 *   upcoming - open items after today, within 14 days
 *   overdue  - open, non-event items due before now
 *   open     - every open item (including undated quick captures)
 *   done     - completed items, most recent first
 */
export function filterItems(items: FounderItem[], view: ItemView, now: Date, today: { start: Date; end: Date }): FounderItem[] {
  const open = items.filter((item) => item.completedAt == null);
  const inRange = (item: FounderItem, from: Date, to: Date) => {
    const t = itemTime(item);
    return t != null && new Date(t) >= from && new Date(t) < to;
  };
  switch (view) {
    case "today":
      return sortByTimeThenPriority(open.filter((item) => inRange(item, today.start, today.end) || isOverdue(item, now)));
    case "upcoming":
      return sortByTimeThenPriority(open.filter((item) => inRange(item, today.end, new Date(today.end.getTime() + 14 * 86_400_000))));
    case "overdue":
      return sortByTimeThenPriority(open.filter((item) => isOverdue(item, now)));
    case "open":
      return sortByTimeThenPriority(open);
    case "done":
      return items.filter((item) => item.completedAt != null).sort((a, b) => ((a.completedAt as string) < (b.completedAt as string) ? 1 : -1));
  }
}

// --- deals ----------------------------------------------------------------------

export function isOpenDeal(deal: Pick<FounderDeal, "stage">): boolean {
  return OPEN_DEAL_STAGES.includes(deal.stage);
}

/** Open deals whose next action is due by the end of today (or already past). */
export function dealsNeedingFollowUp(deals: FounderDeal[], todayEnd: Date): FounderDeal[] {
  return deals
    .filter((deal) => isOpenDeal(deal) && deal.nextActionAt != null && new Date(deal.nextActionAt) < todayEnd)
    .sort((a, b) => ((a.nextActionAt as string) < (b.nextActionAt as string) ? -1 : 1));
}

export function pipelineSummary(deals: FounderDeal[], monthKey: string) {
  const open = deals.filter(isOpenDeal);
  const wonThisMonth = deals.filter((deal) => deal.stage === "won" && deal.wonOn != null && deal.wonOn.slice(0, 7) === monthKey.slice(0, 7));
  const expected = open.filter((deal) => deal.expectedMrr != null);
  return {
    openCount: open.length,
    /** Sum of expected MRR across open deals that have one - null when none do. */
    openExpectedMrr: expected.length ? centsSum(expected.map((deal) => deal.expectedMrr as number)) : null,
    openWithoutValue: open.length - expected.length,
    wonThisMonthCount: wonThisMonth.length,
    wonThisMonthAmount: centsSum(wonThisMonth.map((deal) => deal.wonAmount ?? 0)),
    byStage: Object.fromEntries(DEAL_STAGES.map((stage) => [stage, deals.filter((deal) => deal.stage === stage).length])) as Record<DealStage, number>,
  };
}

export function filterDeals(deals: FounderDeal[], query: string, stage: DealStage | "open" | "all"): FounderDeal[] {
  const term = query.trim().toLowerCase();
  return deals.filter((deal) => {
    if (stage === "open" && !isOpenDeal(deal)) return false;
    if (stage !== "open" && stage !== "all" && deal.stage !== stage) return false;
    if (!term) return true;
    return [deal.name, deal.contactName, deal.contactEmail, deal.nextAction, deal.notes].some((value) => value?.toLowerCase().includes(term));
  });
}

// --- MRR -------------------------------------------------------------------------

function centsSum(values: number[]): number {
  return values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
}

/** The change an entry makes to MRR (one-time revenue is not recurring: 0). */
export function mrrDelta(entry: Pick<MrrEntry, "kind" | "amount">): number {
  switch (entry.kind) {
    case "starting":
    case "new":
    case "expansion":
      return entry.amount;
    case "contraction":
    case "churn":
      return -entry.amount;
    case "one_time":
      return 0;
  }
}

export type MrrMonth = {
  month: string;
  starting: number;
  new: number;
  expansion: number;
  contraction: number;
  churn: number;
  oneTime: number;
  /** new + expansion - contraction - churn (starting balances are not "net new"). */
  netNew: number;
  /** Running MRR at the end of the month from actual entries only. */
  mrr: number;
  /** Forecast entries in this month, as a net change (null when there are none). */
  forecastNet: number | null;
  /** Running MRR including forecasts (null when no forecast affects it). */
  forecastMrr: number | null;
  hasActuals: boolean;
};

function monthBucket(entries: MrrEntry[], month: string) {
  const sum = (kind: MrrKind) => centsSum(entries.filter((entry) => entry.month === month && entry.kind === kind).map((entry) => entry.amount));
  return { starting: sum("starting"), new: sum("new"), expansion: sum("expansion"), contraction: sum("contraction"), churn: sum("churn"), oneTime: sum("one_time") };
}

/**
 * Month-by-month MRR from `fromMonth` to `toMonth` (inclusive, YYYY-MM-01).
 * Actuals and forecasts are computed separately: `mrr` uses actual entries
 * only; `forecastMrr` adds forecast entries on top, and is null for months
 * no forecast reaches. Entries before `fromMonth` still count toward the
 * running balance.
 */
export function mrrHistory(entries: MrrEntry[], fromMonth: string, toMonth: string): MrrMonth[] {
  const actuals = entries.filter((entry) => !entry.isForecast);
  const forecasts = entries.filter((entry) => entry.isForecast);
  const before = (list: MrrEntry[], month: string) => centsSum(list.filter((entry) => entry.month < month).map(mrrDelta));
  let mrr = before(actuals, fromMonth);
  let forecastRunning = before(forecasts, fromMonth);
  let forecastSeen = forecasts.some((entry) => entry.month < fromMonth);
  const months: MrrMonth[] = [];
  for (let month = fromMonth; month <= toMonth; month = addMonthsKey(month, 1)) {
    const a = monthBucket(actuals, month);
    const monthForecasts = forecasts.filter((entry) => entry.month === month);
    mrr = centsSum([mrr, a.starting, a.new, a.expansion, -a.contraction, -a.churn]);
    const forecastNet = monthForecasts.length ? centsSum(monthForecasts.map(mrrDelta)) : null;
    if (monthForecasts.length) forecastSeen = true;
    forecastRunning = centsSum([forecastRunning, forecastNet ?? 0]);
    months.push({
      month,
      ...a,
      netNew: centsSum([a.new, a.expansion, -a.contraction, -a.churn]),
      mrr,
      forecastNet,
      forecastMrr: forecastSeen ? centsSum([mrr, forecastRunning]) : null,
      hasActuals: actuals.some((entry) => entry.month === month),
    });
  }
  return months;
}

/** The headline figures for `currentMonth` (actuals only), or null when nothing has been entered. */
export function mrrSnapshot(entries: MrrEntry[], currentMonth: string) {
  const actuals = entries.filter((entry) => !entry.isForecast);
  if (actuals.length === 0) return null;
  const [month] = mrrHistory(entries, currentMonth, currentMonth);
  const previous = mrrHistory(entries, addMonthsKey(currentMonth, -1), addMonthsKey(currentMonth, -1))[0];
  return { ...month, previousMrr: previous.mrr };
}

/**
 * Deals as the item dialog offers them: every deal, with won/lost marked
 * closed. The dialog lists open deals plus whatever deal the item is already
 * linked to, so editing an item linked to a closed deal never unlinks it.
 */
export function toDealOptions(deals: Pick<FounderDeal, "id" | "name" | "stage">[]): { id: string; name: string; closed: boolean }[] {
  return deals.map((deal) => ({ id: deal.id, name: deal.name, closed: !isOpenDeal(deal) }));
}
