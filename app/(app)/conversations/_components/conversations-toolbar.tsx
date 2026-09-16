"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { inputClass } from "@/lib/ui/form";
import { CONVERSATION_CHANNELS, CONVERSATION_STATUSES } from "@/lib/conversations/queries";
import { Icon } from "../../_components/icon";

export function ConversationsToolbar({
  initialQuery,
  initialChannel,
  initialStatus,
}: {
  initialQuery: string;
  initialChannel: string;
  initialStatus: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [channel, setChannel] = useState(initialChannel);
  const [status, setStatus] = useState(initialStatus);
  const router = useRouter();
  const pathname = usePathname();

  function navigate(nextQuery: string, nextChannel: string, nextStatus: string) {
    const params = new URLSearchParams();
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextChannel !== "all") params.set("channel", nextChannel);
    if (nextStatus !== "all") params.set("status", nextStatus);
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }

  useEffect(() => {
    const handle = setTimeout(() => navigate(query, channel, status), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function handleChannelChange(value: string) {
    setChannel(value);
    navigate(query, value, status);
  }

  function handleStatusChange(value: string) {
    setStatus(value);
    navigate(query, channel, value);
  }

  const hasActiveFilters = Boolean(query.trim()) || channel !== "all" || status !== "all";

  function clearFilters() {
    setQuery("");
    setChannel("all");
    setStatus("all");
    router.replace(pathname);
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative flex-1 sm:max-w-sm">
        <Icon
          name="search"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, phone, email, company…"
          aria-label="Search conversations"
          className={`${inputClass} pl-9`}
        />
      </div>

      <select
        value={channel}
        onChange={(event) => handleChannelChange(event.target.value)}
        aria-label="Filter by channel"
        className={`${inputClass} sm:w-36`}
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
        onChange={(event) => handleStatusChange(event.target.value)}
        aria-label="Filter by status"
        className={`${inputClass} sm:w-36`}
      >
        <option value="all">All statuses</option>
        {CONVERSATION_STATUSES.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>

      {hasActiveFilters ? (
        <button
          type="button"
          onClick={clearFilters}
          className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
