import Link from "next/link";
import { CheckCircle2, SearchX } from "lucide-react";
import { contactDisplayName, contactInitials } from "@/lib/contacts/format";
import { formatRelativeTime } from "@/lib/dashboard/format";
import { CHANNEL_LABELS } from "@/lib/conversations/format";
import type { ConversationOwnerView } from "@/lib/decisions/presentation";
import { OwnerChip } from "@/lib/ui/owner-chip";
import { secondaryButtonSmallClass } from "@/lib/ui/form";
import type { ConversationWithLastMessage } from "@/lib/conversations/queries";
import { ConversationStatusBadge } from "./status-badge";

function lastMessagePreview(conversation: ConversationWithLastMessage): string {
  if (!conversation.lastMessage) return "No messages yet";
  const body = conversation.lastMessage.body.trim();
  return body.length > 60 ? `${body.slice(0, 60)}…` : body;
}

/**
 * There's no read/unread column on conversations or messages (no schema
 * change is in scope here) - so "needs a reply" is derived from real data
 * instead of a fabricated read flag. Phase 3 (W1): the canonical waiting
 * rule (lib/conversations/waiting) - an open conversation whose latest
 * customer message has no successful (sent / delivered) outbound after it.
 * A failed send or a logged note is not a reply.
 */
export function ConversationsList({
  conversations,
  hasActiveFilters,
  activeId,
  waitingIds,
  ownerById,
  needsYouView = false,
  onShowAll,
}: {
  conversations: ConversationWithLastMessage[];
  hasActiveFilters: boolean;
  activeId: string | null;
  /** Phase 3 (W1): the open conversations waiting on the business (getWaitingConversationIds). */
  waitingIds: ReadonlySet<string>;
  /** Batch 3: who each conversation is with right now (presentConversationOwner). */
  ownerById: Record<string, ConversationOwnerView>;
  /** The Inbox's "Needs you" view is showing - an empty list then means nothing needs the contractor. */
  needsYouView?: boolean;
  onShowAll?: () => void;
}) {
  if (conversations.length === 0 && needsYouView && !hasActiveFilters) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <CheckCircle2 className="h-5 w-5 text-accent" aria-hidden />
        <p className="text-sm font-medium text-ink">Nothing needs your attention</p>
        <p className="max-w-64 text-xs text-ink-3">Trackpr is handling the conversations it can. Anything that needs your reply shows up here.</p>
        {onShowAll ? (
          <button type="button" onClick={onShowAll} className={`${secondaryButtonSmallClass} mt-2`}>
            Show all conversations
          </button>
        ) : null}
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <SearchX className="h-5 w-5 text-ink-4" aria-hidden />
        <p className="text-sm font-medium text-ink">No conversations match your filters.</p>
        {hasActiveFilters ? <p className="text-xs text-ink-3">Try clearing your filters.</p> : null}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {conversations.map((conversation) => {
        const name = conversation.contact ? contactDisplayName(conversation.contact) : "No contact";
        const isActive = conversation.id === activeId;
        // Batch 3: emphasis follows who has to act (the actor model), not
        // merely "the last message is the customer's" - a conversation
        // Trackpr is replying to is not waiting on the contractor.
        const owner = ownerById[conversation.id];
        const awaitingReply = Boolean(owner?.needsYou) && waitingIds.has(conversation.id);

        return (
          <li key={conversation.id}>
            <Link
              href={`/conversations/${conversation.id}`}
              aria-current={isActive ? "page" : undefined}
              className={`flex items-start gap-3 px-4 py-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink ${
                isActive
                  ? "bg-selected shadow-[inset_2px_0_0_0_var(--accent)]"
                  : awaitingReply
                    ? "bg-warning-muted/60 hover:bg-warning-muted"
                    : "hover:bg-hover"
              }`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-inset text-xs font-medium text-ink-2">
                {conversation.contact ? contactInitials(conversation.contact) : "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span
                    className={`truncate text-sm text-ink ${awaitingReply ? "font-semibold" : "font-medium"}`}
                  >
                    {name}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {awaitingReply ? (
                      <>
                        <span className="h-2 w-2 rounded-full bg-warning" aria-hidden />
                        <span className="sr-only">Needs your reply</span>
                      </>
                    ) : null}
                    <span className="text-[11px] text-ink-3">{formatRelativeTime(conversation.lastActivityAt)}</span>
                  </span>
                </span>
                <span
                  className={`mt-0.5 block truncate text-xs ${awaitingReply ? "text-ink-2" : "text-ink-3"}`}
                >
                  {lastMessagePreview(conversation)}
                </span>
                <span className="mt-1.5 flex items-center gap-2">
                  <span className="text-[11px] text-ink-3">{CHANNEL_LABELS[conversation.channel]}</span>
                  {owner?.owner ? (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <OwnerChip owner={owner.owner} urgent={owner.needsYou} />
                      <span className="truncate text-[11px] text-ink-3">{owner.label}</span>
                    </span>
                  ) : (
                    <ConversationStatusBadge status={conversation.status} />
                  )}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
