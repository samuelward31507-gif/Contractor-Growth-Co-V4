import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "@/lib/bi/revenue-attribution";
import { resolveAgencyOrganizations, type AgencyAuthFailure } from "./queries";

/**
 * Agency Command Center 2.0 - human-escalation visibility. `ai_enabled =
 * false` on an open conversation is this codebase's own durable escalation
 * lock (see lib/automation/outbound-gate.ts's `conversation_ai_disabled`
 * deny reason and its "needs_human" comment) - a human has to act before AI
 * can resume replying. This reads that existing flag directly; it computes
 * nothing new and invents no separate "AI state" concept.
 */
export type AgencyEscalatedConversation = {
  id: string;
  organizationId: string;
  contactId: string | null;
  leadId: string | null;
  updatedAt: string;
};

export type AgencyEscalationsResult =
  /** Phase 3E: `failed` is true when the escalation read failed (a page error or the row limit) - the list and counts are then empty placeholders, never "no escalations". */
  | { ok: true; conversations: AgencyEscalatedConversation[]; countByOrg: Map<string, number>; failed: boolean }
  | AgencyAuthFailure;

type EscalatedConversationRow = {
  id: string;
  organization_id: string;
  contact_id: string | null;
  lead_id: string | null;
  updated_at: string;
};

export async function getAgencyEscalatedConversations(
  sessionSupabase: SupabaseClient,
  serviceSupabase: SupabaseClient,
): Promise<AgencyEscalationsResult> {
  const resolved = await resolveAgencyOrganizations(sessionSupabase, serviceSupabase);
  if (!resolved.ok) return resolved;

  const organizationIds = resolved.organizations.map((org) => org.organizationId);
  if (organizationIds.length === 0) {
    return { ok: true, conversations: [], countByOrg: new Map(), failed: false };
  }

  // Phase 3E: paged (readAllPages) - the API caps a response at 1000 rows,
  // which silently cut the escalation counts short. Newest first with id as
  // the tie-break, so pages are stable and the first row seen per
  // organization stays its most recent escalation. A failed page or the row
  // limit returns failed with no rows - never "no escalations".
  const read = await readAllPages<EscalatedConversationRow>(() =>
    serviceSupabase
      .from("conversations")
      .select("id, organization_id, contact_id, lead_id, updated_at")
      .in("organization_id", organizationIds)
      .eq("status", "open")
      .eq("ai_enabled", false)
      .order("updated_at", { ascending: false })
      .order("id"),
  );

  if (read.failed) {
    return { ok: true, conversations: [], countByOrg: new Map(), failed: true };
  }

  const conversations: AgencyEscalatedConversation[] = read.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    contactId: row.contact_id,
    leadId: row.lead_id,
    updatedAt: row.updated_at,
  }));

  const countByOrg = new Map<string, number>();
  for (const conversation of conversations) {
    countByOrg.set(conversation.organizationId, (countByOrg.get(conversation.organizationId) ?? 0) + 1);
  }

  return { ok: true, conversations, countByOrg, failed: false };
}
