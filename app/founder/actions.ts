"use server";

import { revalidatePath } from "next/cache";
import { getFounderContext, type FounderContext } from "@/lib/founder/access";
import { SCHEDULED_KINDS, addDaysKey, dayRange, isDateKey, localDateKey, parseDealInput, parseItemInput, parseLocalDateTime, parseMrrInput, parseReviewInput, toLocalInputValue, type DealInput, type DealStage } from "@/lib/founder/model";
import { parseActivityInput, parseStageChange } from "@/lib/founder/sales";
import { handoffMissing, parseScope } from "@/lib/founder/handoff";
import { isAllDayEvent, isEndOfDayDue } from "@/lib/founder/calendar";
import { MAX_DAILY_PRIORITIES } from "@/lib/founder/daily";
import { isMissingFocusColumn, toItem } from "@/lib/founder/queries";

/**
 * Founder Command Center writes. Each action re-resolves founder access
 * (never trusting that the page rendered for a founder), scopes every write
 * to the caller's own owner_id, and RLS enforces the same again. A missing
 * migration or a non-founder caller gets the same refusal.
 */

export type FounderActionResult = { ok: true; id?: string } | { ok: false; error: string };
type Fields = Record<string, unknown>;

const NOT_AVAILABLE: { ok: false; error: string } = { ok: false, error: "The Founder Command Center isn't available for this account." };

async function founder(): Promise<FounderContext | null> {
  return getFounderContext();
}

function refresh() {
  revalidatePath("/founder", "layout");
}

async function dealBelongsToFounder(ctx: FounderContext, dealId: string | null): Promise<boolean> {
  if (!dealId) return true;
  const { data } = await ctx.supabase.from("founder_deals").select("id").eq("id", dealId).eq("owner_id", ctx.userId).maybeSingle();
  return Boolean(data);
}

// --- tasks and events --------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Creates an item. A form may send `clientId` (a UUID generated when the
 * dialog opened): it becomes the row's id, so a double-submit or a retry
 * after a dropped response finds the same row instead of creating a
 * duplicate.
 */
export async function createFounderItem(fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const parsed = parseItemInput(fields, ctx.timeZone);
  if (!parsed.ok) return parsed;
  if (!(await dealBelongsToFounder(ctx, parsed.value.dealId))) return { ok: false, error: "That deal could not be found." };
  const clientId = typeof fields.clientId === "string" && UUID.test(fields.clientId) ? fields.clientId.toLowerCase() : null;
  if (clientId) {
    const { data: existing } = await ctx.supabase.from("founder_items").select("id").eq("id", clientId).eq("owner_id", ctx.userId).maybeSingle();
    if (existing) return { ok: true, id: existing.id };
  }
  const v = parsed.value;
  const { data, error } = await ctx.supabase
    .from("founder_items")
    .insert({
      ...(clientId ? { id: clientId } : {}),
      owner_id: ctx.userId,
      kind: v.kind,
      title: v.title,
      notes: v.notes,
      priority: v.priority,
      due_at: v.dueAt,
      starts_at: v.startsAt,
      ends_at: v.endsAt,
      deal_id: v.dealId,
      completed_at: v.completed ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error || !data) {
    // A concurrent duplicate submit lost the race on the primary key - the item exists.
    if (clientId && (error as { code?: string } | null)?.code === "23505") {
      const { data: existing } = await ctx.supabase.from("founder_items").select("id").eq("id", clientId).eq("owner_id", ctx.userId).maybeSingle();
      if (existing) return { ok: true, id: existing.id };
    }
    return { ok: false, error: "We couldn't save that. Please try again." };
  }
  refresh();
  return { ok: true, id: data.id };
}

/**
 * Quick capture: a title and an optional due date, saved as a task to fill
 * in later. Goes through createFounderItem, so it gets the same validation,
 * the same founder check and - with a clientId - the same duplicate-safe
 * create.
 */
export async function quickCaptureFounderItem(title: string, options: { dueDate?: string; clientId?: string } = {}): Promise<FounderActionResult> {
  return createFounderItem({ kind: "task", title, priority: "medium", dueDate: options.dueDate ?? "", ...(options.clientId ? { clientId: options.clientId } : {}) });
}

const STALE_ITEM_ERROR = "This item changed since you opened it. Close and reopen it to see the latest version, then make your change again.";

/**
 * Edits (and reschedules) an item. When the form sends `expectedUpdatedAt`
 * - the item's updated_at as it was loaded - the write only applies if the
 * row is still that version, so two open dialogs can't silently overwrite
 * each other. A `completed` field sets or clears completion (keeping the
 * original completion time when it was already complete).
 */
export async function updateFounderItem(id: string, fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const parsed = parseItemInput(fields, ctx.timeZone);
  if (!parsed.ok) return parsed;
  if (!(await dealBelongsToFounder(ctx, parsed.value.dealId))) return { ok: false, error: "That deal could not be found." };
  const v = parsed.value;

  const { data: current, error: readError } = await ctx.supabase.from("founder_items").select("id, completed_at, updated_at").eq("id", id).eq("owner_id", ctx.userId).maybeSingle();
  if (readError) return { ok: false, error: "We couldn't save that. Please try again." };
  if (!current) return { ok: false, error: "That item could not be found." };
  const expected = typeof fields.expectedUpdatedAt === "string" && fields.expectedUpdatedAt ? fields.expectedUpdatedAt : null;
  if (expected && current.updated_at !== expected) return { ok: false, error: STALE_ITEM_ERROR };

  const completedAt = v.completed === null ? current.completed_at : v.completed ? (current.completed_at ?? new Date().toISOString()) : null;
  let query = ctx.supabase
    .from("founder_items")
    .update({ kind: v.kind, title: v.title, notes: v.notes, priority: v.priority, due_at: v.dueAt, starts_at: v.startsAt, ends_at: v.endsAt, deal_id: v.dealId, completed_at: completedAt })
    .eq("id", id)
    .eq("owner_id", ctx.userId);
  if (expected) query = query.eq("updated_at", expected);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) return { ok: false, error: "We couldn't save that. Please try again." };
  if (!data) return { ok: false, error: expected ? STALE_ITEM_ERROR : "That item could not be found." };
  refresh();
  return { ok: true, id: data.id };
}

export async function setFounderItemCompleted(id: string, completed: boolean): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  // Guarded on the current state, so a double-tap can't move the completion time.
  const query = ctx.supabase
    .from("founder_items")
    .update({ completed_at: completed ? new Date().toISOString() : null })
    .eq("id", id)
    .eq("owner_id", ctx.userId);
  const { data, error } = await (completed ? query.is("completed_at", null) : query.not("completed_at", "is", null)).select("id").maybeSingle();
  if (error) return { ok: false, error: "We couldn't update that item." };
  if (!data) {
    const { data: exists } = await ctx.supabase.from("founder_items").select("id").eq("id", id).eq("owner_id", ctx.userId).maybeSingle();
    if (!exists) return { ok: false, error: "That item could not be found." };
  }
  refresh();
  return { ok: true, id };
}

export async function deleteFounderItem(id: string): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const { data, error } = await ctx.supabase.from("founder_items").delete().eq("id", id).eq("owner_id", ctx.userId).select("id").maybeSingle();
  if (error) return { ok: false, error: "We couldn't delete that item." };
  if (!data) return { ok: false, error: "That item could not be found." };
  refresh();
  return { ok: true, id };
}

// --- deals ------------------------------------------------------------------------

const STALE_DEAL_ERROR = "This deal changed since you opened it. Close and reopen it to see the latest version, then try again.";

function dealRow(d: DealInput) {
  return {
    name: d.name,
    contact_name: d.contactName,
    contact_email: d.contactEmail,
    contact_phone: d.contactPhone,
    source: d.source,
    trade: d.trade,
    location: d.location,
    website: d.website,
    fit: d.fit,
    currency: d.currency,
    expected_setup_fee: d.expectedSetupFee,
    expected_mrr: d.expectedMrr,
    next_action: d.nextAction,
    next_action_at: d.nextActionAt,
    notes: d.notes,
  };
}

const clientIdOf = (value: unknown): string | null => (typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null);

/**
 * Creates a deal at an open stage (a deal is never created already won or
 * lost - wins and losses are recorded with their terms or reason). With a
 * `clientId` the create is duplicate-safe, like items.
 */
export async function createFounderDeal(fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const parsed = parseDealInput(fields, ctx.timeZone);
  if (!parsed.ok) return parsed;
  const clientId = clientIdOf(fields.clientId);
  if (clientId) {
    const { data: existing } = await ctx.supabase.from("founder_deals").select("id").eq("id", clientId).eq("owner_id", ctx.userId).maybeSingle();
    if (existing) return { ok: true, id: existing.id };
  }
  const { data, error } = await ctx.supabase
    .from("founder_deals")
    .insert({ ...(clientId ? { id: clientId } : {}), owner_id: ctx.userId, stage: parsed.value.stage, ...dealRow(parsed.value) })
    .select("id")
    .single();
  if (error || !data) {
    if (clientId && (error as { code?: string } | null)?.code === "23505") {
      const { data: existing } = await ctx.supabase.from("founder_deals").select("id").eq("id", clientId).eq("owner_id", ctx.userId).maybeSingle();
      if (existing) return { ok: true, id: existing.id };
    }
    return { ok: false, error: "We couldn't save this deal. Please try again." };
  }
  refresh();
  return { ok: true, id: data.id };
}

/**
 * Edits a deal's details (not its stage or outcome - those are recorded with
 * changeFounderDealStage). `expectedUpdatedAt` is required: the edit only
 * applies to the version that was loaded.
 */
export async function updateFounderDeal(id: string, fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  // The stage is only chosen at creation; anything sent here is ignored (dealRow never writes it).
  const parsed = parseDealInput({ ...fields, stage: "" }, ctx.timeZone);
  if (!parsed.ok) return parsed;
  const expected = typeof fields.expectedUpdatedAt === "string" && fields.expectedUpdatedAt ? fields.expectedUpdatedAt : null;
  if (!expected) return (await ownDeal(ctx, id)) ? { ok: false, error: STALE_DEAL_ERROR } : { ok: false, error: "That deal could not be found." };
  const { data, error } = await ctx.supabase.from("founder_deals").update(dealRow(parsed.value)).eq("id", id).eq("owner_id", ctx.userId).eq("updated_at", expected).select("id").maybeSingle();
  if (error) return { ok: false, error: "We couldn't save this deal. Please try again." };
  if (!data) {
    const { data: exists } = await ctx.supabase.from("founder_deals").select("id").eq("id", id).eq("owner_id", ctx.userId).maybeSingle();
    return { ok: false, error: exists ? STALE_DEAL_ERROR : "That deal could not be found." };
  }
  refresh();
  return { ok: true, id: data.id };
}

/** A deal with recorded history can't be deleted (the history is kept) - mark it lost instead. */
export async function deleteFounderDeal(id: string): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const { data, error } = await ctx.supabase.from("founder_deals").delete().eq("id", id).eq("owner_id", ctx.userId).select("id").maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23503") return { ok: false, error: "This deal has recorded sales history, so it can't be deleted. Mark it lost instead." };
    return { ok: false, error: "We couldn't delete this deal." };
  }
  if (!data) return { ok: false, error: "That deal could not be found." };
  refresh();
  return { ok: true, id };
}

// --- sales history -----------------------------------------------------------------

export type SalesActionResult = { ok: true; status: "recorded" | "duplicate"; updatedAt: string | null } | { ok: false; error: string };

/** Database refusals (supabase/pending/founder_sales_os.sql) as messages. */
function salesError(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "FS409":
      return STALE_DEAL_ERROR;
    case "FS404":
      return "That deal could not be found.";
    case "FS422": {
      const message = (error.message ?? "").trim();
      return message ? `${message[0].toUpperCase()}${message.slice(1)}.` : "That change isn't allowed.";
    }
    case "42883":
    case "PGRST202":
      return "Sales history isn't enabled on this database yet.";
    default:
      return "We couldn't record that. Please try again.";
  }
}

function salesResult(data: unknown): SalesActionResult {
  const r = (data ?? {}) as { status?: string; updated_at?: string };
  return { ok: true, status: r.status === "duplicate" ? "duplicate" : "recorded", updatedAt: r.updated_at ?? null };
}

async function ownDeal(ctx: FounderContext, dealId: string) {
  const { data } = await ctx.supabase.from("founder_deals").select("id, stage").eq("id", dealId).eq("owner_id", ctx.userId).maybeSingle();
  return data as { id: string; stage: DealStage } | null;
}

/**
 * Records something that happened on a deal (outreach, reply, meeting,
 * proposal, note...) - optionally moving the deal to the stage it suggests,
 * atomically. `requestId` (a UUID made when the form opened) makes a retry
 * or double-submit a no-op.
 */
export async function logFounderDealActivity(dealId: string, fields: Fields): Promise<SalesActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const requestId = clientIdOf(fields.requestId);
  if (!requestId) return { ok: false, error: "Please reopen the form and try again." };
  const deal = await ownDeal(ctx, dealId);
  if (!deal) return { ok: false, error: "That deal could not be found." };
  const parsed = parseActivityInput(fields, deal, ctx.timeZone, new Date());
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const expected = typeof fields.expectedUpdatedAt === "string" && fields.expectedUpdatedAt ? fields.expectedUpdatedAt : null;
  if (v.toStage && !expected) return { ok: false, error: STALE_DEAL_ERROR };
  const { data, error } = await ctx.supabase.rpc("founder_log_deal_activity", {
    p_request_id: requestId,
    p_deal_id: dealId,
    p_kind: v.kind,
    p_occurred_at: v.occurredAt,
    p_channel: v.channel,
    p_summary: v.summary,
    p_scheduled_for: v.scheduledFor,
    p_to_stage: v.toStage,
    p_expected_updated_at: v.toStage ? expected : null,
  });
  if (error) return { ok: false, error: salesError(error) };
  refresh();
  return salesResult(data);
}

/**
 * Moves a deal to another stage and records it, atomically. Won needs the
 * agreed setup fee, monthly fee, currency and date; lost needs a reason;
 * closed deals reopen to an open stage first. Stale and duplicate-safe.
 */
export async function changeFounderDealStage(dealId: string, fields: Fields): Promise<SalesActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const requestId = clientIdOf(fields.requestId);
  if (!requestId) return { ok: false, error: "Please reopen the form and try again." };
  const expected = typeof fields.expectedUpdatedAt === "string" && fields.expectedUpdatedAt ? fields.expectedUpdatedAt : null;
  if (!expected) return { ok: false, error: STALE_DEAL_ERROR };
  const deal = await ownDeal(ctx, dealId);
  if (!deal) return { ok: false, error: "That deal could not be found." };
  const now = new Date();
  const parsed = parseStageChange(fields, deal.stage, localDateKey(now, ctx.timeZone), ctx.timeZone, now);
  if (!parsed.ok) {
    // A retried request whose change already applied: let the database report it as a duplicate.
    if (parsed.error !== "The deal is already at that stage.") return parsed;
  }
  const v = parsed.ok ? parsed.value : { toStage: String(fields.toStage), occurredAt: null, setupFee: null, monthlyFee: null, currency: null, wonOn: null, reason: null };
  const { data, error } = await ctx.supabase.rpc("founder_change_deal_stage", {
    p_request_id: requestId,
    p_deal_id: dealId,
    p_to_stage: v.toStage,
    p_expected_updated_at: expected,
    p_occurred_at: v.occurredAt,
    p_setup_fee: v.setupFee,
    p_monthly_fee: v.monthlyFee,
    p_currency: v.currency,
    p_won_on: v.wonOn,
    p_reason: v.reason,
  });
  if (error) return { ok: false, error: salesError(error) };
  refresh();
  return salesResult(data);
}

/** Marks a logged entry as recorded in error (kept, shown struck through). Stage history can't be voided. */
export async function voidFounderDealActivity(activityId: string, reason: string): Promise<SalesActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (!UUID.test(activityId)) return { ok: false, error: "That entry could not be found." };
  const trimmed = String(reason ?? "").trim();
  if (!trimmed || trimmed.length > 500) return { ok: false, error: "Say why this entry is wrong (up to 500 characters)." };
  const { data, error } = await ctx.supabase.rpc("founder_void_deal_activity", { p_activity_id: activityId, p_reason: trimmed });
  if (error) return { ok: false, error: error.code === "FS404" ? "That entry could not be found." : salesError(error) };
  refresh();
  return salesResult(data);
}

// --- client handoff ---------------------------------------------------------------------

export type HandoffActionResult = { ok: true; status: "prepared" | "duplicate" | "exists" | "cancelled"; handoffId: string | null } | { ok: false; error: string };

function handoffError(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "FS404":
      return "That deal could not be found.";
    case "FS409":
    case "FS422": {
      const message = (error.message ?? "").trim();
      return message ? `${message[0].toUpperCase()}${message.slice(1)}.` : "That isn't possible right now.";
    }
    case "42883":
    case "PGRST202":
      return "Client handoff isn't enabled on this database yet.";
    default:
      return "We couldn't complete the handoff step. Please try again - nothing was saved twice.";
  }
}

/**
 * Prepares a client handoff for a won deal: copies only the agreed fields
 * (company, contact, setup + monthly fee, currency) plus the scope written
 * here. It creates no client - an agency admin confirms separately. The
 * request id makes a retry or double-submit return the same handoff.
 */
export async function prepareClientHandoff(dealId: string, fields: Fields): Promise<HandoffActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const requestId = clientIdOf(fields.requestId);
  if (!requestId) return { ok: false, error: "Please reopen the form and try again." };
  const { data: deal } = await ctx.supabase
    .from("founder_deals")
    .select("id, stage, won_setup_fee, won_monthly_fee, contact_name, contact_email, contact_phone")
    .eq("id", dealId)
    .eq("owner_id", ctx.userId)
    .maybeSingle();
  if (!deal) return { ok: false, error: "That deal could not be found." };
  const d = deal as { stage: DealStage; won_setup_fee: number | null; won_monthly_fee: number | null; contact_name: string | null; contact_email: string | null; contact_phone: string | null };
  const missing = handoffMissing({ stage: d.stage, wonSetupFee: d.won_setup_fee, wonMonthlyFee: d.won_monthly_fee, contactName: d.contact_name, contactEmail: d.contact_email, contactPhone: d.contact_phone });
  if (missing.length) return { ok: false, error: `Before handing off, add: ${missing.join("; ")}.` };
  const scope = parseScope(fields.scope);
  if (!scope.ok) return scope;
  const { data, error } = await ctx.supabase.rpc("founder_prepare_client_handoff", { p_request_id: requestId, p_deal_id: dealId, p_scope: scope.value });
  if (error) return { ok: false, error: handoffError(error) };
  refresh();
  const r = (data ?? {}) as { status?: string; handoff_id?: string };
  return { ok: true, status: r.status === "duplicate" || r.status === "exists" ? r.status : "prepared", handoffId: r.handoff_id ?? null };
}

/** Cancels a prepared (not yet confirmed) handoff, with a reason. The record is kept; a new one can be prepared. */
export async function cancelFounderClientHandoff(handoffId: string, reason: string): Promise<HandoffActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (!UUID.test(handoffId)) return { ok: false, error: "That handoff could not be found." };
  const trimmed = String(reason ?? "").trim();
  if (!trimmed || trimmed.length > 500) return { ok: false, error: "Say why the handoff is being cancelled (up to 500 characters)." };
  const { data, error } = await ctx.supabase.rpc("cancel_client_handoff", { p_handoff_id: handoffId, p_reason: trimmed });
  if (error) return { ok: false, error: error.code === "FS404" ? "That handoff could not be found." : handoffError(error) };
  refresh();
  return { ok: true, status: (data as { status?: string } | null)?.status === "duplicate" ? "duplicate" : "cancelled", handoffId };
}

// --- MRR ----------------------------------------------------------------------------

export async function createFounderMrrEntry(fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const parsed = parseMrrInput(fields);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const { data, error } = await ctx.supabase
    .from("founder_mrr_entries")
    .insert({ owner_id: ctx.userId, month: v.month, kind: v.kind, amount: v.amount, is_forecast: v.isForecast, customer: v.customer, description: v.description, source: "manual" })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "We couldn't save this entry. Please try again." };
  refresh();
  return { ok: true, id: data.id };
}

export async function deleteFounderMrrEntry(id: string): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const { data, error } = await ctx.supabase.from("founder_mrr_entries").delete().eq("id", id).eq("owner_id", ctx.userId).select("id").maybeSingle();
  if (error) return { ok: false, error: "We couldn't delete this entry." };
  if (!data) return { ok: false, error: "That entry could not be found." };
  refresh();
  return { ok: true, id };
}

// --- daily review ----------------------------------------------------------------------

export async function saveFounderReview(fields: Fields): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const parsed = parseReviewInput(fields);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const { data, error } = await ctx.supabase
    .from("founder_reviews")
    .upsert(
      { owner_id: ctx.userId, review_date: v.reviewDate, wins: v.wins, blockers: v.blockers, priorities_next: v.prioritiesNext, notes: v.notes },
      { onConflict: "owner_id,review_date" },
    )
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "We couldn't save your review. Please try again." };
  refresh();
  return { ok: true, id: data.id };
}

// --- daily priorities (supabase/pending/founder_daily_focus.sql) -------------------

const FOCUS_UNAVAILABLE: FounderActionResult = { ok: false, error: "Daily priorities need a database update (founder_daily_focus.sql) before they can be saved." };

type FocusRow = { id: string; focus_rank: number };

/** The day's current priorities, in rank order - or a reason they can't be read. */
async function priorityRows(ctx: FounderContext, dateKey: string): Promise<{ ok: true; rows: FocusRow[] } | { ok: false; result: FounderActionResult }> {
  const { data, error } = await ctx.supabase.from("founder_items").select("id, focus_rank").eq("owner_id", ctx.userId).eq("focus_date", dateKey).order("focus_rank", { ascending: true });
  if (error) return { ok: false, result: isMissingFocusColumn(error) ? FOCUS_UNAVAILABLE : { ok: false, error: "We couldn't load that day's priorities." } };
  return { ok: true, rows: (data as FocusRow[]).map((r) => ({ id: r.id, focus_rank: Number(r.focus_rank) })) };
}

/** Renumbers a day's priorities 1..n in the given order (owner-scoped, one small update each). */
async function writeRanks(ctx: FounderContext, dateKey: string, ids: string[]): Promise<boolean> {
  for (const [index, id] of ids.entries()) {
    const { error } = await ctx.supabase.from("founder_items").update({ focus_rank: index + 1 }).eq("id", id).eq("owner_id", ctx.userId).eq("focus_date", dateKey);
    if (error) return false;
  }
  return true;
}

/** Marks one of the founder's open tasks, follow-ups or deadlines as a priority for a day (at most three per day). */
export async function setFounderPriority(itemId: string, dateKey: string): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (!isDateKey(dateKey)) return { ok: false, error: "Choose a valid day." };
  const { data: item, error } = await ctx.supabase.from("founder_items").select("id, kind, completed_at").eq("id", itemId).eq("owner_id", ctx.userId).maybeSingle();
  if (error) return { ok: false, error: "We couldn't load that item." };
  if (!item) return { ok: false, error: "That item could not be found." };
  if (SCHEDULED_KINDS.includes(item.kind)) return { ok: false, error: "Meetings and events can't be priorities - pick a task, follow-up or deadline." };
  if (item.completed_at) return { ok: false, error: "That item is already complete." };
  const current = await priorityRows(ctx, dateKey);
  if (!current.ok) return current.result;
  if (current.rows.some((row) => row.id === itemId)) return { ok: true, id: itemId };
  if (current.rows.length >= MAX_DAILY_PRIORITIES) return { ok: false, error: `A day has at most ${MAX_DAILY_PRIORITIES} priorities. Remove one first.` };
  const { data, error: writeError } = await ctx.supabase
    .from("founder_items")
    .update({ focus_date: dateKey, focus_rank: current.rows.length + 1 })
    .eq("id", itemId)
    .eq("owner_id", ctx.userId)
    .select("id")
    .maybeSingle();
  if (writeError) return isMissingFocusColumn(writeError) ? FOCUS_UNAVAILABLE : { ok: false, error: "We couldn't set that priority. A day has at most three." };
  if (!data) return { ok: false, error: "That item could not be found." };
  refresh();
  return { ok: true, id: itemId };
}

/**
 * Adds a new priority by title: a task due that day, marked as the day's
 * next priority. Duplicate-safe with a clientId (a retry finds the same
 * task and just makes sure it's marked).
 */
export async function addFounderPriority(fields: { title: string; date: string; clientId?: string }): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (!isDateKey(fields.date)) return { ok: false, error: "Choose a valid day." };
  const current = await priorityRows(ctx, fields.date);
  if (!current.ok) return current.result;
  if (current.rows.length >= MAX_DAILY_PRIORITIES && !current.rows.some((row) => row.id === fields.clientId)) return { ok: false, error: `A day has at most ${MAX_DAILY_PRIORITIES} priorities. Remove one first.` };
  const created = await createFounderItem({ kind: "task", title: fields.title, priority: "high", dueDate: fields.date, ...(fields.clientId ? { clientId: fields.clientId } : {}) });
  if (!created.ok || !created.id) return created;
  return setFounderPriority(created.id, fields.date);
}

/** Unmarks a priority (the item itself is kept) and closes the gap in the day's order. */
export async function removeFounderPriority(itemId: string): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  const { data: item, error } = await ctx.supabase.from("founder_items").select("id, focus_date").eq("id", itemId).eq("owner_id", ctx.userId).maybeSingle();
  if (error) return isMissingFocusColumn(error) ? FOCUS_UNAVAILABLE : { ok: false, error: "We couldn't load that item." };
  if (!item) return { ok: false, error: "That item could not be found." };
  if (!item.focus_date) return { ok: true, id: itemId };
  const { error: writeError } = await ctx.supabase.from("founder_items").update({ focus_date: null, focus_rank: null }).eq("id", itemId).eq("owner_id", ctx.userId);
  if (writeError) return { ok: false, error: "We couldn't remove that priority." };
  const remaining = await priorityRows(ctx, item.focus_date);
  if (remaining.ok) await writeRanks(ctx, item.focus_date, remaining.rows.map((row) => row.id));
  refresh();
  return { ok: true, id: itemId };
}

/** Moves a priority one place up or down within its day. */
export async function moveFounderPriority(itemId: string, direction: "up" | "down"): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (direction !== "up" && direction !== "down") return { ok: false, error: "Choose up or down." };
  const { data: item, error } = await ctx.supabase.from("founder_items").select("id, focus_date").eq("id", itemId).eq("owner_id", ctx.userId).maybeSingle();
  if (error) return isMissingFocusColumn(error) ? FOCUS_UNAVAILABLE : { ok: false, error: "We couldn't load that item." };
  if (!item || !item.focus_date) return { ok: false, error: "That priority could not be found." };
  const current = await priorityRows(ctx, item.focus_date);
  if (!current.ok) return current.result;
  const ids = current.rows.map((row) => row.id);
  const index = ids.indexOf(itemId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ids.length) return { ok: true, id: itemId };
  [ids[index], ids[target]] = [ids[target], ids[index]];
  if (!(await writeRanks(ctx, item.focus_date, ids))) return { ok: false, error: "We couldn't reorder your priorities." };
  refresh();
  return { ok: true, id: itemId };
}

// --- moving work to another day (the end-of-day review) -----------------------------

/**
 * Moves an open item to another local day, keeping its local time of day
 * (a "by end of day" item stays end of day; an all-day event stays all-day;
 * a timed event keeps its length). Nothing moves unless the founder asks:
 * this runs only from an explicit button, and with expectedUpdatedAt it
 * refuses to overwrite a change made elsewhere.
 */
export async function moveFounderItemToDay(id: string, dateKey: string, expectedUpdatedAt?: string): Promise<FounderActionResult> {
  const ctx = await founder();
  if (!ctx) return NOT_AVAILABLE;
  if (!isDateKey(dateKey)) return { ok: false, error: "Choose a valid day." };
  const { data: row, error } = await ctx.supabase
    .from("founder_items")
    .select("id, kind, title, notes, priority, due_at, starts_at, ends_at, completed_at, deal_id, created_at, updated_at")
    .eq("id", id)
    .eq("owner_id", ctx.userId)
    .maybeSingle();
  if (error) return { ok: false, error: "We couldn't load that item." };
  if (!row) return { ok: false, error: "That item could not be found." };
  if (expectedUpdatedAt && row.updated_at !== expectedUpdatedAt) return { ok: false, error: STALE_ITEM_ERROR };
  const item = toItem(row);
  if (item.completedAt) return { ok: false, error: "That item is already complete." };

  let patch: Record<string, string | null>;
  if (SCHEDULED_KINDS.includes(item.kind) && item.startsAt) {
    if (isAllDayEvent(item, ctx.timeZone)) {
      const days = Math.round((new Date(item.endsAt as string).getTime() - new Date(item.startsAt).getTime()) / 86_400_000);
      patch = { starts_at: dayRange(dateKey, ctx.timeZone).start.toISOString(), ends_at: dayRange(addDaysKey(dateKey, Math.max(days, 1) - 1), ctx.timeZone).end.toISOString() };
    } else {
      const start = parseLocalDateTime(`${dateKey}T${toLocalInputValue(item.startsAt, ctx.timeZone).slice(11, 16)}`, ctx.timeZone);
      if (!start.ok || !start.value) return { ok: false, error: "We couldn't work out the new time." };
      const length = item.endsAt ? new Date(item.endsAt).getTime() - new Date(item.startsAt).getTime() : null;
      patch = { starts_at: start.value, ends_at: length != null ? new Date(new Date(start.value).getTime() + length).toISOString() : null };
    }
  } else {
    const keepTime = item.dueAt && !isEndOfDayDue(item, ctx.timeZone) ? `T${toLocalInputValue(item.dueAt, ctx.timeZone).slice(11, 16)}` : "";
    const due = parseLocalDateTime(`${dateKey}${keepTime}`, ctx.timeZone);
    if (!due.ok || !due.value) return { ok: false, error: "We couldn't work out the new date." };
    patch = { due_at: due.value };
  }

  let query = ctx.supabase.from("founder_items").update(patch).eq("id", id).eq("owner_id", ctx.userId);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error: writeError } = await query.select("id").maybeSingle();
  if (writeError) return { ok: false, error: "We couldn't move that item." };
  if (!data) return { ok: false, error: expectedUpdatedAt ? STALE_ITEM_ERROR : "That item could not be found." };
  refresh();
  return { ok: true, id };
}
