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

export type WaitingMessage = { direction: "inbound" | "outbound"; status: string | null; created_at: string };

const countsAsEvidence = (message: WaitingMessage) => message.direction === "inbound" || (SUCCESSFUL_OUTBOUND_STATUSES as readonly string[]).includes(message.status ?? "");

/** Pure: true when, among the conversation's inbound and successful outbound messages, the newest is inbound. */
export function isWaitingOnBusiness(messages: WaitingMessage[]): boolean {
  let newest: WaitingMessage | null = null;
  for (const message of messages) {
    if (!countsAsEvidence(message)) continue;
    if (!newest || new Date(message.created_at).getTime() > new Date(newest.created_at).getTime()) newest = message;
  }
  return newest?.direction === "inbound";
}

/**
 * The organization's open conversations waiting on the business (optionally
 * one contact's) - one paged read with each conversation's newest inbound or
 * successful outbound message embedded. Never one read per conversation. A
 * failed read is `failed`, never "nobody is waiting".
 */
export async function getWaitingConversationIds(supabase: SupabaseClient, organizationId: string, options: { contactId?: string } = {}): Promise<{ ids: Set<string>; failed: boolean }> {
  const read = await readAllPages<{ id: string; messages: { direction: "inbound" | "outbound" }[] | null }>(() => {
    let query = supabase
      .from("conversations")
      .select("id, messages!inner(created_at, direction)")
      .eq("organization_id", organizationId)
      .eq("status", "open")
      .eq("messages.organization_id", organizationId)
      .or(`direction.eq.inbound,and(direction.eq.outbound,status.in.(${SUCCESSFUL_OUTBOUND_STATUSES.join(",")}))`, { referencedTable: "messages" })
      .order("created_at", { referencedTable: "messages", ascending: false })
      .limit(1, { referencedTable: "messages" });
    if (options.contactId) query = query.eq("contact_id", options.contactId);
    return query.order("id");
  });
  if (read.failed) return { ids: new Set(), failed: true };
  return { ids: new Set(read.rows.filter((row) => row.messages?.[0]?.direction === "inbound").map((row) => row.id)), failed: false };
}
