import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Customer-facing quote details: the quote number, an itemized breakdown,
 * and the scope of work and terms the customer reads before approving
 * (supabase/pending/estimate_quote_details.sql).
 *
 * Every read here is separate from the estimate's own query and tolerates a
 * database where that migration hasn't been applied yet: a missing column or
 * table resolves to "no details", so the quote keeps showing exactly what it
 * showed before (title, total, dates) instead of failing.
 *
 * Money is computed in integer cents, so a line total, the subtotal and
 * estimates.amount always agree to the cent.
 */

export type EstimateLineItem = {
  id: string;
  position: number;
  description: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
};

export type EstimateDetails = {
  /** Null until the migration is applied (then always set by the database). */
  number: number | null;
  scopeOfWork: string | null;
  terms: string | null;
  lineItems: EstimateLineItem[];
  /** False when the line-items table doesn't exist yet - the editor stays hidden. */
  lineItemsAvailable: boolean;
  /** False when the scope/terms columns don't exist yet. */
  textFieldsAvailable: boolean;
};

export const NO_ESTIMATE_DETAILS: EstimateDetails = { number: null, scopeOfWork: null, terms: null, lineItems: [], lineItemsAvailable: false, textFieldsAvailable: false };

export const LINE_ITEM_DESCRIPTION_MAX = 500;
export const LINE_ITEM_UNIT_MAX = 20;
export const QUOTE_TEXT_MAX = 5000;
const MAX_QUANTITY = 999_999_999;
const MAX_UNIT_PRICE = 9_999_999_999.99;

/** "Q-000012" - the quote's number as the customer sees it. */
export function formatQuoteNumber(number: number): string {
  return `Q-${String(number).padStart(6, "0")}`;
}

/** Exact money for a line: always two decimals ($1,240.00). */
export function formatLineMoney(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** 30, 2.5, 0.125 - a quantity without trailing zeros. */
export function formatQuantity(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

/** One line's total in cents: quantity × unit price, rounded to the cent. */
export function lineItemTotalCents(item: Pick<EstimateLineItem, "quantity" | "unitPrice">): number {
  return Math.round(item.quantity * toCents(item.unitPrice));
}

export function lineItemTotal(item: Pick<EstimateLineItem, "quantity" | "unitPrice">): number {
  return lineItemTotalCents(item) / 100;
}

export function lineItemsSubtotal(items: Pick<EstimateLineItem, "quantity" | "unitPrice">[]): number {
  return items.reduce((sum, item) => sum + lineItemTotalCents(item), 0) / 100;
}

/**
 * The itemization is shown to the customer only when it adds up to the
 * persisted total they are approving - never two different numbers.
 */
export function lineItemsMatchTotal(items: Pick<EstimateLineItem, "quantity" | "unitPrice">[], amount: number | null): boolean {
  if (items.length === 0 || amount == null) return false;
  return items.reduce((sum, item) => sum + lineItemTotalCents(item), 0) === toCents(amount);
}

export type LineItemInput = { description: string; quantity: number; unit: string | null; unitPrice: number };
export type LineItemParse = { ok: true; value: LineItemInput } | { ok: false; error: string };

/** Validates a line item from the editor. Mirrors the table's own checks. */
export function parseLineItemInput(raw: { description: unknown; quantity: unknown; unit: unknown; unitPrice: unknown }): LineItemParse {
  const description = String(raw.description ?? "").trim();
  if (!description) return { ok: false, error: "Describe the work or material." };
  if (description.length > LINE_ITEM_DESCRIPTION_MAX) return { ok: false, error: `Keep the description under ${LINE_ITEM_DESCRIPTION_MAX} characters.` };

  const quantityText = String(raw.quantity ?? "").trim();
  const quantity = quantityText === "" ? 1 : Number(quantityText);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) return { ok: false, error: "Enter a quantity greater than zero." };
  if (Math.round(quantity * 1000) !== quantity * 1000) return { ok: false, error: "Use at most three decimal places for the quantity." };

  const priceText = String(raw.unitPrice ?? "").trim().replace(/[$,\s]/g, "");
  const unitPrice = Number(priceText);
  if (priceText === "" || !Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > MAX_UNIT_PRICE) return { ok: false, error: "Enter a price of zero or more." };
  if (toCents(unitPrice) !== unitPrice * 100 && Math.abs(toCents(unitPrice) - unitPrice * 100) > 1e-6) return { ok: false, error: "Use at most two decimal places for the price." };

  const unit = String(raw.unit ?? "").trim();
  if (unit.length > LINE_ITEM_UNIT_MAX) return { ok: false, error: `Keep the unit under ${LINE_ITEM_UNIT_MAX} characters.` };

  return { ok: true, value: { description, quantity, unit: unit || null, unitPrice: toCents(unitPrice) / 100 } };
}

/** Customer-visible text: trimmed, empty becomes null, length-limited. */
export function parseQuoteText(raw: unknown, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const value = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (value.length > QUOTE_TEXT_MAX) return { ok: false, error: `Keep the ${label} under ${QUOTE_TEXT_MAX} characters.` };
  return { ok: true, value: value || null };
}

type LineItemRow = { id: string; position: number; description: string; quantity: number | string; unit: string | null; unit_price: number | string };

function toLineItem(row: LineItemRow): EstimateLineItem {
  return { id: row.id, position: row.position, description: row.description, quantity: Number(row.quantity), unit: row.unit, unitPrice: Number(row.unit_price) };
}

/**
 * Loads one estimate's details. `supabase` is either the member's session
 * client (RLS + the explicit organization filter) or, for the public quote
 * page, the service client after the approval token resolved the estimate -
 * the organization filter is applied either way.
 */
export async function getEstimateDetails(supabase: SupabaseClient, organizationId: string, estimateId: string): Promise<EstimateDetails> {
  const [fields, items] = await Promise.all([
    supabase.from("estimates").select("number, scope_of_work, terms").eq("id", estimateId).eq("organization_id", organizationId).maybeSingle(),
    supabase
      .from("estimate_line_items")
      .select("id, position, description, quantity, unit, unit_price")
      .eq("estimate_id", estimateId)
      .eq("organization_id", organizationId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);

  const row = fields.error ? null : (fields.data as { number: number | null; scope_of_work: string | null; terms: string | null } | null);
  return {
    number: row?.number ?? null,
    scopeOfWork: row?.scope_of_work ?? null,
    terms: row?.terms ?? null,
    lineItems: items.error ? [] : ((items.data ?? []) as LineItemRow[]).map(toLineItem),
    lineItemsAvailable: !items.error,
    textFieldsAvailable: !fields.error,
  };
}

/**
 * The sum of an estimate's line items, or null when it has none (or the
 * line-items table doesn't exist yet). While items exist the application
 * keeps estimates.amount equal to this, so the customer approves exactly
 * the itemized figure.
 */
export async function getLineItemSubtotal(supabase: SupabaseClient, organizationId: string, estimateId: string): Promise<number | null> {
  const { data, error } = await supabase.from("estimate_line_items").select("quantity, unit_price").eq("estimate_id", estimateId).eq("organization_id", organizationId);
  if (error || !Array.isArray(data) || data.length === 0) return null;
  return lineItemsSubtotal((data as { quantity: number | string; unit_price: number | string }[]).map((row) => ({ quantity: Number(row.quantity), unitPrice: Number(row.unit_price) })));
}
