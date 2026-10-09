import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealStage, FounderDeal, FounderItem, FounderReview, ItemKind, MrrEntry, MrrKind, Priority } from "./model";

/**
 * Founder Command Center reads. Every query filters on owner_id explicitly
 * in addition to RLS (which already limits a founder to their own rows), and
 * returns { ok: false } on any error so a page shows an error state - never
 * an empty list that looks like "nothing to do".
 */

export type Loaded<T> = { ok: true; data: T } | { ok: false };

type ItemRow = { id: string; kind: ItemKind; title: string; notes: string | null; priority: Priority; due_at: string | null; starts_at: string | null; ends_at: string | null; completed_at: string | null; deal_id: string | null; created_at: string };
type DealRow = { id: string; name: string; contact_name: string | null; contact_email: string | null; stage: DealStage; expected_mrr: number | string | null; next_action: string | null; next_action_at: string | null; won_amount: number | string | null; won_on: string | null; lost_reason: string | null; notes: string | null; created_at: string; updated_at: string };
type MrrRow = { id: string; month: string; kind: MrrKind; amount: number | string; is_forecast: boolean; customer: string | null; description: string | null; created_at: string };
type ReviewRow = { id: string; review_date: string; wins: string | null; blockers: string | null; priorities_next: string | null; notes: string | null; updated_at: string };

const num = (value: number | string | null): number | null => (value == null ? null : Number(value));

export const toItem = (r: ItemRow): FounderItem => ({ id: r.id, kind: r.kind, title: r.title, notes: r.notes, priority: r.priority, dueAt: r.due_at, startsAt: r.starts_at, endsAt: r.ends_at, completedAt: r.completed_at, dealId: r.deal_id, createdAt: r.created_at });
export const toDeal = (r: DealRow): FounderDeal => ({ id: r.id, name: r.name, contactName: r.contact_name, contactEmail: r.contact_email, stage: r.stage, expectedMrr: num(r.expected_mrr), nextAction: r.next_action, nextActionAt: r.next_action_at, wonAmount: num(r.won_amount), wonOn: r.won_on, lostReason: r.lost_reason, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at });
export const toMrr = (r: MrrRow): MrrEntry => ({ id: r.id, month: r.month, kind: r.kind, amount: Number(r.amount), isForecast: r.is_forecast, customer: r.customer, description: r.description, createdAt: r.created_at });
export const toReview = (r: ReviewRow): FounderReview => ({ id: r.id, reviewDate: r.review_date, wins: r.wins, blockers: r.blockers, prioritiesNext: r.priorities_next, notes: r.notes, updatedAt: r.updated_at });

const ITEM_COLUMNS = "id, kind, title, notes, priority, due_at, starts_at, ends_at, completed_at, deal_id, created_at";
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
