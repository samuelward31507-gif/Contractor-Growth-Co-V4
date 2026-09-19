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
 * instead of a fabricated read flag: an open conversation whose most recent
 * message came from the customer, with nobody having replied since.
 */
function needsReply(conversation: ConversationWithLastMessage): boolean {
  return conversation.status === "open" && conversation.lastMessage?.direction === "inbound";
}

export function ConversationsList({
  conversations,
  hasActiveFilters,
  activeId,
}: {
  conversations: ConversationWithLastMessage[];
  hasActiveFilters: boolean;
  activeId: string | null;
}) {
  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <SearchX className="h-5 w-5 text-slate-300" aria-hidden />
        <p className="text-sm font-medium text-slate-900">No conversations match your filters.</p>
        {hasActiveFilters ? <p className="text-xs text-slate-500">Try clearing your filters.</p> : null}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-100">
      {conversations.map((conversation) => {
        const name = conversation.contact ? contactDisplayName(conversation.contact) : "No contact";
        const isActive = conversation.id === activeId;
        const awaitingReply = needsReply(conversation);

        return (
          <li key={conversation.id}>
            <Link
              href={`/conversations/${conversation.id}`}
              aria-current={isActive ? "page" : undefined}
              className={`flex items-start gap-3 px-4 py-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-slate-900 ${
                isActive
                  ? "bg-slate-100 shadow-[inset_2px_0_0_0_#0f172a]"
                  : awaitingReply
                    ? "bg-blue-50/70 hover:bg-blue-50"
                    : "hover:bg-slate-50"
              }`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                {conversation.contact ? contactInitials(conversation.contact) : "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span
                    className={`truncate text-sm text-slate-900 ${awaitingReply ? "font-semibold" : "font-medium"}`}
                  >
                    {name}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {awaitingReply ? (
                      <>
                        <span className="h-2 w-2 rounded-full bg-blue-500" aria-hidden />
                        <span className="sr-only">Awaiting your reply</span>
                      </>
                    ) : null}
                    <span className="text-[11px] text-slate-400">{formatRelativeTime(conversation.lastActivityAt)}</span>
                  </span>
                </span>
                <span
                  className={`mt-0.5 block truncate text-xs ${awaitingReply ? "text-slate-700" : "text-slate-500"}`}
                >
                  {lastMessagePreview(conversation)}
                </span>
                <span className="mt-1.5 flex items-center gap-2">
                  <span className="text-[11px] text-slate-400">{CHANNEL_LABELS[conversation.channel]}</span>
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
