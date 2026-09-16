import Link from "next/link";
import { cardClass } from "@/lib/ui/card";
import { contactDisplayName, contactInitials } from "@/lib/contacts/format";
import { formatRelativeTime } from "@/lib/dashboard/format";
import { CHANNEL_LABELS } from "@/lib/conversations/format";
import type { ConversationWithLastMessage } from "@/lib/conversations/queries";
import { ConversationStatusBadge } from "./status-badge";

function lastMessagePreview(conversation: ConversationWithLastMessage): string {
  if (!conversation.lastMessage) return "No messages yet";
  const body = conversation.lastMessage.body.trim();
  return body.length > 80 ? `${body.slice(0, 80)}…` : body;
}

export function ConversationsList({
  conversations,
  hasActiveFilters,
}: {
  conversations: ConversationWithLastMessage[];
  hasActiveFilters: boolean;
}) {
  if (conversations.length === 0) {
    return (
      <div className={`${cardClass} px-5 py-12 text-center`}>
        <p className="text-sm font-medium text-slate-900">No conversations match your filters.</p>
        {hasActiveFilters ? (
          <p className="mt-1 text-sm text-slate-500">Try a different search term or clear your filters.</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cardClass}>
      <ul className="divide-y divide-slate-100">
        {conversations.map((conversation) => {
          const name = conversation.contact ? contactDisplayName(conversation.contact) : "No contact";

          return (
            <li key={conversation.id}>
              <Link
                href={`/conversations/${conversation.id}`}
                className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-slate-50 sm:px-5"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
                  {conversation.contact ? contactInitials(conversation.contact) : "?"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-900">{name}</span>
                    <span className="shrink-0 text-xs text-slate-400">
                      {formatRelativeTime(conversation.lastActivityAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className="truncate text-xs text-slate-500">{lastMessagePreview(conversation)}</span>
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      {CHANNEL_LABELS[conversation.channel]}
                    </span>
                    <ConversationStatusBadge status={conversation.status} />
                    {conversation.ai_enabled ? (
                      <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                        AI Enabled
                      </span>
                    ) : null}
                    {conversation.lead?.service ? (
                      <span className="truncate text-[11px] text-slate-400">{conversation.lead.service}</span>
                    ) : null}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
