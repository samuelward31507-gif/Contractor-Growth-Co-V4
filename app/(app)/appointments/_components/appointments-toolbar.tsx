"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { inputClass } from "@/lib/ui/form";
import { APPOINTMENT_STATUSES, type AppointmentView } from "@/lib/appointments/queries";

const VIEWS: { value: AppointmentView; label: string }[] = [
  { value: "upcoming", label: "Upcoming" },
  { value: "today", label: "Today" },
  { value: "past", label: "Past" },
];

export function AppointmentsToolbar({
  initialQuery,
  initialStatus,
  view,
  todayCount,
}: {
  initialQuery: string;
  initialStatus: string;
  view: AppointmentView;
  /** Real, already-computed count (AppointmentSummary.today) - surfaced on
   *  the tab itself so a full day doesn't get buried behind a click when
   *  "Upcoming" is the default view. */
  todayCount?: number;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState(initialStatus);
  const router = useRouter();
  const pathname = usePathname();

  function navigate(nextQuery: string, nextStatus: string, nextView: AppointmentView) {
    const params = new URLSearchParams();
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextStatus !== "all") params.set("status", nextStatus);
    if (nextView !== "upcoming") params.set("view", nextView);
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }

  useEffect(() => {
    const handle = setTimeout(() => navigate(query, status, view), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function handleStatusChange(value: string) {
    setStatus(value);
    navigate(query, value, view);
  }

  function handleViewChange(value: AppointmentView) {
    navigate(query, status, value);
  }

  const hasActiveFilters = Boolean(query.trim()) || status !== "all";

  function clearFilters() {
    setQuery("");
    setStatus("all");
    navigate("", "all", view);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 sm:w-fit">
        {VIEWS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={view === item.value}
            onClick={() => handleViewChange(item.value)}
            className={`flex-1 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:flex-none ${
              view === item.value
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-900"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              {item.label}
              {item.value === "today" && todayCount ? (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-slate-900 px-1 text-[10px] font-semibold text-white">
                  {todayCount}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative flex-1 sm:max-w-sm">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, phone, email, company, title…"
            aria-label="Search appointments"
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
          {APPOINTMENT_STATUSES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>

        {hasActiveFilters ? (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );
}
