import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Accidental-duplicate protection for estimate creation.
 *
 * A second submit of the same "New Estimate" form (a retry after a slow
 * response, a re-opened dialog, a double submit) used to insert a second,
 * identical draft. There is deliberately no database uniqueness constraint
 * here: a contractor can legitimately create several estimates for the same
 * contact and lead (options, revisions, separate jobs). Instead, a new draft
 * that is identical in every field the contractor entered to a draft created
 * for the same contact moments ago is treated as the same submission, and
 * that existing estimate is returned instead of inserting another.
 *
 * Anything different - another amount, title, lead, notes or expiry, or the
 * same details after the window has passed - is a genuinely new estimate.
 * Only drafts count: once an estimate has been sent or answered, an
 * identical new draft is a deliberate re-quote.
 */
export const ESTIMATE_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

export type EstimateCreateFields = {
  contactId: string;
  leadId: string | null;
  title: string;
  amount: number | null;
  notes: string | null;
  expiresAt: string | null;
};

type ExistingEstimateRow = {
  id: string;
  lead_id: string | null;
  title: string;
  amount: number | string | null;
  notes: string | null;
  expires_at: string | null;
};

const sameAmount = (a: number | string | null, b: number | null) => (a === null || a === undefined ? b === null : b !== null && Number(a) === b);
const sameInstant = (a: string | null, b: string | null) => (a === null || b === null ? a === b : new Date(a).getTime() === new Date(b).getTime());

/** Pure: does an existing draft carry exactly the details being submitted? */
export function isSameEstimateSubmission(existing: ExistingEstimateRow, input: EstimateCreateFields): boolean {
  return (
    (existing.lead_id ?? null) === input.leadId &&
    existing.title === input.title &&
    sameAmount(existing.amount, input.amount) &&
    (existing.notes ?? null) === input.notes &&
    sameInstant(existing.expires_at ?? null, input.expiresAt)
  );
}

/** The id of an identical draft created for this contact within the window, if any. */
export async function findRecentDuplicateEstimate(
  supabase: SupabaseClient,
  organizationId: string,
  input: EstimateCreateFields,
  now: Date = new Date(),
): Promise<string | null> {
  const since = new Date(now.getTime() - ESTIMATE_DUPLICATE_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("estimates")
    .select("id, lead_id, title, amount, notes, expires_at")
    .eq("organization_id", organizationId)
    .eq("contact_id", input.contactId)
    .eq("status", "draft")
    .eq("title", input.title)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error || !data) return null;
  const match = (data as ExistingEstimateRow[]).find((row) => isSameEstimateSubmission(row, input));
  return match?.id ?? null;
}
