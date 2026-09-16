"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { inputClass } from "@/lib/ui/form";
import { ACTIVITY_ENTITY_TYPES } from "@/lib/activity/queries";
import { Icon } from "../../_components/icon";

export function ActivityToolbar({
  initialQuery,
  initialEntityType,
  initialFrom,
  initialTo,
}: {
  initialQuery: string;
  initialEntityType: string;
  initialFrom: string;
  initialTo: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [entityType, setEntityType] = useState(initialEntityType);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const router = useRouter();
  const pathname = usePathname();

  function navigate(nextQuery: string, nextEntityType: string, nextFrom: string, nextTo: string) {
    const params = new URLSearchParams();
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextEntityType !== "all") params.set("entityType", nextEntityType);
    if (nextFrom) params.set("from", nextFrom);
    if (nextTo) params.set("to", nextTo);
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }

  useEffect(() => {
    const handle = setTimeout(() => navigate(query, entityType, from, to), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function handleEntityTypeChange(value: string) {
    setEntityType(value);
    navigate(query, value, from, to);
  }

  function handleFromChange(value: string) {
    setFrom(value);
    navigate(query, entityType, value, to);
  }

  function handleToChange(value: string) {
    setTo(value);
    navigate(query, entityType, from, value);
  }

  const hasActiveFilters = Boolean(query.trim()) || entityType !== "all" || Boolean(from) || Boolean(to);

  function clearFilters() {
    setQuery("");
    setEntityType("all");
    setFrom("");
    setTo("");
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
          placeholder="Search by action or entity type…"
          aria-label="Search activity"
          className={`${inputClass} pl-9`}
        />
      </div>

      <select
        value={entityType}
        onChange={(event) => handleEntityTypeChange(event.target.value)}
        aria-label="Filter by entity type"
        className={`${inputClass} sm:w-40`}
      >
        <option value="all">All types</option>
        {ACTIVITY_ENTITY_TYPES.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-2">
        <input
          type="date"
          value={from}
          onChange={(event) => handleFromChange(event.target.value)}
          aria-label="From date"
          className={`${inputClass} sm:w-40`}
        />
        <span className="text-sm text-slate-400">to</span>
        <input
          type="date"
          value={to}
          onChange={(event) => handleToChange(event.target.value)}
          aria-label="To date"
          className={`${inputClass} sm:w-40`}
        />
      </div>

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
