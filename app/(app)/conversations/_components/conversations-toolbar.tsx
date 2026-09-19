"use client";

import { Search } from "lucide-react";
import { inputClass } from "@/lib/ui/form";
import { CONVERSATION_CHANNELS, CONVERSATION_STATUSES, type ConversationChannel, type ConversationStatus } from "@/lib/conversations/queries";

/**
 * Controlled by ConversationsWorkspace's local state rather than URL params -
 * this panel is now a persistent part of a split-pane workspace (not a full
 * page reload per filter change), so client-side state is the correct
 * mechanism here, not a routing concern.
 */
export function ConversationsToolbar({
  query,
  onQueryChange,
  channel,
  onChannelChange,
  status,
  onStatusChange,
  hasActiveFilters,
  onClear,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  channel: ConversationChannel | "all";
  onChannelChange: (value: ConversationChannel | "all") => void;
  status: ConversationStatus | "all";
  onStatusChange: (value: ConversationStatus | "all") => void;
  hasActiveFilters: boolean;
  onClear: () => void;
}) {
  return (
    <div className="space-y-2 px-3">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search conversations…"
          aria-label="Search conversations"
          className={`${inputClass} pl-9`}
        />
      </div>

      <div className="flex items-center gap-2">
        <select
          value={channel}
          onChange={(event) => onChannelChange(event.target.value as ConversationChannel | "all")}
          aria-label="Filter by channel"
          className={`${inputClass} flex-1`}
        >
          <option value="all">All channels</option>
          {CONVERSATION_CHANNELS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>

        <select
          value={status}
          onChange={(event) => onStatusChange(event.target.value as ConversationStatus | "all")}
          aria-label="Filter by status"
          className={`${inputClass} flex-1`}
        >
          <option value="all">All statuses</option>
          {CONVERSATION_STATUSES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      {hasActiveFilters ? (
        <button
          type="button"
          onClick={onClear}
          className="text-xs font-medium text-slate-500 transition-colors hover:text-slate-900"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
