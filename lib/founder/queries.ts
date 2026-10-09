import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealStage, FounderDeal, FounderItem, FounderReview, ItemKind, MrrEntry, MrrKind, Priority } from "./model";

/**
 * Founder Command Center reads. Every query filters on owner_id explicitly
 * in addition to RLS (which already limits a founder to their own rows), and
 * returns { ok: false } on any error so a page shows an error state - never
 * an empty list that looks like "nothing to do".
 */

export type Loaded<T> = { ok: true; data: T } | { ok: false };

type ItemRow = { id: string; kind: ItemKind; title: string; notes: string | null; priority: Priority; due_at: string | null; starts_at: string | null; ends_at: string | null; completed_at: string | null; deal_id: string | null; created_at: string; updated_at: string };
type DealRow = { id: string; name: string; contact_name: string | null; contact_email: string | null; stage: DealStage; expected_mrr: number | string | null; next_action: string | null; next_action_at: string | null; won_amount: number | string | null; won_on: string | null; lost_reason: string | null; notes: string | null; created_at: string; updated_at: string };
type MrrRow = { id: string; month: string; kind: MrrKind; amount: number | string; is_forecast: boolean; customer: string | null; description: string | null; created_at: string };
type ReviewRow = { id: string; review_date: string; wins: string | null; blockers: string | null; priorities_next: string | null; notes: string | null; updated_at: string };

const num = (value: number | string | null): number | null => (value == null ? null : Number(value));

export const toItem = (r: ItemRow): FounderItem => ({ id: r.id, kind: r.kind, title: r.title, notes: r.notes, priority: r.priority, dueAt: r.due_at, startsAt: r.starts_at, endsAt: r.ends_at, completedAt: r.completed_at, dealId: r.deal_id, createdAt: r.created_at, updatedAt: r.updated_at });
export const toDeal = (r: DealRow): FounderDeal => ({ id: r.id, name: r.name, contactName: r.contact_name, contactEmail: r.contact_email, stage: r.stage, expectedMrr: num(r.expected_mrr), nextAction: r.next_action, nextActionAt: r.next_action_at, wonAmount: num(r.won_amount), wonOn: r.won_on, lostReason: r.lost_reason, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at });
export const toMrr = (r: MrrRow): MrrEntry => ({ id: r.id, month: r.month, kind: r.kind, amount: Number(r.amount), isForecast: r.is_forecast, customer: r.customer, description: r.description, createdAt: r.created_at });
export const toReview = (r: ReviewRow): FounderReview => ({ id: r.id, reviewDate: r.review_date, wins: r.wins, blockers: r.blockers, prioritiesNext: r.priorities_next, notes: r.notes, updatedAt: r.updated_at });

const ITEM_COLUMNS = "id, kind, title, notes, priority, due_at, starts_at, ends_at, completed_at, deal_id, created_at, updated_at";
const DEAL_COLUMNS = "id, name, contact_name, contact_email, stage, expected_mrr, next_action, next_action_at, won_amount, won_on, lost_reason, notes, created_at, updated_at";
const MRR_COLUMNS = "id, month, kind, amount, is_forecast, customer, description, created_at";
const REVIEW_COLUMNS = "id, review_date, wins, blockers, priorities_next, notes, updated_at";

/** Open items plus items completed since `completedSince` (bounded, for the Completed view and the daily review). */
export async function getFounderItems(supabase: SupabaseClient, ownerId: string, completedSince: string): Promise<Loaded<FounderItem[]>> {
  const [open, done] = await Promise.all([
    supabase.from("founder_items").select(ITEM_COLUMNS).eq("owner_id", ownerId).is("completed_at", null).order("created_at", { ascending: true }).limit(1000),
    supabase.from("founder_items").select(ITEM_COLUMNS).eq("owner_id", ownerId).gte("completed_at", completedSince).order("completed_at", { ascending: false }).limit(500),
  ]);
  if (open.error || done.error) return { ok: false };
  return { ok: true, data: [...(open.data as ItemRow[]), ...(done.data as ItemRow[])].map(toItem) };
}

export async function getFounderDeals(supabase: SupabaseClient, ownerId: string): Promise<Loaded<FounderDeal[]>> {
  const { data, error } = await supabase.from("founder_deals").select(DEAL_COLUMNS).eq("owner_id", ownerId).order("updated_at", { ascending: false }).limit(2000);
  if (error) return { ok: false };
  return { ok: true, data: (data as DealRow[]).map(toDeal) };
}

export async function getFounderMrrEntries(supabase: SupabaseClient, ownerId: string): Promise<Loaded<MrrEntry[]>> {
  const { data, error } = await supabase.from("founder_mrr_entries").select(MRR_COLUMNS).eq("owner_id", ownerId).order("month", { ascending: false }).order("created_at", { ascending: false }).limit(5000);
  if (error) return { ok: false };
  return { ok: true, data: (data as MrrRow[]).map(toMrr) };
}

export async function getFounderReviews(supabase: SupabaseClient, ownerId: string, limit = 30): Promise<Loaded<FounderReview[]>> {
  const { data, error } = await supabase.from("founder_reviews").select(REVIEW_COLUMNS).eq("owner_id", ownerId).order("review_date", { ascending: false }).limit(limit);
  if (error) return { ok: false };
  return { ok: true, data: (data as ReviewRow[]).map(toReview) };
}

/** The longest event span the calendar looks back for: an event that started up to this long before the range can still overlap it. */
export const CALENDAR_SPAN_LOOKBACK_DAYS = 31;

export type CalendarItems = {
  /** Every item (open or done) dated inside [start, end): events/meetings overlapping it, tasks due in it. */
  inRange: FounderItem[];
  /** Open tasks, follow-ups and deadlines with no due date - never hidden from the calendar. */
  unscheduled: FounderItem[];
};

/**
 * The calendar's read for one visible range. Three owner-scoped queries:
 * events and meetings that start before the range ends (and no earlier than
 * the span lookback, filtered to those that actually overlap), items due
 * inside the range, and open undated items. Any error fails the whole read
 * so the page shows an error state, never a misleadingly empty calendar.
 */
export async function getFounderCalendarItems(supabase: SupabaseClient, ownerId: string, start: Date, end: Date): Promise<Loaded<CalendarItems>> {
  const lookback = new Date(start.getTime() - CALENDAR_SPAN_LOOKBACK_DAYS * 86_400_000).toISOString();
  const [scheduled, due, undated] = await Promise.all([
    supabase.from("founder_items").select(ITEM_COLUMNS).eq("owner_id", ownerId).gte("starts_at", lookback).lt("starts_at", end.toISOString()).order("starts_at", { ascending: true }).limit(2000),
    supabase.from("founder_items").select(ITEM_COLUMNS).eq("owner_id", ownerId).gte("due_at", start.toISOString()).lt("due_at", end.toISOString()).order("due_at", { ascending: true }).limit(2000),
    supabase.from("founder_items").select(ITEM_COLUMNS).eq("owner_id", ownerId).is("completed_at", null).is("due_at", null).is("starts_at", null).order("created_at", { ascending: true }).limit(500),
  ]);
  if (scheduled.error || due.error || undated.error) return { ok: false };
  const startIso = start.toISOString();
  const overlapping = (scheduled.data as ItemRow[]).filter((row) => {
    const until = row.ends_at ?? row.starts_at;
    // An event with no end is a point in time: it overlaps if it starts in the range.
    return until != null && (row.ends_at ? until > startIso : until >= startIso);
  });
  const seen = new Set<string>();
  const inRange = [...overlapping, ...(due.data as ItemRow[])].filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true))).map(toItem);
  return { ok: true, data: { inRange, unscheduled: (undated.data as ItemRow[]).map(toItem) } };
}

/** One item marked as a daily priority (supabase/pending/founder_daily_focus.sql). */
export type DailyFocus = { itemId: string; date: string; rank: number };

/** True for Postgres "undefined column" - the daily-focus migration isn't applied yet. */
export function isMissingFocusColumn(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (error.code === "42703" || /focus_(date|rank)/.test(error.message ?? "")));
}

/**
 * Daily priorities for local days [fromKey, toKey], owner-scoped. Read
 * separately from the items so a database without the focus columns still
 * loads every founder page: `available: false` means "not enabled yet",
 * while any other error is a load failure.
 */
export async function getFounderFocus(supabase: SupabaseClient, ownerId: string, fromKey: string, toKey: string): Promise<Loaded<{ available: boolean; focus: DailyFocus[] }>> {
  const { data, error } = await supabase
    .from("founder_items")
    .select("id, focus_date, focus_rank")
    .eq("owner_id", ownerId)
    .gte("focus_date", fromKey)
    .lte("focus_date", toKey)
    .order("focus_date", { ascending: true })
    .order("focus_rank", { ascending: true });
  if (error) return isMissingFocusColumn(error) ? { ok: true, data: { available: false, focus: [] } } : { ok: false };
  return { ok: true, data: { available: true, focus: (data as { id: string; focus_date: string; focus_rank: number }[]).map((r) => ({ itemId: r.id, date: r.focus_date, rank: Number(r.focus_rank) })) } };
}
