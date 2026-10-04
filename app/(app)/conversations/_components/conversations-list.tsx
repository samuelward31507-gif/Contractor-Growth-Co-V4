import Link from "next/link";
import { Bot, SearchX } from "lucide-react";
import { contactDisplayName, contactInitials } from "@/lib/contacts/format";
import { formatRelativeTime } from "@/lib/dashboard/format";
import { CHANNEL_LABELS } from "@/lib/conversations/format";
import { Badge } from "@/lib/ui/badge";
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
function needsReply(conversation: ConversationWithLastMessage, waitingIds: ReadonlySet<string>): boolean {
  return conversation.status === "open" && waitingIds.has(conversation.id);
}

export function ConversationsList({
  conversations,
  hasActiveFilters,
  activeId,
  waitingIds,
}: {
  conversations: ConversationWithLastMessage[];
  hasActiveFilters: boolean;
  activeId: string | null;
  /** Phase 3 (W1): the open conversations waiting on the business (getWaitingConversationIds). */
  waitingIds: ReadonlySet<string>;
}) {
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
        const awaitingReply = needsReply(conversation, waitingIds);

        return (
          <li key={conversation.id}>
            <Link
              href={`/conversations/${conversation.id}`}
              aria-current={isActive ? "page" : undefined}
              className={`flex items-start gap-3 px-4 py-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink ${
                isActive
                  ? "bg-selected shadow-[inset_2px_0_0_0_var(--accent)]"
                  : awaitingReply
                    ? "bg-info-muted/70 hover:bg-info-muted"
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
                        <span className="h-2 w-2 rounded-full bg-info" aria-hidden />
                        <span className="sr-only">Awaiting your reply</span>
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
                  <ConversationStatusBadge status={conversation.status} />
                  {conversation.ai_enabled ? (
                    <Badge tone="info" icon={Bot}>
                      AI
                    </Badge>
                  ) : null}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
