"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { inputClass } from "@/lib/ui/form";
import type { AgencyClientFilter } from "../page";

const FILTER_OPTIONS: { value: AgencyClientFilter; label: string }[] = [
  { value: "all", label: "All clients" },
  { value: "attention", label: "Needs attention" },
  { value: "live", label: "Live" },
  { value: "onboarding", label: "Onboarding" },
];

/**
 * Agency Command Center 2.0, Sections 7-8 - agency-wide search and status
 * filtering, mirroring app/(app)/leads/_components/leads-toolbar.tsx's own
 * debounced-search + URL-searchParams pattern exactly (the codebase's
 * established search idiom) rather than introducing a second one. Search is
 * deliberately scoped to client organization name only - the already-
 * fetched, already-authorized data this page renders - not a new cross-
 * client lead/contact search index.
 */
export function AgencyToolbar({ initialQuery, initialFilter }: { initialQuery: string; initialFilter: AgencyClientFilter }) {
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<AgencyClientFilter>(initialFilter);
  const router = useRouter();
  const pathname = usePathname();

  function navigate(nextQuery: string, nextFilter: AgencyClientFilter) {
    const params = new URLSearchParams();
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextFilter !== "all") params.set("filter", nextFilter);
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }

  useEffect(() => {
    const handle = setTimeout(() => navigate(query, filter), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function handleFilterChange(value: AgencyClientFilter) {
    setFilter(value);
    navigate(query, value);
  }

  const hasActiveFilters = Boolean(query.trim()) || filter !== "all";

  function clearAll() {
    setQuery("");
    setFilter("all");
    navigate("", "all");
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative flex-1 sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search clients…"
          aria-label="Search clients"
          className={`${inputClass} pl-9 ${query ? "pr-8" : ""}`}
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              navigate("", filter);
            }}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      <select
        value={filter}
        onChange={(event) => handleFilterChange(event.target.value as AgencyClientFilter)}
        aria-label="Filter clients"
        className={`${inputClass} sm:w-44`}
      >
        {FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {hasActiveFilters ? (
        <button type="button" onClick={clearAll} className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-900">
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
