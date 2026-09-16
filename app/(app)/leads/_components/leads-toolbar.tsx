"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { inputClass } from "@/lib/ui/form";
import { LEAD_STATUSES, LEAD_TEMPERATURES } from "@/lib/leads/queries";
import { Icon } from "../../_components/icon";

export function LeadsToolbar({
  initialQuery,
  initialStatus,
  initialTemperature,
}: {
  initialQuery: string;
  initialStatus: string;
  initialTemperature: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState(initialStatus);
  const [temperature, setTemperature] = useState(initialTemperature);
  const router = useRouter();
  const pathname = usePathname();

  function navigate(nextQuery: string, nextStatus: string, nextTemperature: string) {
    const params = new URLSearchParams();
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextStatus !== "all") params.set("status", nextStatus);
    if (nextTemperature !== "all") params.set("temperature", nextTemperature);
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }

  useEffect(() => {
    const handle = setTimeout(() => navigate(query, status, temperature), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function handleStatusChange(value: string) {
    setStatus(value);
    navigate(query, value, temperature);
  }

  function handleTemperatureChange(value: string) {
    setTemperature(value);
    navigate(query, status, value);
  }

  const hasActiveFilters = Boolean(query.trim()) || status !== "all" || temperature !== "all";

  function clearAll() {
    setQuery("");
    setStatus("all");
    setTemperature("all");
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
          placeholder="Search by name, phone, email, company, service…"
          aria-label="Search leads"
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
