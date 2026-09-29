"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { hasSearchChanged } from "@/lib/ui/search-sync";
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
  // The search text currently reflected in the URL - see lib/ui/search-sync.ts.
  const lastSyncedQuery = useRef(initialQuery.trim());
  const [status, setStatus] = useState(initialStatus);
  const router = useRouter();
  const pathname = usePathname();

  // Redesign pass bug fix: this toolbar is now only ever rendered through
  // the /schedule dispatcher (next.config.ts permanently redirects the
  // legacy /appointments route to /schedule?view=list - see its own header
  // comment), so `pathname` here is always "/schedule", where the URL key
  // "view" already belongs to the schedule-level day/week/month/list
  // selector. This function used to write its own Upcoming/Today/Past
  // selection to that same "view" key and never set "list" itself - the
  // very first debounced call (the mount-time effect below fires even with
  // no user interaction) silently overwrote "?view=list" with "?view=upcoming"
  // or a bare path, bouncing the page back to the Week calendar grid a
  // moment after landing on List. Fixed by always keeping "view=list" and
  // writing the appointments-internal selection under "apptView" instead -
  // the exact key SchedulePage's own dispatcher already reads back out for
  // this (see app/(app)/schedule/page.tsx).
  function navigate(nextQuery: string, nextStatus: string, nextView: AppointmentView) {
    lastSyncedQuery.current = nextQuery.trim();
    const params = new URLSearchParams();
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextStatus !== "all") params.set("status", nextStatus);
    params.set("view", "list");
    if (nextView !== "upcoming") params.set("apptView", nextView);
    router.replace(`${pathname}?${params.toString()}`);
  }

  useEffect(() => {
    if (!hasSearchChanged(query, lastSyncedQuery.current)) return;
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
      <div className="inline-flex gap-0.5 rounded-md bg-inset p-0.5">
        {VIEWS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={view === item.value}
            onClick={() => handleViewChange(item.value)}
            className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-[5px] px-3 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-7 sm:flex-none ${
              view === item.value
                ? "bg-surface text-ink shadow-[0_1px_2px_rgba(23,25,26,0.08)]"
                : "text-ink-3 hover:text-ink"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              {item.label}
              {item.value === "today" && todayCount ? (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-[11px] font-semibold tabular-nums text-white">
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
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
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
            className="inline-flex min-h-11 items-center rounded text-sm font-medium text-ink-3 transition-colors hover:text-ink sm:min-h-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );
}
