import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "./queries";

const CONTACT_COLUMNS = "id, first_name, last_name, phone, email, company_name, notes, created_at, updated_at";

export type DuplicateMatchReason = "phone" | "email" | "phone_and_email";

export type DuplicateGroup = {
  reason: DuplicateMatchReason;
  contacts: Contact[];
};

/**
 * Contact Deduplication V1 - potential-duplicate detection. Strong-identity
 * matches only (exact normalized phone, exact normalized email) - the same
 * two identity fields the resolver itself matches on, never a fuzzy/name-
 * based match. Per explicit product decision, this deliberately does NOT
 * implement any fuzzy-name suggestion tier at all - only groups that share
 * an exact normalized phone or email are ever surfaced, so there is no
 * "weak suggestion" the UI could be tempted to make one-click-actionable.
 * Merged (already-archived) contacts are excluded - they are historical
 * records, not candidates for another merge.
 */
export async function findPotentialDuplicates(supabase: SupabaseClient, organizationId: string): Promise<DuplicateGroup[]> {
  const { data } = await supabase
    .from("contacts")
    .select(`${CONTACT_COLUMNS}, phone_normalized, email_normalized`)
    .eq("organization_id", organizationId)
    .is("merged_into_id", null)
    .limit(1000);

  const rows = (data ?? []) as (Contact & { phone_normalized: string | null; email_normalized: string | null })[];

  const byPhone = new Map<string, typeof rows>();
  const byEmail = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.phone_normalized) byPhone.set(row.phone_normalized, [...(byPhone.get(row.phone_normalized) ?? []), row]);
    if (row.email_normalized) byEmail.set(row.email_normalized, [...(byEmail.get(row.email_normalized) ?? []), row]);
  }

  const groups: DuplicateGroup[] = [];
  const seenPairKeys = new Set<string>();

  function pairKey(ids: string[]): string {
    return [...ids].sort().join(",");
  }

  for (const group of byPhone.values()) {
    if (group.length < 2) continue;
    const ids = group.map((c) => c.id);
    const key = pairKey(ids);
    if (seenPairKeys.has(key)) continue;
    seenPairKeys.add(key);
    groups.push({ reason: "phone", contacts: group });
  }

  for (const group of byEmail.values()) {
    if (group.length < 2) continue;
    const ids = group.map((c) => c.id);
    const key = pairKey(ids);
    if (seenPairKeys.has(key)) {
      // Same exact set of contacts already grouped by phone too - upgrade
      // the label rather than listing it twice.
      const existing = groups.find((g) => pairKey(g.contacts.map((c) => c.id)) === key);
      if (existing) existing.reason = "phone_and_email";
      continue;
    }
    seenPairKeys.add(key);
    groups.push({ reason: "email", contacts: group });
  }

  return groups;
}

export type ContactRelationshipCounts = {
  leads: number;
  conversations: number;
  appointments: number;
  estimates: number;
  jobs: number;
  reviewRequests: number;
  referralRequests: number;
  aiInteractions: number;
};

/**
 * Every table with a foreign key to contacts(id), confirmed exhaustively
 * against production's own information_schema during this feature's audit
 * - exactly these eight, no others (automation_events/workflow_executions
 * have no contact_id column at all). Used to show "what will move" before
 * a merge, and for general contact-detail display.
 */
export async function getContactRelationshipCounts(supabase: SupabaseClient, organizationId: string, contactId: string): Promise<ContactRelationshipCounts> {
  const countOf = async (table: string) => {
    const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("contact_id", contactId);
    return count ?? 0;
  };

  const [leads, conversations, appointments, estimates, jobs, reviewRequests, referralRequests, aiInteractions] = await Promise.all([
    countOf("leads"),
    countOf("conversations"),
    countOf("appointments"),
    countOf("estimates"),
    countOf("jobs"),
    countOf("review_requests"),
    countOf("referral_requests"),
    countOf("ai_interactions"),
  ]);

  return { leads, conversations, appointments, estimates, jobs, reviewRequests, referralRequests, aiInteractions };
}
