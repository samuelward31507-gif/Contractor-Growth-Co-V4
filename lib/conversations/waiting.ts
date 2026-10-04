import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "@/lib/bi/revenue-attribution";

/**
 * Phase 2-13 (§3): the one definition of "waiting on the business" outside
 * Today's decision layer - a conversation is waiting when the latest
 * customer message is inbound and no successful (sent or delivered)
 * outbound message has followed it. A failed or queued send is not a reply.
 * Whether the conversation's AI is on is not part of it. (Today adds its own
 * 15-minute AI grace on top; this module does not.)
 */
export const SUCCESSFUL_OUTBOUND_STATUSES = ["sent", "delivered"] as const;

/** Phase 3 (W1): the one definition every waiting / contact-evidence reader imports. */
export const SUCCESSFUL_OUTBOUND_STATUS_SET: ReadonlySet<string> = new Set(SUCCESSFUL_OUTBOUND_STATUSES);

/** PostgREST filter for the referenced messages table: inbound, or outbound that actually reached the customer. */
export const WAITING_EVIDENCE_FILTER = `direction.eq.inbound,and(direction.eq.outbound,status.in.(${SUCCESSFUL_OUTBOUND_STATUSES.join(",")}))`;

export type WaitingMessage = { direction: "inbound" | "outbound"; status: string | null; created_at: string };

/** A message that can start or end a wait: any inbound, or a sent / delivered outbound. Failed, undelivered, queued and logged notes are not replies. */
export const countsAsEvidence = (message: Pick<WaitingMessage, "direction" | "status">) => message.direction === "inbound" || SUCCESSFUL_OUTBOUND_STATUS_SET.has(message.status ?? "");

/** Pure: true when, among the conversation's inbound and successful outbound messages, the newest is inbound. */
export function isWaitingOnBusiness(messages: WaitingMessage[]): boolean {
  let newest: WaitingMessage | null = null;
  for (const message of messages) {
    if (!countsAsEvidence(message)) continue;
    if (!newest || new Date(message.created_at).getTime() > new Date(newest.created_at).getTime()) newest = message;
  }
  return newest?.direction === "inbound";
}

export type LatestEvidence = { direction: "inbound" | "outbound"; createdAt: string };

/**
 * Phase 3 (W1): each OPEN conversation's newest inbound-or-successful-outbound
 * message (optionally one contact's) - the evidence every waiting and
 * went-quiet reader classifies on. One paged read with the newest qualifying
 * message embedded; never one read per conversation. A conversation with no
 * qualifying message (none at all, or only failed sends / notes) is absent.
 * A failed read is `failed`, never "no evidence".
 */
export async function getLatestEvidenceByConversation(
  supabase: SupabaseClient,
  organizationId: string,
  options: { contactId?: string } = {},
): Promise<{ evidence: Map<string, LatestEvidence>; failed: boolean }> {
  const read = await readAllPages<{ id: string; messages: { direction: "inbound" | "outbound"; created_at: string }[] | null }>(() => {
    let query = supabase
      .from("conversations")
      .select("id, messages!inner(created_at, direction)")
      .eq("organization_id", organizationId)
      .eq("status", "open")
      .eq("messages.organization_id", organizationId)
      .or(WAITING_EVIDENCE_FILTER, { referencedTable: "messages" })
      .order("created_at", { referencedTable: "messages", ascending: false })
      .order("id", { referencedTable: "messages", ascending: false })
      .limit(1, { referencedTable: "messages" });
    if (options.contactId) query = query.eq("contact_id", options.contactId);
    return query.order("id");
  });
  if (read.failed) return { evidence: new Map(), failed: true };
  const evidence = new Map<string, LatestEvidence>();
  for (const row of read.rows) {
    const newest = row.messages?.[0];
    if (newest) evidence.set(row.id, { direction: newest.direction, createdAt: newest.created_at });
  }
  return { evidence, failed: false };
}

/**
 * The organization's open conversations waiting on the business (optionally
 * one contact's): those whose newest evidence is inbound. A failed read is
 * `failed`, never "nobody is waiting".
 */
export async function getWaitingConversationIds(supabase: SupabaseClient, organizationId: string, options: { contactId?: string } = {}): Promise<{ ids: Set<string>; failed: boolean }> {
  const { evidence, failed } = await getLatestEvidenceByConversation(supabase, organizationId, options);
  if (failed) return { ids: new Set(), failed: true };
  return { ids: new Set([...evidence].filter(([, latest]) => latest.direction === "inbound").map(([id]) => id)), failed: false };
}
