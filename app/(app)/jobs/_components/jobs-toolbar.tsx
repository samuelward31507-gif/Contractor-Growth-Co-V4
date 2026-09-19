"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { inputClass } from "@/lib/ui/form";
import { JOB_STATUSES } from "@/lib/jobs/queries";
import { Icon } from "../../_components/icon";

export function JobsToolbar({
  initialQuery,
  initialStatus,
}: {
  initialQuery: string;
  initialStatus: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState(initialStatus);
  const router = useRouter();
  const pathname = usePathname();

  function navigate(nextQuery: string, nextStatus: string) {
    const params = new URLSearchParams();
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextStatus !== "all") params.set("status", nextStatus);
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }

  useEffect(() => {
    const handle = setTimeout(() => navigate(query, status), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function handleStatusChange(value: string) {
    setStatus(value);
    navigate(query, value);
  }

  const hasActiveFilters = Boolean(query.trim()) || status !== "all";

  function clearAll() {
    setQuery("");
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
          placeholder="Search by title, customer, company…"
          aria-label="Search jobs"
          className={`${inputClass} pl-9`}
        />
      </div>

      <select
        value={status}
        onChange={(event) => handleStatusChange(event.target.value)}
        aria-label="Filter by status"
        className={`${inputClass} sm:w-44`}
      >
        <option value="all">All statuses</option>
        {JOB_STATUSES.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>

      {hasActiveFilters ? (
        <button
          type="button"
          onClick={clearAll}
          className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
