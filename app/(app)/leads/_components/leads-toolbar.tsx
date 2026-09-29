"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { hasSearchChanged } from "@/lib/ui/search-sync";
import { Search, X } from "lucide-react";
import { inputClass } from "@/lib/ui/form";
import { LEAD_STATUSES, LEAD_TEMPERATURES } from "@/lib/leads/queries";
import type { LeadSort } from "../page";
import { buildLeadsQueryString } from "./leads-toolbar-query";

const SORT_OPTIONS: { value: LeadSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "hot_first", label: "Hottest first" },
  { value: "value_desc", label: "Highest value" },
];

export function LeadsToolbar({
  initialQuery,
  initialStatus,
  initialTemperature,
  initialSort,
  from,
}: {
  initialQuery: string;
  initialStatus: string;
  initialTemperature: string;
  initialSort: LeadSort;
  /**
   * The dispatcher's own page-identity marker (see app/(app)/customers/
   * page.tsx - `from=lead` is what routes a request to this page instead
   * of ContactsPage). It is never user-editable here, only ever carried
   * forward - every navigate() below must include it, or a filter/search/
   * sort change silently drops the view back into the unfiltered Customers
   * list on the next render.
   */
  from?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  // The search text currently reflected in the URL - see lib/ui/search-sync.ts.
  const lastSyncedQuery = useRef(initialQuery.trim());
  const [status, setStatus] = useState(initialStatus);
  const [temperature, setTemperature] = useState(initialTemperature);
  const [sort, setSort] = useState<LeadSort>(initialSort);
  const router = useRouter();
  const pathname = usePathname();

  function navigate(nextQuery: string, nextStatus: string, nextTemperature: string, nextSort: LeadSort) {
    lastSyncedQuery.current = nextQuery.trim();
    const queryString = buildLeadsQueryString({ from, query: nextQuery, status: nextStatus, temperature: nextTemperature, sort: nextSort });
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }

  useEffect(() => {
    if (!hasSearchChanged(query, lastSyncedQuery.current)) return;
    const handle = setTimeout(() => navigate(query, status, temperature, sort), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function handleStatusChange(value: string) {
    setStatus(value);
    navigate(query, value, temperature, sort);
  }

  function handleTemperatureChange(value: string) {
    setTemperature(value);
    navigate(query, status, value, sort);
  }

  function handleSortChange(value: LeadSort) {
    setSort(value);
    navigate(query, status, temperature, value);
  }

  const hasActiveFilters = Boolean(query.trim()) || status !== "all" || temperature !== "all";

  function clearAll() {
    setQuery("");
    setStatus("all");
    setTemperature("all");
    navigate("", "all", "all", sort);
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative flex-1 sm:max-w-sm">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, phone, email, company, service…"
          aria-label="Search leads"
          className={`${inputClass} pl-9 ${query ? "pr-8" : ""}`}
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              navigate("", status, temperature, sort);
            }}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      <select
        value={status}
        onChange={(event) => handleStatusChange(event.target.value)}
        aria-label="Filter by status"
        className={`${inputClass} sm:w-44`}
      >
        <option value="all">All statuses</option>
        {LEAD_STATUSES.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>

      <select
        value={temperature}
        onChange={(event) => handleTemperatureChange(event.target.value)}
        aria-label="Filter by temperature"
        className={`${inputClass} sm:w-40`}
      >
        <option value="all">All temperatures</option>
        {LEAD_TEMPERATURES.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>

      <select
        value={sort}
        onChange={(event) => handleSortChange(event.target.value as LeadSort)}
        aria-label="Sort leads"
        className={`${inputClass} sm:w-44`}
      >
        {SORT_OPTIONS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>

      {hasActiveFilters ? (
        <button
          type="button"
          onClick={clearAll}
          className="rounded text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
