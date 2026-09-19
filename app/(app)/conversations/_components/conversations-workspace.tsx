"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useSelectedLayoutSegment } from "next/navigation";
import {
  filterConversations,
  type ConversationChannel,
  type ConversationStatus,
  type ConversationWithLastMessage,
} from "@/lib/conversations/queries";
import { ConversationsList } from "./conversations-list";
import { ConversationsToolbar } from "./conversations-toolbar";

/**
 * The persistent list + active thread split. `useSelectedLayoutSegment`
 * reports the active [id] segment (or null on the bare /conversations
 * index) so this can highlight the active row and, on mobile, collapse to
 * list-only or thread-only - list and thread are always both visible at the
 * lg breakpoint and above.
 */
export function ConversationsWorkspace({
  conversations,
  children,
}: {
  conversations: ConversationWithLastMessage[];
  children: ReactNode;
}) {
  const activeId = useSelectedLayoutSegment();
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState<ConversationChannel | "all">("all");
  const [status, setStatus] = useState<ConversationStatus | "all">("all");

  const filtered = useMemo(
    () => filterConversations(conversations, { query, channel, status }),
    [conversations, query, channel, status],
  );
  const hasActiveFilters = Boolean(query.trim()) || channel !== "all" || status !== "all";

  return (
    <div className="flex h-full min-h-0">
      <div
        className={`min-h-0 flex-col overflow-hidden border-r border-slate-200 lg:flex lg:w-[340px] lg:shrink-0 ${
          activeId ? "hidden" : "flex w-full"
        }`}
      >
        <div className="shrink-0 py-4">
          <ConversationsToolbar
            query={query}
            onQueryChange={setQuery}
            channel={channel}
            onChannelChange={setChannel}
            status={status}
            onStatusChange={setStatus}
            hasActiveFilters={hasActiveFilters}
            onClear={() => {
              setQuery("");
              setChannel("all");
              setStatus("all");
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ConversationsList conversations={filtered} hasActiveFilters={hasActiveFilters} activeId={activeId} />
        </div>
      </div>

      <div className={`min-h-0 flex-1 flex-col lg:flex ${activeId ? "flex" : "hidden"}`}>{children}</div>
    </div>
  );
}
