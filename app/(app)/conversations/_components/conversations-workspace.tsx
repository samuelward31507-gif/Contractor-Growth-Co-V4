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
import { segmentedItemClass, segmentedTrackClass } from "@/lib/ui/segmented";
import type { ConversationOwnerView } from "@/lib/decisions/presentation";
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
  waitingConversationIds,
  ownerById,
  children,
}: {
  conversations: ConversationWithLastMessage[];
  summary: ConversationSummary;
  /** Phase 3 (W1): ids from the canonical waiting helper - a plain array, since a Set does not cross the server/client boundary. */
  waitingConversationIds: string[];
  /** Batch 3: who each conversation is with right now (presentConversationOwner), keyed by id. */
  ownerById: Record<string, ConversationOwnerView>;
  children: ReactNode;
}) {
  const waitingIds = useMemo(() => new Set(waitingConversationIds), [waitingConversationIds]);
  const activeId = useSelectedLayoutSegment();
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState<ConversationChannel | "all">("all");
  const [status, setStatus] = useState<ConversationStatus | "all">("all");

  // Batch 3: "Who needs me?" first - the Inbox opens on the conversations
  // waiting for the contractor's reply; "All" keeps every conversation,
  // with the ones that need you on top.
  const [inboxView, setInboxView] = useState<"needs-you" | "all">("needs-you");
  const needsYouCount = useMemo(() => conversations.filter((conversation) => ownerById[conversation.id]?.needsYou).length, [conversations, ownerById]);
  const filtered = useMemo(() => {
    const matching = filterConversations(conversations, { query, channel, status });
    if (inboxView === "needs-you") return matching.filter((conversation) => ownerById[conversation.id]?.needsYou);
    return [...matching].sort((a, b) => Number(Boolean(ownerById[b.id]?.needsYou)) - Number(Boolean(ownerById[a.id]?.needsYou)));
  }, [conversations, query, channel, status, inboxView, ownerById]);
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
          entirely clipped above the conversation's own header.
          Final visual polish pass: this now hides at every breakpoint, not
          just below `lg`, on the same activeId signal - list and thread stay
          exactly as visible as before (that split was never breakpoint-
          gated), but reading/replying to a real conversation on desktop no
          longer sits under ~300px of list-level header the active thread has
          no use for; the thread itself is the dominant surface once one is
          open, matching the workspace's own three-pane intent. */}
      <div className={activeId ? "hidden" : "block"}>
        <PageHeader eyebrow="Inbox" title="Inbox" description="Who needs you - and every conversation Trackpr is handling for you." />
        {/* Final visual acceptance pass: measured on a real small-phone
            viewport (390-530px), this summary block alone was over 300px
            tall, leaving the actual list+thread workspace below it only
            ~60px of the visible viewport before any scrolling - the list a
            contractor actually came to this page for was reduced to a
            sliver under its own header. The 4-stat overview is real,
            useful reference info, but it's exactly that: reference, not the
            task - it recedes below `lg` (where the workspace's own two-pane
            split already sits comfortably beside it) rather than starving
            the one thing every visit to this page needs room for. */}
        <div className="mt-6 hidden lg:block">
          <ConversationsSummary summary={summary} />
        </div>
      </div>

      {/* Theme upgrade: on desktop the list + thread sit in one white panel, anchored like a mail client, instead of floating on the canvas. */}
      <div className={`min-h-0 flex-1 border-t border-line lg:overflow-hidden lg:rounded-t-xl lg:border-x lg:bg-surface lg:shadow-card ${activeId ? "" : "mt-6"}`}>
        <div className="flex h-full min-h-0">
          <div
            className={`min-h-0 flex-col overflow-hidden border-r border-line lg:flex lg:w-[340px] lg:shrink-0 ${
              activeId ? "hidden" : "flex w-full"
            }`}
          >
            <div className="shrink-0 pt-4 lg:px-4">
              <div className={segmentedTrackClass} role="group" aria-label="Inbox view">
                {(
                  [
                    ["needs-you", `Needs you${needsYouCount > 0 ? ` (${needsYouCount})` : ""}`],
                    ["all", "All conversations"],
                  ] as const
                ).map(([value, label]) => (
                  <button key={value} type="button" aria-pressed={inboxView === value} onClick={() => setInboxView(value)} className={segmentedItemClass(inboxView === value)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="shrink-0 py-4 lg:px-4">
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
              <ConversationsList
                conversations={filtered}
                hasActiveFilters={hasActiveFilters}
                activeId={activeId}
                waitingIds={waitingIds}
                ownerById={ownerById}
                needsYouView={inboxView === "needs-you"}
                onShowAll={() => setInboxView("all")}
              />
            </div>
          </div>

          <div className={`min-h-0 flex-1 flex-col lg:flex ${activeId ? "flex" : "hidden"}`}>{children}</div>
        </div>
      </div>
    </div>
  );
}
