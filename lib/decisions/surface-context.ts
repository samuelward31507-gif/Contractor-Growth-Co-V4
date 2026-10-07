import type { SupabaseClient } from "@supabase/supabase-js";
import { getAiSettings } from "@/lib/settings/queries";
import { readAllPages } from "@/lib/bi/revenue-attribution";
import { WAITING_REPLY_CAP, type DecisionContext } from "./actor";
import { getDecisionContext } from "./context";
import { waitingIdsAsAttentionItems } from "./presentation";

/**
 * Batch 3 (core daily loop): the DecisionContext for People, Person and
 * Inbox - Today's own getDecisionContext, unchanged, fed the canonical
 * waiting conversation ids instead of Today's attention items (capped the
 * way the dashboard SQL caps them, so the actor answers match Today's).
 *
 * getDecisionContext reads ai_settings only when a waiting conversation is
 * inside its grace window - all it needs for Today. The Inbox also has to
 * say whether Trackpr would answer an already-answered conversation's next
 * message, so the same getAiSettings read is made here when it was skipped.
 * Read-only; no rule lives here.
 */
export async function getSurfaceDecisionContext(
  supabase: SupabaseClient,
  organizationId: string,
  input: { waitingConversationIds: Iterable<string>; timeZone: string | null; now?: number },
): Promise<DecisionContext> {
  const attentionItems = waitingIdsAsAttentionItems(input.waitingConversationIds, WAITING_REPLY_CAP);
  const [context, aiSettings] = await Promise.all([
    getDecisionContext(supabase, organizationId, { attentionItems, timeZone: input.timeZone, now: input.now }),
    getAiSettings(supabase, organizationId).catch(() => null),
  ]);
  return { ...context, aiSettingsEnabled: aiSettings?.ai_enabled === true };
}

export type ContactReach = { phone: string | null; smsOptOut: boolean | null };

type ReachRow = { contact: { id: string; phone: string | null; sms_opt_out: boolean } | { id: string; phone: string | null; sms_opt_out: boolean }[] | null };

/**
 * The phone and opt-out of every contact with an open pending-estimate
 * opportunity - the same opportunities -> contacts join
 * getPrioritizedOpportunities makes for Today (lib/opportunities/
 * intelligence.ts), narrowed to pending estimates, so the estimate actor
 * reads the same reachability on People and Person as on Today. A failed
 * read returns an empty map: every estimate is then the contractor's
 * (resolveOpportunityActor treats unknown reachability as unreachable).
 */
export async function getEstimateContactReach(supabase: SupabaseClient, organizationId: string): Promise<Map<string, ContactReach>> {
  const read = await readAllPages<ReachRow>(() =>
    supabase
      .from("opportunities")
      .select("contact:contacts!opportunities_contact_id_fkey(id, phone, sms_opt_out)")
      .eq("organization_id", organizationId)
      .eq("status", "open")
      .eq("type", "pending_estimate")
      .not("contact_id", "is", null)
      .order("id"),
  );
  const reach = new Map<string, ContactReach>();
  if (read.failed) return reach;
  for (const row of read.rows) {
    const contact = Array.isArray(row.contact) ? (row.contact[0] ?? null) : row.contact;
    if (contact) reach.set(contact.id, { phone: contact.phone, smsOptOut: contact.sms_opt_out });
  }
  return reach;
}
