"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useSelectedLayoutSegment } from "next/navigation";
import {
  filterConversations,
  type ConversationChannel,
  type ConversationStatus,
  type ConversationSummary,
  type ConversationWithLastMessage,
} from "@/lib/conversations/queries";
import { PageHeader } from "@/lib/ui/page-header";
import { ConversationsList } from "./conversations-list";
import { ConversationsSummary } from "./conversations-summary";
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
  summary,
  children,
}: {
  conversations: ConversationWithLastMessage[];
  summary: ConversationSummary;
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
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Release-audit fix: on mobile, viewing a single conversation used to
          still render the full "Conversations" title/description and the
          4-stat overview row above the thread - list-level chrome that
          doesn't apply once you're inside a specific conversation. Verified
          via mobile browser testing that this left the actual scrollable
          message thread only ~80px tall (everything else - mobile nav, top
          bar, this header, the composer, the details disclosure - ate the
          rest of the viewport), so the last message rendered almost
          entirely clipped above the conversation's own header. Hidden here
          on the same activeId signal the list pane below already uses;
          list and thread (and so this header) are always both visible at
          the lg breakpoint and above. */}
      <div className={activeId ? "hidden lg:block" : "block"}>
        <PageHeader title="Conversations" description="Every customer conversation in one place, organized by activity." />
        <div className="mt-6">
          <ConversationsSummary summary={summary} />
        </div>
      </div>

      <div className="mt-6 min-h-0 flex-1 border-t border-slate-200">
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
      </div>
    </div>
  );
}
